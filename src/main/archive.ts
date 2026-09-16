import {
  ARCHIVE_MAX_ATTEMPTS,
  ARCHIVE_SUMMARY_MAX,
  type ArchivedSession,
  type StoredMessage,
  type StoredSession
} from '../shared/types'
import { redactSecrets } from '../shared/secret-scan'
import { atomicWriteFile, withLock } from './atomic-file'
import {
  archiveBodyFile,
  listArchive,
  loadArchive,
  readArchiveBody,
  readArchiveFromDisk,
  saveArchive
} from './archive-index'
import { getConfig, setConfig } from './config'
import { callModelOnce } from './llm'
import { recordUsage } from './usage'
import { sessionSystemPrompt } from './system-doc'
import { toolSchemasForModel } from './tools'
import { logger } from './logger'

export { listArchive }

/**
 * 会话归档与总结。
 *
 * ## 归档是什么意思
 *
 * 一条会话有三种命运：继续用、删掉、归档。
 * **归档 = 明确宣布「这段结束了，可以总结了」**。
 *
 * 只有归档过的会话才会：
 *   - 被 AI 生成一段梗概
 *   - 进入 AI 可检索的范围（它会话记录工具能翻到）
 *
 * 没归档的会话**一概不处理**。理由有两条：
 *   1. 用户可能只是切出去倒杯水，回来接着问 —— 那总结就是白花钱
 *   2. 总结一份还在增长的记录，必然要重做，而重做意味着重复付费
 * 这个「显式宣布结束」的动作把判断权交给用户，比任何自动启发式都准。
 *
 * ## 为什么归档后**立刻**总结（而不是攒着批量做）
 *
 * 这里有一个真实的省钱机制，用户的直觉是对的：
 *
 * prompt 缓存按「最长公共前缀」算。归档发生在一段对话刚结束之后，
 * 而总结请求的消息是 `[system prompt, ...这段对话的全部消息, 一句「请总结」]`——
 * **前面那一整段与刚才最后一次请求完全相同**。所以：
 *   - 服务商侧还热着的缓存被直接命中，那几千 token 按十分之一计价
 *   - 攒到明天再批量总结，缓存早过期了，同样的内容要按全价再买一次
 *
 * 两个前提必须同时满足，代码里对应两处处理：
 *   1. **system prompt 要与对话时一致** → 用 sessionSystemPrompt() 的同一个快照
 *   2. **tools 字段要一起发** → 服务商把 tools 排在消息之前，
 *      少发 tools 会让整个前缀错位、缓存全丢（见 summarize 的注释）
 *
 * 代价是「多花几百 token 的输出」。相对省下的输入，这笔账是划算的。
 *
 * ## 总结失败怎么办
 *
 * 计数 `attempts`，到 ARCHIVE_MAX_ATTEMPTS 就停止自动重试。
 * 没有这个上限的话，一条必然失败的会话（比如归档后用户把 API Key 删了）
 * 会在每次启动时重试一次，用户只会看到「启动时莫名卡一下」。
 */

const readBody = readArchiveBody

/** 把归档状态写回会话正文，这样换台机器 / 清了 config.json 也还在 */
async function markBody(id: string, patch: Partial<StoredSession>): Promise<void> {
  const body = await readBody(id)
  if (!body) return
  try {
    await atomicWriteFile(archiveBodyFile(id), JSON.stringify({ ...body, ...patch }))
  } catch (err) {
    logger.warn('archive', `回写会话正文失败 ${id}: ${String(err)}`)
  }
}

/**
 * 同步 config.json 里 recentSessions 的 archived 标记。
 *
 * 这个标记只用于**左侧列表的显示**（已归档的行有个淡标记），
 * 所以它丢了也不会导致功能不可用 —— 真正的依据在正文文件与 archive.json。
 * 因此这里只做最简单的事：重建整个列表，而不是想办法原地改。
 *
 * 取消归档时用解构把 `archived` 整个删掉，而不是设成 false：
 * normalizeSessions 只认 true，留一个 false 在 config.json 里
 * 每次保存都多一个无用字段，看着像有状态其实没有。
 */
function syncEntryFlag(id: string, archived: boolean): void {
  const next = getConfig().recentSessions.map((item) => {
    if (item.id !== id) return item
    if (!archived) {
      const { archived: _drop, ...rest } = item
      return rest
    }
    return { ...item, archived: true }
  })
  setConfig({ recentSessions: next })
}

/* ------------------------------------------------------------------ *
 * 归档 / 取消归档
 * ------------------------------------------------------------------ */

export interface ArchiveOutcome {
  ok: boolean
  message: string
  entry?: ArchivedSession
}

/**
 * 归档一条会话。
 *
 * 顺序很重要：**先把状态落盘，再触发总结**。
 * 反过来的话，总结过程中用户关了应用，就会出现
 * 「界面上归档了、索引里没有」的分裂状态，而且下次启动补不回来
 * （因为不知道它该被归档）。
 */
export async function archiveSession(
  id: string,
  workspace: string,
  messageCount: number
): Promise<ArchiveOutcome> {
  /*
   * 拿锁做「读—改—写」。
   *
   * 光有原子写不够：两个并发归档各自读完索引、各自改、各自写，
   * 后写的会覆盖前一次加的条目（它读的是旧索引），结果是
   * 「用户点了归档，界面上说成功了，重启后那条不见了」。
   * 原子写只保证文件不半截，不保证改动不丢 —— 两件事都得做。
   * 详见 atomic-file.ts 的 withLock。
   */
  const added = await withLock('archive-index', async () => {
    const current = await readArchiveFromDisk()
    if (current.some((item) => item.id === id)) return null

    const body = await readBody(id)
    const title =
      body?.title || getConfig().recentSessions.find((item) => item.id === id)?.title || '（未命名会话）'

    const entry: ArchivedSession = {
      id,
      title,
      summary: '',
      archivedAt: new Date().toISOString(),
      workspace: workspace || body?.workspace || '',
      messageCount: messageCount || body?.messages.length || 0
    }
    const next = [entry, ...current]
    await saveArchive(next)
    return entry
  })

  if (!added) {
    // 锁内重查发现已经归档过（并发或者重复点击）
    const existing = (await loadArchive()).find((item) => item.id === id)
    return { ok: true, message: '这条会话已经归档过了。', entry: existing }
  }

  await markBody(id, { archivedAt: added.archivedAt })
  syncEntryFlag(id, true)
  logger.info('archive', `已归档会话 ${id}（${added.messageCount} 条消息），开始总结`)

  /*
   * 立刻总结，不 await。
   *
   * 不 await 是为了让界面上的「归档」按钮立刻有反馈 ——
   * 一次总结要几秒到几十秒，让用户对着转圈的按钮等是不必要的。
   * 索引已经落盘了，所以即使这会儿应用被关掉，
   * 下次启动的「补做」扫描也会把它捡起来。
   */
  void summarizePending().catch((err) => {
    logger.warn('archive', `后台总结异常: ${String(err)}`)
  })

  return { ok: true, message: '已归档，正在生成梗概。', entry: added }
}

/** 取消归档：撤掉总结，从索引里删掉 */
export async function unarchiveSession(id: string): Promise<ArchiveOutcome> {
  const removed = await withLock('archive-index', async () => {
    const current = await readArchiveFromDisk()
    if (!current.some((item) => item.id === id)) return false
    await saveArchive(current.filter((item) => item.id !== id))
    return true
  })
  if (!removed) return { ok: false, message: '这条会话不在归档里。' }

  await markBody(id, { archivedAt: '', summary: '' })
  syncEntryFlag(id, false)
  logger.info('archive', `已取消归档 ${id}`)
  return { ok: true, message: '已取消归档，梗概已删除。' }
}

/* ------------------------------------------------------------------ *
 * 总结
 * ------------------------------------------------------------------ */

/**
 * 总结用的提示词。
 *
 * 三条要求各自对应一个具体的失败模式：
 *   - 「不要逐条复述」→ 模型很爱把对话改写成流水账，那种总结检索时没用
 *   - 「写明结论与未解决」→ 后半句最容易被漏，而它恰恰是下一次最需要的
 *   - 「不要编造」→ 模型会为了总结得漂亮而补上对话里没有的结论
 *
 * 字数上限与 ARCHIVE_SUMMARY_MAX 对应，写在提示词里比事后截断好：
 * 事后截断会把最后那句结论切掉。
 */
const SUMMARY_INSTRUCTION =
  '请把上面这段对话总结成一段话，用于以后检索「我们当时讨论过什么」。要求：\n' +
  '1. 直接输出总结正文，不要任何前缀（不要写「总结：」「这段对话」）。\n' +
  `2. 说清三件事：讨论的是什么问题、最后得到的结论或做法、还有什么没解决。\n` +
  `3. 不要逐条复述对话过程，不要罗列每一轮说了什么。\n` +
  `4. 只用对话里出现过的事实，不要补充你的推测。\n` +
  `5. 控制在 ${ARCHIVE_SUMMARY_MAX} 字以内。`

/**
 * 把会话消息压成总结请求的输入。
 *
 * ## 为什么原样带上全部消息（而不是压缩后再发）
 *
 * 这正是省钱的关键：原样带上，前面的部分才与刚才最后一次对话请求
 * 逐字节相同，缓存才会命中。为了「少发点 token」而先做一次摘要再总结，
 * 等于先付一次全价、再付一次总结的钱，反而更贵。
 *
 * ## 长会话的例外
 *
 * 超过 MAX_SUMMARY_MESSAGES 条的对话，全带上会超出上下文窗口
 * （总结请求失败，用户什么也得不到）。这时只能退回「取头取尾」：
 * 开头（问题是什么）+ 结尾（结论是什么）是总结最需要的两部分。
 * 这种情况下缓存基本不可能命中，但至少不会失败。
 */
const MAX_SUMMARY_MESSAGES = 120

function buildSummaryMessages(body: StoredSession): Array<{ role: 'user' | 'assistant'; content: string }> {
  const messages = body.messages.filter((m): m is StoredMessage => Boolean(m && typeof m.text === 'string'))
  const usable =
    messages.length <= MAX_SUMMARY_MESSAGES
      ? messages
      : [...messages.slice(0, 20), ...messages.slice(messages.length - (MAX_SUMMARY_MESSAGES - 20))]

  return usable
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .map((m) => ({
      role: m.role as 'user' | 'assistant',
      /*
       * 单条消息也脱一下敏。
       *
       * 会话正文里可能躺着用户粘过的密钥，而总结的产物（梗概）
       * 会被长期保留、并且以后会被 AI 读到。让密钥从梗概这条侧路
       * 溜进长期存储，比它原来在会话文件里更糟。
       * 这里用脱敏而不是拒绝：拒绝整段总结等于让用户什么也得不到。
       */
      content: redactSecrets(m.text).text
    }))
}

/**
 * 总结一条归档会话。
 *
 * 返回值只用于日志 —— 调用方是后台任务，没有人在等结果。
 */
async function summarize(entry: ArchivedSession): Promise<{ ok: boolean; text: string }> {
  const body = await readBody(entry.id)
  if (!body || body.messages.length === 0) {
    return { ok: false, text: '会话正文不存在或为空，无法总结。' }
  }

  const prefix = buildSummaryMessages(body)
  if (prefix.length === 0) return { ok: false, text: '会话里没有可总结的对话内容。' }

  /*
   * system prompt 用与对话时**同一个快照**。
   *
   * 这是缓存命中的前提之一。如果这里现取一份新的（比如重新读设置），
   * 用户恰好在这中间改过任何设置，前缀就错位了，缓存全丢。
   * sessionSystemPrompt() 返回的正是对话期间用过的那份。
   */
  const system = await sessionSystemPrompt()
  const tools = toolSchemasForModel()

  const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = []
  if (system) messages.push({ role: 'system', content: system })
  messages.push(...prefix, { role: 'user', content: SUMMARY_INSTRUCTION })

  /*
   * 带上 tools，虽然我们并不想让它调工具。
   *
   * 服务商侧把工具定义排在消息**之前**，所以少发 tools 会让
   * 后面所有消息的位置都变了，缓存完全无法命中 ——
   * 而带上它只是多几百 token，且那部分命中缓存后几乎免费。
   *
   * 代价是模型有可能真的去调工具（它见过这些工具，而指令里
   * 又要求它做事）。所以下面处理了「返回空正文」的情况：
   * 那就是它想调工具，这时**去掉 tools 再试一次**。
   * 第二次必然不命中缓存，但至少能拿到结果 —— 正确性优先于省钱。
   */
  const first = await callModelOnce({
    messages,
    tools: tools.length > 0 ? tools : undefined,
    temperature: 0.2,
    maxTokens: 800
  })

  if (first.usage.source === 'api' || first.usage.promptTokens > 0) {
    recordUsage({
      model: getConfig().ai.model,
      promptTokens: first.usage.promptTokens,
      completionTokens: first.usage.completionTokens,
      cachedTokens: first.usage.cachedTokens,
      estimated: false
    })
  }

  if (first.ok && first.text.trim()) {
    return { ok: true, text: first.text.trim() }
  }

  // 模型想调工具（正文为空）或带 tools 的请求失败 —— 去掉 tools 重来一次
  if (first.ok && !first.text.trim() && tools.length > 0) {
    logger.info('archive', `总结时模型试图调用工具（${entry.id}），去掉 tools 重试`)
    const second = await callModelOnce({
      messages,
      temperature: 0.2,
      maxTokens: 800
    })
    if (second.usage.promptTokens > 0) {
      recordUsage({
        model: getConfig().ai.model,
        promptTokens: second.usage.promptTokens,
        completionTokens: second.usage.completionTokens,
        cachedTokens: second.usage.cachedTokens,
        estimated: false
      })
    }
    if (second.ok && second.text.trim()) return { ok: true, text: second.text.trim() }
    return { ok: false, text: second.error || '模型没有返回可用的总结。' }
  }

  return { ok: false, text: first.error || '模型没有返回可用的总结。' }
}

/**
 * 处理所有待总结的归档会话。
 *
 * 两个触发点：
 *   1. 刚归档完（立即，为了吃上缓存）
 *   2. 应用启动时补做上次没做完的
 *
 * ## 为什么启动时限制条数
 *
 * 补做是**串行**的（一次一条），每条要几秒。如果攒了十条，
 * 启动后的头一分钟都在发请求 —— 用户会觉得「这软件一开机就卡」。
 * 每次最多两条，剩下的下次启动继续，几天内自然清空。
 *
 * ## 并发保护
 *
 * `running` 标记防止两条路径同时进行（归档的瞬间正好在启动补做）。
 * 同时总结同一条会话不只是浪费钱，还可能写两遍梗概、
 * 后写的覆盖先写的 —— 而两份内容不一定一样。
 *
 * 但**不能简单地把后来的请求丢掉**：用户刚点完「归档」，
 * 如果正好撞上启动补做，丢掉就意味着「要等下次启动才会总结」——
 * 而那一刻正是缓存最热、最该立刻总结的时候（那才是省钱的关键）。
 *
 * 所以用一个「还有活要干」的标记：正在跑的时候后来的请求只是打个标记，
 * 当前这轮结束后立刻再跑一轮。这样既不会并发，也不会漏掉。
 */
let running = false
/** 有人在这个标记期间又提了需求，本轮结束后要再跑一轮 */
let rerunRequested = false

export async function summarizePending(limit = 2): Promise<number> {
  if (running) {
    rerunRequested = true
    logger.debug('archive', '总结任务已在运行，已排队等本轮结束后重跑')
    return 0
  }
  if (configMissing()) return 0

  running = true
  let done = 0
  try {
    /*
     * 外层循环处理「排队重跑」。
     *
     * 刻意不加次数上限、但每次最多处理 limit 条：能重跑的来源只有
     * 「用户又归档了一条」，而这是人点出来的动作，不可能在一秒里
     * 出现几十次。真出现了（脚本猛点）也只是多跑几轮，
     * 每轮都有界，不会失控。
     */
    do {
      rerunRequested = false
      done += await runOneBatch(limit)
    } while (rerunRequested)
  } catch (err) {
    logger.warn('archive', `总结流程异常: ${String(err)}`)
  } finally {
    running = false
  }
  return done
}

/** 跑一轮总结。返回成功生成梗概的条数 */
async function runOneBatch(limit: number): Promise<number> {
  let done = 0
  const list = await loadArchive()
  const pending = list.filter((item) => !item.summary && (item.attempts || 0) < ARCHIVE_MAX_ATTEMPTS)
  if (pending.length === 0) return 0

  logger.info(
    'archive',
    `有 ${pending.length} 条归档会话待总结，本次处理 ${Math.min(limit, pending.length)} 条`
  )

  for (const queued of pending.slice(0, limit)) {
    // 每条都重新读一遍索引：上一条的写入、或者用户的新动作可能改了它
    const current = (await loadArchive()).find((item) => item.id === queued.id)
    if (!current || current.summary) continue

    const result = await summarize(current)
    const summary = result.ok ? result.text.slice(0, ARCHIVE_SUMMARY_MAX) : ''
    const attempts = result.ok ? 0 : (current.attempts || 0) + 1

    /*
     * 写回索引也要拿锁。
     *
     * 总结是慢操作（几秒），期间用户完全可能归档/取消归档别的会话。
     * 不锁的话，这里的「读→改→写」会把它一起覆盖掉 ——
     * 用户点了取消归档，界面也说取消了，重启后又回来了。
     */
    await withLock('archive-index', async () => {
      const fresh = await readArchiveFromDisk()
      const next = fresh.map((item) =>
        item.id === current.id
          ? { ...item, ...(summary ? { summary } : {}), attempts }
          : item
      )
      await saveArchive(next)
    })

    if (result.ok) {
      await markBody(current.id, { summary })
      logger.info('archive', `已生成梗概 ${current.id}：${summary.slice(0, 60)}…`)
      done++
    } else {
      logger.warn(
        'archive',
        `总结失败 ${current.id}（第 ${attempts}/${ARCHIVE_MAX_ATTEMPTS} 次）: ${result.text}`
      )
      if (attempts >= ARCHIVE_MAX_ATTEMPTS) {
        logger.warn('archive', `${current.id} 总结连续失败 ${attempts} 次，停止自动重试`)
      }
    }
  }
  return done
}

/** 配置不全时不要排队 —— 那只会攒一堆必然失败的尝试次数 */
function configMissing(): boolean {
  const ai = getConfig().ai
  return !ai.baseUrl.trim() || !ai.apiKey.trim() || !ai.model.trim()
}

