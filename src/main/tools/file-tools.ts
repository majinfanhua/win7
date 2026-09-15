import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { assertInsideRoot } from '../ipc/workspace'
import { logger } from '../logger'
import { markToolWrite } from '../watcher'
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
 * 本会话读过哪些文件。
 * whole=false 表示只读到了片段 —— 这种情况下不允许整篇覆盖。
 */
const readState = new Map<string, { whole: boolean }>()

function base(target: string): string {
  return path.basename(target)
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0
  let count = 0
  let from = 0
  while (true) {
    const at = haystack.indexOf(needle, from)
    if (at === -1) return count
    count++
    from = at + needle.length
  }
}

/** 临时文件 + rename，避免写一半掉电把源码写坏 */
async function atomicWrite(target: string, content: string): Promise<void> {
  await fsp.mkdir(path.dirname(target), { recursive: true })
  const tmp = `${target}.tmp-${process.pid}`
  await fsp.writeFile(tmp, content, 'utf8')
  await fsp.rename(tmp, target)
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
  let lineNo = 0
  let scanned = 0
  let reachedEof = false
  let hitScanCap = false

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
      const parts = (carry + buf.subarray(0, bytesRead).toString('utf8')).split('\n')
      carry = parts.pop() ?? ''
      for (const part of parts) {
        lineNo++
        if (lineNo >= offset && out.length < limit) out.push(part)
      }
      if (out.length >= limit) break
      if (scanned >= MAX_SCAN_BYTES) {
        hitScanCap = true
        break
      }
    }
    // 最后一行没有换行符结尾的情况
    if (reachedEof && carry && lineNo + 1 >= offset && out.length < limit) {
      lineNo++
      out.push(carry)
    }
  } finally {
    await handle.close()
  }

  return { lines: out, reachedEof, hitScanCap }
}

/* ------------------------------------------------------------------ *
 * 各工具
 * ------------------------------------------------------------------ */

export interface ReadFileArgs {
  path: string
  offset?: number
  limit?: number
}

async function readFileTool(args: ReadFileArgs): Promise<string> {
  const target = assertInsideRoot(args.path)
  const stat = await fsp.stat(target)
  if (stat.isDirectory()) throw new Error(`${target} 是目录，请用 listDir`)

  const offset = Math.max(1, Math.floor(Number(args.offset) || 1))
  const limit = Math.max(1, Math.min(MAX_LIMIT, Math.floor(Number(args.limit) || DEFAULT_LIMIT)))

  const { lines, reachedEof, hitScanCap } = await readLineWindow(target, offset, limit)
  const whole = offset === 1 && reachedEof
  readState.set(target, { whole })

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

async function writeFileTool(args: WriteFileArgs): Promise<string> {
  const target = assertInsideRoot(args.path)
  const content = typeof args.content === 'string' ? args.content : ''
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
  }

  const before = exists ? await fsp.readFile(target, 'utf8') : ''
  if (before === content) return `${base(target)} 内容没变化，未写入。`

  recordSnapshot(target, before, content, 'writeFile')
  // 标记成「工具在写」，让文件监视把随之而来的事件标成 origin='ai'，
  // 编辑器据此显示「AI 改过」而不是当成外部改动弹提示
  markToolWrite(target, true)
  await atomicWrite(target, content)
  markToolWrite(target, false)
  readState.set(target, { whole: true })
  logger.info('tool', `writeFile: ${target}（${content.length} 字符）`)
  return `已写入 ${base(target)}（${content.length} 字符${exists ? `，原 ${before.length} 字符` : '，新建文件'}）`
}

export interface EditFileArgs {
  path: string
  oldString: string
  newString: string
  replaceAll?: boolean
}

async function editFileTool(args: EditFileArgs): Promise<string> {
  const target = assertInsideRoot(args.path)
  const { oldString, newString } = args
  if (typeof oldString !== 'string' || oldString === '') throw new Error('oldString 不能为空')
  if (typeof newString !== 'string') throw new Error('newString 必须是字符串')

  const before = await fsp.readFile(target, 'utf8')
  const count = countOccurrences(before, oldString)

  if (count === 0) {
    throw new Error(
      `在 ${base(target)} 里没找到这段原文。请先用 readFile 看清实际内容（缩进、空行、标点都必须完全一致）。`
    )
  }
  if (count > 1 && !args.replaceAll) {
    throw new Error(
      `这段原文在 ${base(target)} 里出现了 ${count} 次，无法确定改哪一处。请多给几行上下文让它唯一，或明确设 replaceAll=true 改全部。`
    )
  }

  const after = args.replaceAll
    ? before.split(oldString).join(newString)
    : before.replace(oldString, newString)

  recordSnapshot(target, before, after, 'editFile')
  markToolWrite(target, true)
  await atomicWrite(target, after)
  markToolWrite(target, false)
  readState.set(target, { whole: true })
  logger.info('tool', `editFile: ${target}（替换 ${args.replaceAll ? count : 1} 处）`)
  return `已修改 ${base(target)}：替换 ${args.replaceAll ? count : 1} 处`
}

export interface MultiEditArgs {
  path: string
  edits: Array<{ oldString: string; newString: string; replaceAll?: boolean }>
}

async function multiEditTool(args: MultiEditArgs): Promise<string> {
  const target = assertInsideRoot(args.path)
  const edits = Array.isArray(args.edits) ? args.edits : []
  if (edits.length === 0) throw new Error('edits 不能为空')

  const before = await fsp.readFile(target, 'utf8')
  let work = before

  // 先在内存里全部走一遍，任何一处不过关就直接抛错，文件一个字节也不动
  for (const [index, edit] of edits.entries()) {
    const label = `第 ${index + 1} 处替换`
    if (typeof edit?.oldString !== 'string' || edit.oldString === '') {
      throw new Error(`${label} 的 oldString 不能为空。本次未修改任何内容。`)
    }
    const count = countOccurrences(work, edit.oldString)
    if (count === 0) {
      throw new Error(`${label}没找到原文（可能被前面的替换改掉了）。本次未修改任何内容。`)
    }
    if (count > 1 && !edit.replaceAll) {
      throw new Error(`${label}的原文出现 ${count} 次，无法确定改哪一处。本次未修改任何内容。`)
    }
    work = edit.replaceAll
      ? work.split(edit.oldString).join(edit.newString ?? '')
      : work.replace(edit.oldString, edit.newString ?? '')
  }

  if (work === before) return `${base(target)} 内容没变化，未写入。`

  recordSnapshot(target, before, work, 'multiEdit')
  markToolWrite(target, true)
  await atomicWrite(target, work)
  markToolWrite(target, false)
  readState.set(target, { whole: true })
  logger.info('tool', `multiEdit: ${target}（${edits.length} 处）`)
  return `已修改 ${base(target)}：共 ${edits.length} 处替换全部成功`
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

async function listDirTool(args: ListDirArgs): Promise<string> {
  const target = assertInsideRoot(args.path)
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

async function undoSnapshotTool(args: UndoSnapshotArgs): Promise<string> {
  const target = args.path ? assertInsideRoot(args.path) : undefined
  const result = undoSnapshot(target)
  if (!result.ok) throw new Error(result.message)
  if (result.path) readState.set(result.path, { whole: true })
  return result.message
}

/** 供 dispatch 使用：名字 -> 实作 */
export const FILE_TOOL_HANDLERS: Record<string, (args: never) => Promise<string>> = {
  readFile: readFileTool as (args: never) => Promise<string>,
  writeFile: writeFileTool as (args: never) => Promise<string>,
  editFile: editFileTool as (args: never) => Promise<string>,
  multiEdit: multiEditTool as (args: never) => Promise<string>,
  listDir: listDirTool as (args: never) => Promise<string>,
  undoSnapshot: undoSnapshotTool as (args: never) => Promise<string>
}
