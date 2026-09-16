import crypto from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { app } from 'electron'
import { buildSystemDoc, SYSTEM_DOC_NAME, type RuntimeLine } from '../shared/system-doc'
import { atomicWriteFile, withLock } from './atomic-file'
import { getConfig } from './config'
import { detectRuntimes } from './runtimes'
import { detectPlatform } from './platform-compat'
import { logger } from './logger'

/**
 * `系统.md` 的落盘与一致性维护。
 *
 * ## 谁在什么时候写这个文件
 *
 * 三个时机，除此之外不写：
 *   1. 用户在设置里改了 AI 设定 → `regenerateSystemDoc()`（界面会立刻看到新内容）
 *   2. 一次对话即将开始 → `ensureSystemDoc()`（补齐环境段，并处理手改）
 *   3. 用户点「重新生成」 → 同上
 *
 * 刻意**不**在每次请求前重写：写文件本身很便宜，但它会改变 mtime，
 * 而 mtime 变了用户就分不清「这是我改的还是它自己变的」。
 * 会话内的请求走内存快照（见 sessionSystemPrompt）。
 *
 * ## 手改检测为什么用 hash 而不是 mtime
 *
 * mtime 会被任何一次触摸改变（编辑器打开保存、同步盘回写、备份软件扫描），
 * 拿它判断「用户改过」会频繁误判，然后就是「我什么都没改，它却把我的话盖了」。
 * hash 只认内容：内容一样就一个字都不动。
 *
 * ## 为什么不把 hash 写进 config.json
 *
 * config.json 是应用配置，用户也可能手改（而且它有 normalize 白名单，
 * 加字段要动三处）。这个 hash 纯粹是「这个文件的副状态」，
 * 跟着文件放在一起最不容易走散 —— 用户清空 userData 时两个一起没，也正好。
 */

/** 存「上次我们写出去的内容 hash」的旁文件。不放进 prompt，纯状态 */
const HASH_SUFFIX = '.sha256'

export function systemDocPath(): string {
  return path.join(app.getPath('userData'), SYSTEM_DOC_NAME)
}

function hashPath(): string {
  return `${systemDocPath()}${HASH_SUFFIX}`
}

function sha256(text: string): string {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex')
}

/**
 * 读上次写入的 hash。
 * 读不到（第一次运行、用户删了这个旁文件）返回空串 ——
 * 空串与任何真实 hash 都不相等，于是走一次「重新生成」，
 * 这是安全的默认方向：宁可多写一次，也不要让手改内容留在 prompt 里。
 */
function readStoredHash(): string {
  try {
    return fs.readFileSync(hashPath(), 'utf8').trim()
  } catch {
    return ''
  }
}

/**
 * 把当前设置 + 环境探测组装成 `系统.md` 全文。
 *
 * 探测运行时可能要起几个进程（冷启动一两秒），所以：
 *   - 只在**需要重写**时调用，不是每次读都调
 *   - 探测结果本身在 runtimes.ts 里有进程级缓存，第二次几乎免费
 */
async function render(): Promise<string> {
  const ai = getConfig().ai
  let runtimes: RuntimeLine[] = []
  try {
    runtimes = (await detectRuntimes()).map((item) => ({
      name: item.name,
      version: item.version,
      note: item.note
    }))
  } catch (err) {
    // 探测失败不该让设置页报错 —— 退化成「没有环境段」而已
    logger.warn('system-doc', `运行时探测失败，系统.md 不带环境段: ${String(err)}`)
  }

  return buildSystemDoc({
    aiName: ai.aiName,
    userName: ai.userName,
    systemPrompt: ai.systemPrompt,
    habits: ai.habits,
    runtimes,
    environmentNote: describeEnvironment()
  })
}

/**
 * 一句给模型看的系统环境说明。
 *
 * 只写「是什么系统」这一件事，不写版本号之外的东西 ——
 * 版本号在这里是有用的（模型据此决定给 `dir` 还是 `ls`、
 * 要不要避开 Win7 没有的命令），而补丁号之类没有用，只会占 token。
 *
 * 刻意不含**时间**与**工作区路径**：前者每轮都变（缓存必挂），
 * 后者是「这一轮在哪工作」，属于会话上下文而不是系统设定。
 */
function describeEnvironment(): string {
  try {
    const p = detectPlatform()
    const bits = process.arch === 'x64' ? '64 位' : process.arch === 'ia32' ? '32 位' : process.arch
    const name = p.name || process.platform
    const release = p.release ? ` ${p.release}` : ''
    return `用户的操作系统：${name}${release}，${bits}。`
  } catch {
    return ''
  }
}

export interface DocState {
  /** 文件在磁盘上的绝对路径，界面用它做「打开」 */
  path: string
  /** 文件当前内容（可能包含用户的手改） */
  content: string
  /** 与「按当前设置应得的内容」是否一致 */
  inSync: boolean
  /** 文件是否存在 */
  exists: boolean
}

/** 读当前文件内容。不存在返回空串 */
async function readDoc(): Promise<string | null> {
  try {
    return await fsp.readFile(systemDocPath(), 'utf8')
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code !== 'ENOENT') logger.warn('system-doc', `读取系统.md 失败: ${String(err)}`)
    return null
  }
}

/**
 * 原子写内容 + hash。
 *
 * 两步必须在一个锁里：并发调用（用户连点「重新生成」、设置页保存
 * 与一次对话开始撞在一起）如果各自交错执行，会留下
 * 「内容是 A 的、hash 是 B 的」这种状态。后果不是数据损坏 ——
 * 而是每次会话都判定「不一致」并重写一遍，
 * 表现为「这个文件老是自己在变」。
 */
function writeDoc(text: string): Promise<void> {
  return withLock('system-doc', async () => {
    await atomicWriteFile(systemDocPath(), text)
    // hash 在内容落盘之后写。反过来的话，写内容失败就会留下
    // 「hash 说一致、内容其实是旧的」的状态，下次启动不再重写
    await atomicWriteFile(hashPath(), sha256(text))
  })
}

/**
 * 设置变化后重新生成。设置页保存时调用。
 *
 * 与 ensureSystemDoc 的区别：这个**无条件覆盖**。
 * 用户在设置里刚改完，界面要立刻显示改后的内容，
 * 这时如果因为「hash 不一致」而跳过，用户会看到自己刚改的东西没生效。
 */
export async function regenerateSystemDoc(): Promise<DocState> {
  const text = await render()
  await writeDoc(text)
  logger.info('system-doc', `已重新生成 ${SYSTEM_DOC_NAME}（${text.length} 字）`)
  return { path: systemDocPath(), content: text, inSync: true, exists: true }
}

/**
 * 对话开始前调用：保证文件存在，并且**没有被手改过**。
 *
 * 用户说过「我只能在设置里改；如果自己去改了，你发起会话前就重新覆盖一遍」。
 * 这里就是那道覆盖。返回的内容直接进 system prompt。
 *
 * 返回 null 表示组装失败（读不到配置等极端情况）——
 * 调用方应当退回用设置里的 systemPrompt，而不是发一个空的 system prompt。
 */
export async function ensureSystemDoc(): Promise<string | null> {
  try {
    const expected = await render()
    const actual = await readDoc()
    const stored = readStoredHash()

    /*
     * 三种情况要重写：
     *   - 文件不存在
     *   - 内容 ≠ 按当前设置应得的内容（设置改过，或用户手改过）
     *   - 内容与应得一致，但旁文件里的 hash 对不上（旁文件被删/被改）
     *
     * 第三种看似多余（内容明明是对的），但它的作用是**修复状态**：
     * 不修的话，下次用户手改完，我们会拿一个陈旧的 stored 去比，
     * 可能恰好相等而放行手改内容。
     */
    if (actual === null || actual !== expected || stored !== sha256(expected)) {
      const reason = actual === null ? '文件不存在' : actual === expected ? '状态文件缺失' : '内容与设置不一致'
      await writeDoc(expected)
      logger.info('system-doc', `${SYSTEM_DOC_NAME} 已按当前设置重写（${reason}）`)
      return expected
    }
    return actual
  } catch (err) {
    logger.warn('system-doc', `准备 ${SYSTEM_DOC_NAME} 失败，本次对话退回设置里的提示词: ${String(err)}`)
    return null
  }
}

/** 设置页用：看当前文件状态，不写盘 */
export async function inspectSystemDoc(): Promise<DocState> {
  const actual = await readDoc()
  let expected: string | null = null
  try {
    expected = await render()
  } catch (err) {
    logger.warn('system-doc', `组装系统.md 失败: ${String(err)}`)
  }
  return {
    path: systemDocPath(),
    content: actual ?? '',
    // 组装不出来时不要谎报「已同步」——那会让用户以为一切正常
    inSync: expected !== null && actual === expected,
    exists: actual !== null
  }
}

/**
 * 会话级快照。
 *
 * 一次对话里的每一轮请求都要带 system prompt。如果每轮都重新读配置 + 探测环境，
 * 除了白花时间，还有一个更隐蔽的问题：**用户中途改了设置，同一个会话的
 * 前半段和后半段会带着不同的 system prompt**，模型的行为会莫名其妙地变。
 * 快照保证一个会话内自始至终一致。
 *
 * 缓存失效（用户改设置）不需要处理：新会话自然拿到新快照，
 * 而旧会话继续用旧的 —— 那正是我们想要的。
 */
let snapshot: string | null = null

/** 上一个用快照的会话 id，用来判断「这是不是一次新会话」 */
let snapshotSession = ''

/**
 * 取本次会话的 system prompt。
 *
 * ## sessionId 的作用（这是「覆盖手改」真正生效的地方）
 *
 * 用户的要求是「**发起会话前**就重新覆盖一遍」。注意是「发起会话前」，
 * 不是「每次请求前」—— 这两者的差别正好对应两种不同的错误：
 *
 *   - 每次请求都重读文件：会话内前后不一致（用户在第一轮之后手改了文件，
 *     第二轮的行为就变了），而且每轮多一次磁盘读
 *   - 只在进程启动时读一次：用户手改了文件、或者改了设置，
 *     要重启才生效 —— 与「设置改完立即生效」直接矛盾
 *
 * 以**会话**为单位正好避开两者：会话内不变（一致、无重复 I/O），
 * 新会话必然重新校验（手改会被覆盖、设置立刻生效）。
 *
 * 所以这个函数需要知道会话 id。**不传 id 时沿用当前快照** ——
 * 那是后台任务（归档总结）想要的：它必须用与对话时**完全相同**的
 * system prompt，否则 prompt 缓存前缀对不上，省钱的意图就落空了。
 */
export async function sessionSystemPrompt(sessionId?: string): Promise<string | null> {
  /*
   * 传了 id 且与上一个不同 → 新会话，快照作废。
   * 不传 id → 沿用现有快照（后台任务路径）。
   */
  if (sessionId && sessionId !== snapshotSession) {
    snapshot = null
    snapshotSession = sessionId
  }
  if (snapshot !== null) return snapshot
  const text = await ensureSystemDoc()
  if (text !== null) snapshot = text
  return text
}

/**
 * 丢弃快照，下一个会话重新准备。
 * 设置变更时调用（设置页保存后立即生效，不用等新会话）。
 */
export function invalidateSystemPrompt(): void {
  snapshot = null
  // 会话标记也清掉：下一次调用无论带不带 id 都会重新准备
  snapshotSession = ''
}
