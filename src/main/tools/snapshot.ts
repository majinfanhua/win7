import fs from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import type { SnapshotSummary } from '../../shared/types'
import { logger } from '../logger'
import { markToolWrite } from '../watcher'

/**
 * 修改快照。
 *
 * 为什么自己存而不依赖 git：教室机器大多没装 git（见 docs/7gai工具对照与实现规划.md §2.1），
 * 而使用者真正需要的只是「刚才那步改坏了，退回去」。
 *
 * 存在 userData/snapshots.jsonl（一行一条），跨重启仍然有效 ——
 * 把应用关了再打开，照样能撤销上一次 AI 的修改。
 */

export interface Snapshot {
  id: string
  time: string
  path: string
  before: string
  after: string
  /** 来源：工具名或 manual */
  source: string
}

/** 保留的最大条数，超过就从头截掉 */
const MAX_ENTRIES = 200

/** 单条快照内容上限，超过就不存（只记录日志），避免 jsonl 无限膨胀 */
const MAX_CONTENT_BYTES = 2 * 1024 * 1024

let cachedPath = ''

function snapshotsPath(): string {
  if (!cachedPath) cachedPath = path.join(app.getPath('userData'), 'snapshots.jsonl')
  return cachedPath
}

function readAll(): Snapshot[] {
  try {
    const raw = fs.readFileSync(snapshotsPath(), 'utf8')
    const out: Snapshot[] = []
    for (const line of raw.split('\n')) {
      const text = line.trim()
      if (!text) continue
      try {
        const item = JSON.parse(text) as Snapshot
        if (item && typeof item.path === 'string') out.push(item)
      } catch {
        /* 单行坏了不影响其他行 */
      }
    }
    return out
  } catch {
    return []
  }
}

function writeAll(list: Snapshot[]): void {
  const file = snapshotsPath()
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const body = list.map((item) => JSON.stringify(item)).join('\n')
    fs.writeFileSync(file, body ? `${body}\n` : '', 'utf8')
  } catch (err) {
    logger.error('snapshot', `快照写入失败: ${String(err)}`)
  }
}

/** 每次工具要改文件之前调一次 */
export function recordSnapshot(
  filePath: string,
  before: string,
  after: string,
  source: string
): boolean {
  if (before.length > MAX_CONTENT_BYTES || after.length > MAX_CONTENT_BYTES) {
    logger.warn('snapshot', `文件过大，已跳过快照: ${filePath}`)
    return false
  }
  const list = readAll()
  list.push({
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    time: new Date().toISOString(),
    path: filePath,
    before,
    after,
    source
  })
  writeAll(list.slice(-MAX_ENTRIES))
  return true
}

export interface UndoResult {
  ok: boolean
  message: string
  path?: string
}

/**
 * 回退。
 * 找到最近一条快照，把文件恢复成 before，并把这条快照从历史里移除 ——
 * 所以连续调两次就是连退两步，而不是反复恢复同一处。
 */
export function undoSnapshot(target?: string): UndoResult {
  const list = readAll()
  if (list.length === 0) return { ok: false, message: '没有可回退的修改记录' }

  let index = -1
  for (let i = list.length - 1; i >= 0; i--) {
    if (!target || list[i].path === target) {
      index = i
      break
    }
  }
  if (index === -1) {
    return { ok: false, message: `没有找到 ${target} 的修改记录` }
  }

  const item = list[index]
  // 标记成工具写入，让文件监视把事件标成 origin='ai'（撤销也是 AI 侧的改动），
  // 否则编辑器会把它当成外部改动弹提示
  markToolWrite(item.path, true)
  try {
    fs.mkdirSync(path.dirname(item.path), { recursive: true })
    /*
     * 这里保持同步写。
     *
     * undoSnapshot 是同步函数（调用方 wsDelete/editorUndo 都按同步用），
     * 改成 async 会往上传染一圈。它写的是**已经读进内存的旧内容**，
     * 不存在「写一半掉电更糟」的权衡 —— 真正要修的是下面那个
     * markToolWrite 泄漏，那是同一个 bug 的另一半。
     */
    fs.writeFileSync(item.path, item.before, 'utf8')
  } catch (err) {
    return { ok: false, message: `回退失败: ${String(err)}` }
  } finally {
    /*
     * ⚠️ 清理必须在 finally 里。
     * markToolWrite 的集合只有这一个出口（它内部延迟 500ms 删除），
     * 放在 try 内的话，写入一失败这个路径就永久留在集合里 ——
     * 之后用户自己改这个文件会被误标成 origin='ai'。
     */
    markToolWrite(item.path, false)
  }

  list.splice(index, 1)
  writeAll(list)
  logger.info('snapshot', `已回退: ${item.path}（来源 ${item.source}）`)
  return { ok: true, message: `已把 ${path.basename(item.path)} 恢复到修改前`, path: item.path }
}

/**
 * 列出可回退的记录（只有摘要，不含文件正文）。
 *
 * 界面只用来回答「有没有东西可以撤销、撤销的是哪个文件」，
 * 不需要也不应该把几 MB 的 before/after 送到渲染进程。
 */
export function listSnapshots(limit = 20): SnapshotSummary[] {
  const list = readAll()
  return list
    .slice(-limit)
    .reverse()
    .map((item) => ({
      id: item.id,
      time: item.time,
      path: item.path,
      source: item.source,
      // 行数差：正数表示 AI 加了行，负数表示删了行。比字符数更直观
      lineDelta: countLines(item.after) - countLines(item.before)
    }))
}

function countLines(text: string): number {
  return text ? text.split('\n').length : 0
}

/** 还剩多少条可回退（自检与设置界面用） */
export function snapshotCount(): number {
  return readAll().length
}
