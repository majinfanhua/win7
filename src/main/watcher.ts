import fs from 'node:fs'
import path from 'node:path'
import type { FileChangeEvent } from '../shared/types'
import { logger } from './logger'

/**
 * 工作区文件监视。
 *
 * 解决一个致命问题：AI 调用工具改了磁盘上的文件，编辑器却还在显示内存里的旧副本。
 * 看到的是「AI 说改好了，但代码没变」—— 在 AI 编辑器里这足以让人完全失去信任。
 *
 * 实现选择：原生 fs.watch 递归监听工作区根目录。
 *
 * 为什么不引 chokidar：它在 Win7 上会退回轮询模式（fs.watchFile），
 * 50ms 一轮地 stat 整棵目录树，机械盘上直接变成 100% 占用。
 * fs.watch 在 Windows 上底层是 ReadDirectoryChangesW，是真正的内核事件，
 * 零轮询开销 —— 对教室里的老机器这是唯一可接受的选择。
 *
 * 已知取舍：
 *   - Windows 上 fs.watch 只给文件名，不给事件类型，所以我们不区分「改/删/建」，
 *     统一按「这个路径有变化」处理，由渲染层去决定是重载还是关标签。
 *   - 部分编辑器保存时走「写临时文件 + rename」，会触发两次事件。
 *     靠 debounce 去重。
 */

/** 忽略的目录，和文件树保持一致 —— 监视 node_modules 会淹没在事件里 */
const IGNORED_DIRS = new Set([
  'node_modules',
  '.git',
  'out',
  'dist',
  '__pycache__',
  '.venv',
  'venv',
  '.trash'
])

/** 一次写入通常会触发多次事件（write + rename），合并窗口 */
const DEBOUNCE_MS = 120
/** 一次写入的临时后缀，直接忽略不推给界面 */
const TEMP_SUFFIX = ['.tmp', '.swp', '.swx', '~', '.crswap']

let watcher: fs.FSWatcher | null = null
let watchedRoot = ''
/** 当前正在被工具写入的路径。写入期间产生的事件标成 origin='ai' */
const toolWriting = new Set<string>()
/** path -> 待发送的定时器，用于 debounce */
const pending = new Map<string, ReturnType<typeof setTimeout>>()

/** 事件接收方：主进程里只有一个窗口，直接存 send 函数最简单 */
type Emit = (event: FileChangeEvent) => void
let emit: Emit | null = null

export function setFileChangeEmitter(fn: Emit): void {
  emit = fn
}

function shouldIgnore(filePath: string): boolean {
  const name = path.basename(filePath)
  if (TEMP_SUFFIX.some((suffix) => name.endsWith(suffix))) return true
  const parts = filePath.split(/[\\/]/)
  return parts.some((part) => IGNORED_DIRS.has(part))
}

/**
 * 工具写入前后的标记。
 *
 * 工具写文件用的是「写 .tmp + rename」原子替换，事件里的路径是最终路径，
 * 但事件到达时间晚于 rename，所以这里按路径标记而不是按时间猜。
 * 标记在 flush 时消费掉，之后同一路径的外部改动会正确标成 external。
 */
export function markToolWrite(filePath: string, on: boolean): void {
  const resolved = path.resolve(filePath)
  if (on) toolWriting.add(resolved)
  else {
    // 延迟清除：fs.watch 的事件是异步到达的，立刻清会漏标
    setTimeout(() => toolWriting.delete(resolved), 500)
  }
}

function flush(filePath: string): void {
  pending.delete(filePath)
  if (!emit) return
  const isAi = toolWriting.has(path.resolve(filePath))
  emit({
    path: filePath,
    origin: isAi ? 'ai' : 'external',
    at: new Date().toISOString()
  })
}

/** 开始监视一个工作区。重复调用会先停掉上一个 */
export function watchWorkspace(root: string): void {
  stopWatching()
  if (!root) return

  const resolved = path.resolve(root)
  try {
    watcher = fs.watch(resolved, { recursive: true, persistent: false }, (_event, filename) => {
      if (!filename) return
      // filename 在 Windows 上是相对路径，在 Linux/macOS 上可能是文件名
      const full = path.resolve(resolved, filename)
      if (shouldIgnore(full)) return

      const existing = pending.get(full)
      if (existing) clearTimeout(existing)
      pending.set(
        full,
        setTimeout(() => flush(full), DEBOUNCE_MS)
      )
    })

    watcher.on('error', (err) => {
      logger.warn('watch', `文件监视出错，已停止: ${String(err)}`)
      stopWatching()
    })

    watchedRoot = resolved
    logger.info('watch', `开始监视工作区: ${resolved}`)
  } catch (err) {
    // 递归监视在某些文件系统（网络盘、老 FAT32）上不被支持。
    // 这时不 crash，只是退化成「AI 改完由渲染层主动刷新」的旧行为
    logger.warn('watch', `无法监视 ${resolved}（该文件系统可能不支持递归监视）: ${String(err)}`)
    watcher = null
    watchedRoot = ''
  }
}

export function stopWatching(): void {
  watcher?.close()
  watcher = null
  watchedRoot = ''
  for (const timer of pending.values()) clearTimeout(timer)
  pending.clear()
}

/** 当前是否在监视（自检与设置页展示用） */
export function watchStatus(): { active: boolean; root: string } {
  return { active: Boolean(watcher), root: watchedRoot }
}
