import crypto from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import { StringDecoder } from 'node:string_decoder'
import path from 'node:path'
import { logger } from '../logger'
import { markToolWrite } from '../watcher'
import { atomicWrite } from '../atomic-write'
import {
  applyEditReplacements,
  buildEditMatchStrategyNote,
  findEditMatches,
  type EditMatchStrategy
} from './edit-match'
import { guardPath } from '../permissions'
import type { ToolContext } from './meta'
import { globTool, grepTool } from './search-tools'
import { recordSnapshot, undoSnapshot } from './snapshot'

/**
 * 文件类工具的实作。
 *
 * 两条与界面版（ipc/workspace.ts）不同的约束，都是为了工具层的安全：
 *   1. readFile 不再返回「文件过大」这种占位文本 —— AI 会把它当真实内容收下。
 *      改为返回「窗口」并明确标注不是全文。
 *   2. writeFile 必须先完整读过才能写，否则拒绝 —— 否则 AI 凭记忆
 *      整篇覆盖，会把自己改的东西冲掉。
 */

/** 目录列表忽略项，和界面版保持一致 */
const IGNORED = new Set([
  'node_modules',
  '.git',
  'out',
  'dist',
  '__pycache__',
  '.venv',
  'venv',
  '.trash'
])

const DEFAULT_LIMIT = 800
const MAX_LIMIT = 5000
/** 单行超过这个长度就截断（压缩文件、base64 之类） */
const MAX_LINE_CHARS = 2000
/** 一次读文件最多扫描的字节数，保证内存占用与文件大小无关 */
const MAX_SCAN_BYTES = 4 * 1024 * 1024
/** listDir 最多返回多少个条目 */
const MAX_ENTRIES = 500

/**
 * 本会话读过哪些文件，以及读的时候磁盘上是什么样子。
 *
 * whole=false 表示只读到了片段 —— 这种情况下不允许整篇覆盖。
 *
 * mtimeMs + hash 是给「读陈旧」用的（见 assertFreshRead）：
 * 光记 whole 只挡得住「本进程没读过」，挡不住「读完之后被别的程序改了」——
 * 学生用记事本改了文件，AI 再照旧的记忆去改，就会把人的修改冲掉。
 */
interface ReadRecord {
  whole: boolean
  /** 读的那一刻文件的大小与修改时间，用于快速比对 */
  mtimeMs: number
  size: number
  /** 读到的内容的哈希，用于确认内容真的没变（mtime 精度可能不够） */
  hash: string
}

const readState = new Map<string, ReadRecord>()

function hashContent(text: string): string {
  return crypto.createHash('sha1').update(text, 'utf8').digest('hex')
}

/**
 * 写之前确认「读到的版本」还是磁盘上的版本。
 *
 * 只对「完整读过」的文件生效 —— 片段读（whole=false）记下的哈希是那一小段
 * 的内容，拿它跟整个文件比必然不等，会误报「被改过」。所以片段读完全不参与
 * 本检查，由 writeFile 自己的 whole 判断去挡整篇覆盖。
 *
 * 判定顺序：先比 size（最便宜且不会误判），再比 mtime，
 * 最后才读内容算哈希。
 */
async function assertFreshRead(target: string): Promise<void> {
  const state = readState.get(target)
  if (!state || !state.whole) return

  let stat: fs.Stats
  try {
    stat = await fsp.stat(target)
  } catch {
    // 文件被删了 —— 交给调用方的读取逻辑去报「文件不存在」，更贴切
    return
  }
  if (stat.size === state.size && stat.mtimeMs === state.mtimeMs) return

  // size 或 mtime 变了不代表内容真变了（有些编辑器与同步盘会空写一遍），
  // 所以再比一次内容，避免无谓地打断模型。
  const current = await fsp.readFile(target, 'utf8')
  if (hashContent(current) === state.hash) {
    readState.set(target, { ...state, mtimeMs: stat.mtimeMs, size: stat.size })
    return
  }

  throw new Error(
    `拒绝修改：${base(target)} 在本次读取之后被其他程序改动过。` +
      '如果照旧内容改，会把别人的修改覆盖掉。请先 readFile 重新读一遍确认当前内容，再重试。'
  )
}

function base(target: string): string {
  return path.basename(target)
}

/**
 * 记下刚写完的文件状态，供后续的读陈旧检测比对。
 * 写完之后的磁盘内容就是 content 本身，不必再读一遍。
 */
async function rememberWritten(target: string, content: string): Promise<void> {
  try {
    const stat = await fsp.stat(target)
    readState.set(target, {
      whole: true,
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      hash: hashContent(content)
    })
  } catch {
    // 记录失败只是退化成「下次不做陈旧检测」，不该让写入本身算失败
    readState.delete(target)
  }
}

/* ------------------------------------------------------------------ *
 * 按行窗口读取
 * ------------------------------------------------------------------ */

interface LineWindow {
  lines: string[]
  /** 是否读到了文件末尾 */
  reachedEof: boolean
  /** 是否因为扫描上限提前停下 */
  hitScanCap: boolean
  /**
   * 文件是否以换行符结尾。
   *
   * 需要它才能把 lines 精确还原成原文：`['a','b']` 既可能是 "a\nb"
   * 也可能是 "a\nb\n"。少一个换行就会让读态哈希与磁盘内容对不上，
   * 于是 assertFreshRead 永远误判「被外部改动过」（见读态哈希那一段注释）。
   */
  endsWithNewline: boolean
}

/**
 * 流式按行读窗口。
 *
 * 不直接 readFile 整个文件：日志文件可能几百 MB，
 * 读进内存再 split 会直接卡死主进程。这里读到够用就停。
 */
async function readLineWindow(file: string, offset: number, limit: number): Promise<LineWindow> {
  const handle = await fsp.open(file, 'r')
  const out: string[] = []
  let carry = ''
  /*
   * ⚠️ 必须用 StringDecoder，不能对定长块直接 toString('utf8')。
   *
   * 我们按 64KB 定长读，块边界会**切断 UTF-8 多字节字符**（一个汉字 3 字节）。
   * 直接 toString 的话，被切断的两半各自解出一个 U+FFFD（�）——
   * 实测 12 万字节的纯中文文件读出来必定带乱码。
   *
   * 后果不只是显示难看：AI 读到乱码之后会**照着乱码写回去**，
   * 把学生源码里的中文永久改坏。中文教学场景下这是最高频的路径。
   *
   * StringDecoder 会把「末尾不完整的字节序列」留到下一次 write 一起解，
   * 所以跨块的字符能正确还原。exec.ts 早就这么做了，这里补齐。
   */
  const decoder = new StringDecoder('utf8')
  let lineNo = 0
  let scanned = 0
  let reachedEof = false
  let hitScanCap = false
  /**
   * 是否以换行结尾。
   * 判据：读到 EOF 时 carry 为空 —— 说明最后一个字节就是分隔符。
   * 空文件（0 字节）也算「不以换行结尾」，此时 lines 为空、不参与哈希比对。
   */
  let endsWithNewline = false

  try {
    const buf = Buffer.alloc(64 * 1024)
    while (true) {
      const { bytesRead } = await handle.read(buf, 0, buf.length, null)
      if (bytesRead <= 0) {
        reachedEof = true
        break
      }
      // 二进制文件读出来会是乱码，不如直接说清楚
      if (lineNo === 0 && buf.subarray(0, bytesRead).includes(0)) {
        throw new Error(`${base(file)} 看起来是二进制文件，不支持作为文本读取`)
      }
      scanned += bytesRead
      const parts = (carry + decoder.write(buf.subarray(0, bytesRead))).split('\n')
      carry = parts.pop() ?? ''
      for (const part of parts) {
        lineNo++
        if (lineNo >= offset && out.length < limit) out.push(part)
      }
      // 这一块以换行结尾（carry 空）时先记下；后面若又读到内容会被覆盖
      endsWithNewline = carry === ''
      if (out.length >= limit) break
      if (scanned >= MAX_SCAN_BYTES) {
        hitScanCap = true
        break
      }
    }
    /*
     * 收尾：把解码器里可能压着的最后几个字节吐出来。
     * 文件在字符中间结束时（截断的文件）会得到 U+FFFD，那是真实情况的反映。
     */
    if (reachedEof) {
      carry += decoder.end()
      // 收尾后重新判定：解码器可能吐出压着的字节，让 carry 由空变非空
      endsWithNewline = carry === ''
    }

    // 最后一行没有换行符结尾的情况
    if (reachedEof && carry && lineNo + 1 >= offset && out.length < limit) {
      lineNo++
      out.push(carry)
    }
  } finally {
    await handle.close()
  }

  return { lines: out, reachedEof, hitScanCap, endsWithNewline }
}

/* ------------------------------------------------------------------ *
 * 各工具
 * ------------------------------------------------------------------ */

export interface ReadFileArgs {
  path: string
  offset?: number
  limit?: number
}

async function readFileTool(args: ReadFileArgs, ctx: ToolContext = {}): Promise<string> {
  const target = await guardPath(args.path, {
    sessionId: ctx.sessionId,
    action: `读取 ${args.path}`
  })
  const stat = await fsp.stat(target)
  if (stat.isDirectory()) throw new Error(`${target} 是目录，请用 listDir`)

  const offset = Math.max(1, Math.floor(Number(args.offset) || 1))
  const limit = Math.max(1, Math.min(MAX_LIMIT, Math.floor(Number(args.limit) || DEFAULT_LIMIT)))

  const { lines, reachedEof, hitScanCap, endsWithNewline } = await readLineWindow(target, offset, limit)
  const whole = offset === 1 && reachedEof

  /*
   * 记录「读到的版本」，供写之前做读陈旧检测。
   *
   * ⚠️ 哈希必须与 assertFreshRead 那边（`hashContent(await readFile(...))`）
   * 用**同一种拼法**，否则永远比不相等。
   *
   * 原来这里是 `lines.join('\n')` —— 它丢掉了文件末尾的换行符，
   * 而磁盘上的内容带着它。于是凡是「以换行结尾」的文件（绝大多数源码），
   * 只要 mtime 一变（编辑器空保存、同步盘 touch），assertFreshRead
   * 就会误判成「被其他程序改动过」，把 editFile / multiEdit 硬拒掉，
   * 模型被迫反复重读。
   *
   * 补回末尾换行：只有「读到了全文」且「原文确实有末尾换行」时才补 ——
   * 分片读取时 lines 里没有结尾信息，此时 whole 为 false，
   * 而 assertFreshRead 对非 whole 的读取本来就跳过校验。
   */
  const seen = lines.join('\n') + (offset === 1 && reachedEof && endsWithNewline ? '\n' : '')
  readState.set(target, {
    whole,
    mtimeMs: stat.mtimeMs,
    size: stat.size,
    hash: hashContent(seen)
  })

  const shown = lines.map((line) =>
    line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS)}…[本行过长已截断]` : line
  )

  const head = whole
    ? `【${base(target)}】全文（共 ${lines.length} 行，以下内容逐字原样，可直接用于 editFile 的 oldString）`
    : `【${base(target)}】片段：第 ${offset}-${offset + shown.length - 1} 行${
        hitScanCap ? '（已达单次扫描上限）' : ''
      }。**这不是全文**，不要据此整篇重写；需要后面的内容请用 offset=${offset + shown.length} 继续读。`

  return `${head}\n-----\n${shown.join('\n')}`
}

export interface WriteFileArgs {
  path: string
  content: string
}

async function writeFileTool(args: WriteFileArgs, ctx: ToolContext = {}): Promise<string> {
  const target = await guardPath(args.path, {
    sessionId: ctx.sessionId,
    write: true,
    action: `写入 ${args.path}`
  })
  /*
   * content 缺失要**报错**，不能退化成空串。
   *
   * 模型漏发这个字段（或中转站把字段丢了）时，原来的 `: ''`
   * 会把一个已经读过的文件**截成 0 字节**，还回一句
   * 「已写入 x（0 字符，原 1234 字符）」—— 看起来像正常完成。
   */
  if (typeof args.content !== 'string') {
    throw new Error('writeFile 需要 content 参数（要写入的完整文本），本次没有收到，已拒绝以免清空文件。')
  }
  const content = args.content
  const exists = fs.existsSync(target)

  if (exists) {
    const state = readState.get(target)
    if (!state) {
      throw new Error(
        `拒绝写入：本次对话还没读过 ${base(target)}。请先 readFile 看清当前内容，确认不会把已有代码冲掉。`
      )
    }
    if (!state.whole) {
      throw new Error(
        `拒绝整篇覆盖：之前只读了 ${base(target)} 的一部分，整篇写回会丢掉没看到的内容。请用 editFile 做局部替换。`
      )
    }
    /*
     * 还要确认「读过之后没被别人改过」。
     *
     * editFile / multiEdit 一直有这一步，writeFile 却漏了 ——
     * 于是「AI 读了 a.ts → 学生在记事本里改了它 → AI 凭记忆整篇写回」
     * 会把用户的修改**静默冲掉**，工具还回一句「已写入」。
     * 整篇覆盖比局部替换危险得多，这一步不能少。
     */
    await assertFreshRead(target)
  }

  const before = exists ? await fsp.readFile(target, 'utf8') : ''
  if (before === content) return `${base(target)} 内容没变化，未写入。`

  recordSnapshot(target, before, content, 'writeFile')
  // 标记成「工具在写」，让文件监视把随之而来的事件标成 origin='ai'，
  // 编辑器据此显示「AI 改过」而不是当成外部改动弹提示
  markToolWrite(target, true)
  try {
  await atomicWrite(target, content)
  } finally {
    // 见 ipc/workspace.ts 的说明：漏了这步会让文件永久被标成 AI 改的
    markToolWrite(target, false)
  }
  await rememberWritten(target, content)
  logger.info('tool', `writeFile: ${target}（${content.length} 字符）`)
  return `已写入 ${base(target)}（${content.length} 字符${exists ? `，原 ${before.length} 字符` : '，新建文件'}）`
}

export interface EditFileArgs {
  path: string
  oldString: string
  newString: string
  replaceAll?: boolean
}

/** 一次替换的匹配结果，只保留调用方需要的信息 */
interface ResolvedEdit {
  after: string
  /** 实际替换了几处 */
  count: number
  strategy: EditMatchStrategy
}

/**
 * 把一批 oldString→newString 依次作用到文本上。
 *
 * 关键点：走的是宽容匹配级联（见 edit-match.ts），而不是 indexOf。
 * 模型把 CRLF 抄成 LF、行尾少个空格、整段缩进多一级，都能自动救回来，
 * 并且把「靠哪一级救回来的」回报给模型，避免它下一轮继续错下去。
 *
 * replaceAll=false 时要求「唯一匹配」——在一处都不匹配、或匹配到多处时抛错，
 * 文件一个字节都不动。
 */
function applyEdits(
  source: string,
  edits: Array<{ oldString: string; newString: string; replaceAll?: boolean }>,
  fileLabel: string,
  /** 出错的措辞前缀，multiEdit 会带上「第 N 处」 */
  label: (index: number) => string
): ResolvedEdit {
  let work = source
  let applied = 0
  let weakest: EditMatchStrategy = 'exact'
  const rank: Record<EditMatchStrategy, number> = {
    exact: 0,
    'line-endings': 1,
    'trailing-whitespace': 2,
    indentation: 3
  }

  for (const [index, edit] of edits.entries()) {
    const prefix = label(index)
    if (typeof edit?.oldString !== 'string' || edit.oldString === '') {
      throw new Error(`${prefix}的 oldString 不能为空。本次未修改任何内容。`)
    }
    const newString = typeof edit.newString === 'string' ? edit.newString : ''

    const outcome = findEditMatches(work, edit.oldString, newString)
    if (!outcome) {
      throw new Error(
        `${prefix}没在 ${fileLabel} 里找到这段原文` +
          `${index > 0 ? '（也可能被前面的替换改掉了）' : ''}。` +
          '本次未修改任何内容。请先用 readFile 看清实际内容 —— ' +
          '注意缩进、空行、标点都要对得上。'
      )
    }

    const total = outcome.replacements.length
    if (total > 1 && !edit.replaceAll) {
      throw new Error(
        `${prefix}的原文在 ${fileLabel} 里出现了 ${total} 次，无法确定改哪一处。` +
          '本次未修改任何内容。请多给几行上下文让它唯一，或明确设 replaceAll=true 改全部。'
      )
    }

    const used = edit.replaceAll ? outcome.replacements : outcome.replacements.slice(0, 1)
    work = applyEditReplacements(work, used)
    applied += used.length
    if (rank[outcome.strategy] > rank[weakest]) weakest = outcome.strategy
    // 后续级别的查找要在「已改过」的文本上重新判断换行风格
  }

  return { after: work, count: applied, strategy: weakest }
}

async function editFileTool(args: EditFileArgs, ctx: ToolContext = {}): Promise<string> {
  const target = await guardPath(args.path, {
    sessionId: ctx.sessionId,
    write: true,
    action: `修改 ${args.path}`
  })
  const { oldString, newString } = args
  if (typeof oldString !== 'string' || oldString === '') throw new Error('oldString 不能为空')
  if (typeof newString !== 'string') throw new Error('newString 必须是字符串')

  await assertFreshRead(target)
  const before = await fsp.readFile(target, 'utf8')

  const resolved = applyEdits(before, [{ oldString, newString, replaceAll: args.replaceAll }], base(target), () => '')
  if (resolved.after === before) return `${base(target)} 内容没变化，未写入。`

  recordSnapshot(target, before, resolved.after, 'editFile')
  markToolWrite(target, true)
  try {
  await atomicWrite(target, resolved.after)
  } finally {
    // 见 ipc/workspace.ts 的说明：漏了这步会让文件永久被标成 AI 改的
    markToolWrite(target, false)
  }
  const stat = await fsp.stat(target)
  readState.set(target, {
    whole: true,
    mtimeMs: stat.mtimeMs,
    size: stat.size,
    hash: hashContent(resolved.after)
  })
  logger.info('tool', `editFile: ${target}（替换 ${resolved.count} 处，策略 ${resolved.strategy}）`)
  return (
    `已修改 ${base(target)}：替换 ${resolved.count} 处` +
    buildEditMatchStrategyNote(resolved.strategy)
  )
}

export interface MultiEditArgs {
  path: string
  edits: Array<{ oldString: string; newString: string; replaceAll?: boolean }>
}

async function multiEditTool(args: MultiEditArgs, ctx: ToolContext = {}): Promise<string> {
  const target = await guardPath(args.path, {
    sessionId: ctx.sessionId,
    write: true,
    action: `多处修改 ${args.path}`
  })
  const edits = Array.isArray(args.edits) ? args.edits : []
  if (edits.length === 0) throw new Error('edits 不能为空')

  await assertFreshRead(target)
  const before = await fsp.readFile(target, 'utf8')

  // 先在内存里全部走一遍，任何一处不过关就直接抛错，文件一个字节也不动
  const resolved = applyEdits(before, edits, base(target), (i) => `第 ${i + 1} 处替换`)

  if (resolved.after === before) return `${base(target)} 内容没变化，未写入。`

  recordSnapshot(target, before, resolved.after, 'multiEdit')
  markToolWrite(target, true)
  try {
  await atomicWrite(target, resolved.after)
  } finally {
    // 见 ipc/workspace.ts 的说明：漏了这步会让文件永久被标成 AI 改的
    markToolWrite(target, false)
  }
  const stat = await fsp.stat(target)
  readState.set(target, {
    whole: true,
    mtimeMs: stat.mtimeMs,
    size: stat.size,
    hash: hashContent(resolved.after)
  })
  logger.info('tool', `multiEdit: ${target}（${edits.length} 处，共替换 ${resolved.count} 处）`)
  return (
    `已修改 ${base(target)}：共 ${edits.length} 处替换全部成功` +
    buildEditMatchStrategyNote(resolved.strategy)
  )
}

export interface ListDirArgs {
  path: string
  depth?: number
}

interface DirEntry {
  name: string
  dir: boolean
}

async function collect(dir: string, depth: number, budget: { left: number }): Promise<string[]> {
  if (depth <= 0 || budget.left <= 0) return []
  let entries: fs.Dirent[]
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true })
  } catch (err) {
    return [`（无法读取：${String(err)}）`]
  }

  const sorted: DirEntry[] = entries
    .filter((e) => !IGNORED.has(e.name))
    .map((e) => ({ name: e.name, dir: e.isDirectory() }))
    .sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name, 'zh-Hans-CN') : a.dir ? -1 : 1))

  const lines: string[] = []
  for (const entry of sorted) {
    if (budget.left <= 0) {
      lines.push('…（条目过多，已截断）')
      break
    }
    budget.left--
    if (entry.dir) {
      lines.push(`${entry.name}/`)
      const children = await collect(path.join(dir, entry.name), depth - 1, budget)
      lines.push(...children.map((line) => `  ${line}`))
    } else {
      lines.push(entry.name)
    }
  }
  return lines
}

async function listDirTool(args: ListDirArgs, ctx: ToolContext = {}): Promise<string> {
  // path 改成可选：模型经常想「看看项目根」，以前必填 + 要绝对路径
  // 让它只能瞎猜。不填就是当前工作区根（没项目时是临时区）。
  const target = await guardPath(args.path || '.', {
    sessionId: ctx.sessionId,
    action: `列出目录 ${args.path || '(当前工作区)'}`
  })
  const stat = await fsp.stat(target)
  if (!stat.isDirectory()) throw new Error(`${target} 不是目录`)
  const depth = Math.max(1, Math.min(3, Math.floor(Number(args.depth) || 1)))
  const lines = await collect(target, depth, { left: MAX_ENTRIES })
  if (lines.length === 0) return `${target} 是空目录（或全部被忽略）`
  return `${target}（递归 ${depth} 层）：\n${lines.join('\n')}`
}

export interface UndoSnapshotArgs {
  path?: string
}

async function undoSnapshotTool(args: UndoSnapshotArgs, ctx: ToolContext = {}): Promise<string> {
  // 撤销是写操作 —— 计划模式下同样要拦
  const target = args.path
    ? await guardPath(args.path, {
        sessionId: ctx.sessionId,
        write: true,
        action: `回退 ${args.path}`
      })
    : undefined
  const result = undoSnapshot(target)
  if (!result.ok) throw new Error(result.message)
  // 回退后文件内容变了，之前记的读状态已失效 —— 删掉逼模型重新读一遍，
  // 而不是拿旧的 mtime/hash 去做「没被改过」的误判
  if (result.path) readState.delete(result.path)
  return result.message
}

/**
 * 供 dispatch 使用：名字 -> 实作。
 *
 * 签名统一收 ToolContext（第二个参数），由 tools/index.ts 的 executeTool
 * 从调用点透传 —— 权限层要靠它区分会话（见 ToolContext 的注释）。
 */
export const FILE_TOOL_HANDLERS: Record<
  string,
  (args: never, ctx?: ToolContext) => Promise<string>
> = {
  readFile: readFileTool as (args: never, ctx?: ToolContext) => Promise<string>,
  writeFile: writeFileTool as (args: never, ctx?: ToolContext) => Promise<string>,
  editFile: editFileTool as (args: never, ctx?: ToolContext) => Promise<string>,
  multiEdit: multiEditTool as (args: never, ctx?: ToolContext) => Promise<string>,
  listDir: listDirTool as (args: never, ctx?: ToolContext) => Promise<string>,
  // 搜索类实作在 search-tools.ts，但要合并进这张表 —— 调度层只认这一份
  glob: globTool as (args: never, ctx?: ToolContext) => Promise<string>,
  grep: grepTool as (args: never, ctx?: ToolContext) => Promise<string>,
  undoSnapshot: undoSnapshotTool as (args: never, ctx?: ToolContext) => Promise<string>
}
