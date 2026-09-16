import { readMemory, writeMemory } from '../memory'
/*
 * ⚠️ 从 `archive-index` 而不是 `archive` 取归档索引。
 *
 * `archive.ts`（归档 + 总结）会 import `tools/index.ts` 去拿工具表
 * 来发总结请求，而工具表又包含本文件 —— 从 `archive` 取就会形成
 * `archive → tools → session-tools → archive` 的循环。
 * `archive-index.ts` 是只有存储的叶子模块，不依赖工具层，环就断在这里。
 * 详见 archive-index.ts 顶部的说明。
 */
import { listArchive, loadArchive, readArchiveBody } from '../archive-index'
import { redactSecrets } from '../../shared/secret-scan'
import { SESSION_MESSAGE_CHARS_MAX } from '../../shared/types'

/**
 * 「AI 查资料」类工具：翻历史会话、读写长期记忆。
 *
 * ## 为什么这些能力做成工具而不是塞进 system prompt
 *
 * 这是整个设计里最要紧的一条，也是与「设置改了缓存失效无所谓」的区别所在。
 *
 * prompt 缓存按最长公共前缀算。如果把「有哪些历史会话」「记忆里写了什么」
 * 拼进 system prompt：
 *   - 用户刚归档一条会话 → 列表变了 → 从 system prompt 那一行往后**全部**重算
 *   - AI 刚写了一条记忆 → 下次请求又全变
 * 一次长对话要发十几次请求，每次都在最前面变，缓存等于完全没有。
 *
 * 做成工具之后，这些内容出现在对话的**末尾**（工具调用与返回值），
 * 前面稳定的 system prompt + 历史消息照样命中缓存。
 * 代价是 AI 要多花一轮去查 —— 但它只在真的需要时才查，
 * 而塞进 prompt 是每一轮都付钱。
 *
 * ## 会话工具为什么只看归档
 *
 * 「未归档」语义上是「还在进行中」。让 AI 去读用户正在写的对话
 * 既没意义（那内容本来就在上下文里），也会让「有什么可查」变得不可预期
 * （同一时刻列表在变）。归档是用户明确划下的分界线，以它为界最清楚。
 */

/** 一次返回多少条会话索引。索引很窄（标题 + 梗概），给多些也不贵 */
const INDEX_LIMIT = 50
/** 读正文时的默认与最大行数 */
const READ_DEFAULT_LINES = 120
const READ_MAX_LINES = 400

interface ListSessionsArgs {
  /** 只列标题里含这个词的会话 */
  keyword?: string
  limit?: number
}

/**
 * 列归档会话的索引。
 *
 * 刻意**不含正文**：一次列出几十条会话的全文能轻松吃掉几万 token，
 * 而 AI 多数时候只需要知道「有没有相关的」。
 * 想看内容就再用 readSession 精确读一条 —— 工具说明里写清了这一点。
 */
async function listSessionsTool(args: ListSessionsArgs): Promise<string> {
  const all = await listArchive()
  if (all.length === 0) {
    return (
      '还没有任何归档会话。\n' +
      '（归档是用户主动做的动作：把一段对话标记为「结束了、可以总结了」。' +
      '没归档的会话不在这里，也不需要去翻。）'
    )
  }

  const keyword = (args.keyword || '').trim()
  const limit = Math.max(1, Math.min(INDEX_LIMIT, Math.floor(Number(args.limit) || INDEX_LIMIT)))

  const matched = keyword
    ? all.filter(
        (item) =>
          item.title.includes(keyword) ||
          item.summary.includes(keyword) ||
          item.workspace.includes(keyword)
      )
    : all

  if (matched.length === 0) {
    return `没有找到与「${keyword}」相关的归档会话。当前共归档 ${all.length} 条。`
  }

  const lines = matched.slice(0, limit).map((item) => {
    const when = item.archivedAt ? item.archivedAt.slice(0, 10) : '日期未知'
    const summary = item.summary
      ? item.summary.replace(/\s+/g, ' ').trim()
      : item.attempts && item.attempts > 0
        ? '（梗概生成失败）'
        : '（梗概还在生成中）'
    const project = item.workspace ? ` · ${baseName(item.workspace)}` : ''
    return `- [${when}${project}] ${item.title}\n  id: ${item.id}\n  ${summary}`
  })

  const head =
    matched.length > limit
      ? `共 ${matched.length} 条匹配，下面是最近的 ${limit} 条：`
      : `共 ${matched.length} 条：`

  return (
    `${head}\n${lines.join('\n')}\n\n` +
    '（这些是梗概，不是原文。需要看某一条的完整内容时用 readSession 传它的 id。）'
  )
}

interface ReadSessionArgs {
  id: string
  /** 从第几行开始读（从 1 开始） */
  offset?: number
  limit?: number
}

/**
 * 读一条归档会话的正文。
 *
 * ## 两条约束
 *
 * 1. **分行返回**，并且明确告诉 AI 读到的是哪一段。
 *    一个会话可能有几万字的正文，一次全塞进上下文既有撑爆窗口的风险，
 *    也会让有用的内容被稀释。分行 + offset/limit 让 AI 自己决定读多少。
 *
 * 2. **返回前脱敏**。会话正文里可能躺着用户粘过的密钥，
 *    这份内容会重新进上下文、被发到中转站。读的时候过滤一次，
 *    是这条路上唯一能兜住「用户自己粘进来的」的关口。
 */
async function readSessionTool(args: ReadSessionArgs): Promise<string> {
  const id = (args.id || '').trim()
  if (!id) throw new Error('需要给出会话 id。先用 listSessions 查。')

  const archive = await loadArchive()
  const entry = archive.find((item) => item.id === id)
  if (!entry) {
    throw new Error(
      `没有 id 为 ${id} 的归档会话。只有归档过的会话能读 —— ` +
        '先用 listSessions 看看有哪些（也可以按关键词搜）。'
    )
  }

  const body = await readBody(id)
  if (!body) {
    throw new Error(`会话 ${id} 的正文文件不存在或读不出来（可能已被删除）。`)
  }

  const offset = Math.max(1, Math.floor(Number(args.offset) || 1))
  const limit = Math.max(1, Math.min(READ_MAX_LINES, Math.floor(Number(args.limit) || READ_DEFAULT_LINES)))

  let redacted = 0
  const lines: string[] = []
  body.messages.forEach((message, index) => {
    const text = redactSecrets(String(message.text || '').slice(0, SESSION_MESSAGE_CHARS_MAX))
    redacted += text.redacted
    const speaker = message.role === 'user' ? '用户' : message.role === 'assistant' ? 'AI' : '系统'
    const at = message.at ? ` (${message.at.slice(0, 19).replace('T', ' ')})` : ''
    // 多行消息整体缩进，让「一条消息」在长文本里仍然可辨认
    lines.push(`【第 ${index + 1} 条 · ${speaker}${at}】`)
    for (const line of text.text.split('\n')) lines.push(`  ${line}`)
  })

  const total = lines.length
  const slice = lines.slice(offset - 1, offset - 1 + limit)
  if (slice.length === 0) {
    return `会话「${entry.title}」全文只有 ${total} 行，offset=${offset} 已经超出范围。`
  }

  const header =
    `会话「${entry.title}」（id: ${id}）` +
    (entry.archivedAt ? `，归档于 ${entry.archivedAt.slice(0, 10)}` : '') +
    `\n共 ${body.messages.length} 条消息 / ${total} 行，本次返回第 ${offset}–${offset + slice.length - 1} 行。`
  const footer =
    offset + slice.length - 1 < total
      ? `\n\n（还有后续内容。需要时用 offset=${offset + slice.length} 继续读。）`
      : '\n\n（已到结尾。）'
  const note = redacted > 0 ? `\n（本次隐去了 ${redacted} 处疑似密钥的内容。）` : ''

  return `${header}\n\n${slice.join('\n')}${footer}${note}`
}

interface MemoryWriteArgs {
  content: string
  target?: 'long' | 'daily'
}

/** 写记忆。敏感信息拦截在 memory.ts 里（那里是唯一入口，工具与界面都走它） */
async function memoryWriteTool(args: MemoryWriteArgs): Promise<string> {
  const result = await writeMemory({ content: args.content, target: args.target })
  return `${result.text}（文件：${result.path}）`
}

interface MemoryGetArgs {
  target?: 'long' | 'daily' | 'all'
  day?: string
}

async function memoryGetTool(args: MemoryGetArgs): Promise<string> {
  const result = await readMemory({ target: args.target, day: args.day })
  return result.text
}

function baseName(target: string): string {
  const parts = target.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] || target
}

/*
 * 读正文直接用 archive-index 的实现。
 *
 * 它返回的是完整的 StoredSession（比这里需要的字段多），
 * 但**不在这里再写一份「只取标题和消息」的版本** ——
 * 那样就有两处「会话 id → 文件路径」的规则，两边迟早会走偏
 * （这也是原来 bodyFile 在这里被复制过一份的原因）。
 */
const readBody = readArchiveBody

/** 供 dispatch 使用：名字 -> 实作 */
export const SESSION_TOOL_HANDLERS: Record<string, (args: never) => Promise<string>> = {
  listSessions: listSessionsTool as (args: never) => Promise<string>,
  readSession: readSessionTool as (args: never) => Promise<string>,
  memoryGet: memoryGetTool as (args: never) => Promise<string>,
  memoryWrite: memoryWriteTool as (args: never) => Promise<string>
}
