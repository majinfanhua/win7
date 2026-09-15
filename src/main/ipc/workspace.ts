import fs from 'node:fs'
import fsp from 'node:fs/promises'
import http from 'node:http'
import path from 'node:path'
import { BrowserWindow, dialog, ipcMain, shell } from 'electron'
import {
  EDITOR_TABS_MAX,
  IPC,
  SPLIT_MAX,
  SPLIT_MIN,
  type EditorSession,
  type FileNode,
  type LoadedFile,
  type SnapshotSummary,
  type UndoOutcome,
  type WorkspaceEntry
} from '../../shared/types'
import { languageFromPath } from '../../shared/language'
import { getConfig, setConfig, upsertWorkspace } from '../config'
import { logger } from '../logger'
import { listSnapshots, recordSnapshot, undoSnapshot } from '../tools/snapshot'
import { markToolWrite, watchWorkspace } from '../watcher'

/** 单文件读取上限，防止误开大文件把编辑器卡死 */
const MAX_FILE_BYTES = 4 * 1024 * 1024
/**
 * 目录列表忽略项。
 *
 * 与「隐藏文件」开关是两回事：这里有 node_modules / .git 这种「哪怕开隐藏也别显示」
 * 的重目录（一次 readdir 就是几万个条目，Win7 机械盘上直接卡死），
 * 所以不管开关怎么设都不列。真正的 .env / .gitignore 之类交给 showHidden。
 */
const ALWAYS_IGNORED = new Set(['node_modules', '.git', 'out', 'dist', '__pycache__', '.venv', 'venv', '.trash'])
/** 关掉「显示隐藏文件」时额外忽略的项：所有以 . 开头的 */
function isHidden(name: string): boolean {
  return name.startsWith('.')
}

let workspaceRoot = ''

export function getWorkspaceRoot(): string {
  return workspaceRoot
}

/**
 * 切换当前工作区。
 *
 * 除了记 lastWorkspace，也把目录推进「最近工作区」列表（最新在前、去重、截断）——
 * 左侧边栏的「工作空间」分组和「最近打开」都读这一份，不再单独维护磁盘状态。
 */
export function setWorkspaceRoot(root: string): void {
  workspaceRoot = root ? path.resolve(root) : ''
  // 换工作区就换监视目标。watchWorkspace 内部会先停掉上一个，
  // 所以这里不用单独调 stopWatching
  watchWorkspace(workspaceRoot)
  if (!workspaceRoot) {
    setConfig({ lastWorkspace: '' })
    return
  }
  setConfig({
    lastWorkspace: workspaceRoot,
    recentWorkspaces: upsertWorkspace(getConfig().recentWorkspaces, workspaceRoot)
  })
}

/**
 * 所有文件操作必须落在工作区目录内，防止路径穿越。
 * 工具层（src/main/tools）也用这一份，不要另写一个 —— 两份守卫早晚会跑偏。
 */
export function assertInsideRoot(target: string): string {
  if (!workspaceRoot) throw new Error('尚未打开工作区')
  const resolved = path.resolve(target)
  const rel = path.relative(workspaceRoot, resolved)
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error(`路径越界: ${target}`)
  return resolved
}

function toNode(dir: string, entry: fs.Dirent): FileNode {
  const full = path.join(dir, entry.name)
  return {
    name: entry.name,
    path: full,
    kind: entry.isDirectory() ? 'dir' : 'file',
    size: entry.isDirectory() ? undefined : safeSize(full)
  }
}

function safeSize(file: string): number | undefined {
  try {
    return fs.statSync(file).size
  } catch {
    return undefined
  }
}

/**
 * 过滤目录项。
 *
 * 两级：ALWAYS_IGNORED 永远不显示；以 . 开头的看设置里的 showHidden。
 * 设置是每次调用时现读的，所以右键菜单里勾一下「显示隐藏文件」立即生效，
 * 不用重启也不用重新打开工作区。
 */
function visibleEntries(entries: fs.Dirent[]): fs.Dirent[] {
  const showHidden = getConfig().explorer.showHidden
  return entries.filter((e) => {
    if (ALWAYS_IGNORED.has(e.name)) return false
    if (!showHidden && isHidden(e.name)) return false
    return true
  })
}

/** 目录排序：文件夹优先，然后按名称升序（用 localeCompare 保证中文名不乱序） */
function sortNodes(nodes: FileNode[]): FileNode[] {
  return nodes.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'dir' ? -1 : 1
    return a.name.localeCompare(b.name, 'zh-Hans-CN')
  })
}

/** 删除策略：移到工作区内的 .trash 目录，而不是物理删除 */
async function moveToTrash(target: string): Promise<void> {
  const trashDir = path.join(workspaceRoot, '.trash')
  await fsp.mkdir(trashDir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const dest = path.join(trashDir, `${stamp}_${path.basename(target)}`)
  await fsp.rename(target, dest)
}

export function registerWorkspaceIpc(): void {
  ipcMain.handle(IPC.wsOpen, async (event, preset?: string) => {
    if (preset) {
      setWorkspaceRoot(preset)
      logger.info('workspace', `打开工作区: ${workspaceRoot}`)
      return workspaceRoot
    }
    const win = BrowserWindow.fromWebContents(event.sender)
    const result = win
      ? await dialog.showOpenDialog(win, { properties: ['openDirectory'], title: '选择项目文件夹' })
      : await dialog.showOpenDialog({ properties: ['openDirectory'], title: '选择项目文件夹' })
    if (result.canceled || !result.filePaths[0]) return ''
    setWorkspaceRoot(result.filePaths[0])
    logger.info('workspace', `打开工作区: ${workspaceRoot}`)
    return workspaceRoot
  })

  ipcMain.handle(IPC.wsReadDir, async (_e, dir: string): Promise<FileNode[]> => {
    const target = assertInsideRoot(dir)
    const entries = await fsp.readdir(target, { withFileTypes: true })
    return sortNodes(visibleEntries(entries).map((e) => toNode(target, e)))
  })

  ipcMain.handle(IPC.wsReadFile, async (_e, file: string): Promise<LoadedFile> => {
    const target = assertInsideRoot(file)
    const stat = await fsp.stat(target)
    if (stat.size > MAX_FILE_BYTES) {
      return {
        path: target,
        content: `// 文件过大（${(stat.size / 1024 / 1024).toFixed(1)} MB），已跳过加载。`,
        language: languageFromPath(target),
        truncated: true
      }
    }
    const content = await fsp.readFile(target, 'utf8')
    return { path: target, content, language: languageFromPath(target), truncated: false }
  })

  ipcMain.handle(IPC.wsWriteFile, async (_e, file: string, content: string): Promise<boolean> => {
    const target = assertInsideRoot(file)
    await fsp.mkdir(path.dirname(target), { recursive: true })

    // 手动保存也记一条快照。
    // 不记的话会有个难查的问题：AI 改完文件 → 使用者自己又存了一次 → 按撤销时
    // 退到的是 AI 改之前，使用者刚写的东西凭空消失。
    const before = fs.existsSync(target) ? await fsp.readFile(target, 'utf8') : ''
    if (before !== content) recordSnapshot(target, before, content, 'manual')

    // 先写临时文件再改名，避免写一半掉电导致源码损坏
    const tmp = `${target}.tmp-${process.pid}`
    markToolWrite(target, true)
    await fsp.writeFile(tmp, content, 'utf8')
    await fsp.rename(tmp, target)
    markToolWrite(target, false)
    logger.debug('workspace', `已保存: ${target}`)
    return true
  })

  ipcMain.handle(IPC.wsCreate, async (_e, parent: string, name: string, kind: 'file' | 'dir'): Promise<string> => {
    const dir = assertInsideRoot(parent)
    const target = path.join(dir, name)
    assertInsideRoot(target)
    if (fs.existsSync(target)) throw new Error(`已存在同名项: ${name}`)
    if (kind === 'dir') await fsp.mkdir(target, { recursive: true })
    else await fsp.writeFile(target, '', 'utf8')
    return target
  })

  ipcMain.handle(IPC.wsRename, async (_e, from: string, newName: string): Promise<string> => {
    const source = assertInsideRoot(from)
    const target = path.join(path.dirname(source), newName)
    assertInsideRoot(target)
    if (fs.existsSync(target)) throw new Error(`已存在同名项: ${newName}`)
    await fsp.rename(source, target)
    return target
  })

  ipcMain.handle(IPC.wsDelete, async (_e, target: string): Promise<boolean> => {
    await moveToTrash(assertInsideRoot(target))
    return true
  })

  ipcMain.handle(IPC.wsList, (): WorkspaceEntry[] => getConfig().recentWorkspaces)

  ipcMain.handle(IPC.wsRemoveRecent, (_e, target: string): WorkspaceEntry[] => {
    const resolved = path.resolve(target)
    const next = getConfig().recentWorkspaces.filter((item) => path.resolve(item.path) !== resolved)
    setConfig({ recentWorkspaces: next })
    logger.info('workspace', `已从最近列表移除: ${resolved}`)
    return next
  })

  /**
   * 「预览文件」：交系统默认程序打开。
   *
   * 不用 shell.openPath 的返回值判成败 —— 它在 Windows 上几乎总是返回空串，
   * 哪怕系统根本没有能打开 .py 的程序。所以这里只负责把请求发出去，
   * 失败在系统侧弹窗，比在这里静默返回 false 更好排查。
   */
  ipcMain.handle(IPC.wsReveal, async (_e, target: string): Promise<boolean> => {
    const file = assertInsideRoot(target)
    if (!fs.existsSync(file)) throw new Error(`文件不存在: ${file}`)
    const message = await shell.openPath(file)
    if (message) {
      logger.warn('workspace', `系统无法打开 ${file}: ${message}`)
      throw new Error(message)
    }
    logger.info('workspace', `已交系统打开: ${file}`)
    return true
  })

  /**
   * 用系统浏览器预览 HTML。
   *
   * 不能把 file:// 直接丢给浏览器：脚本受同源策略限制，`./src/main.js` 这类
   * 相对路径在 file:// 下会被 CORS 拦掉，使用者看到的是一个「页面没样式也没反应」
   * 的东西，比不预览更让人困惑。所以起一个只绑 127.0.0.1 的临时静态服务，
   * 把工作区当根目录，相对路径就正常了。
   *
   * 端口交给系统分配（listen(0)），避免和别的程序抢 8080；
   * 只监听回环地址，局域网里其他机器访问不到。
   */
  ipcMain.handle(IPC.wsPreview, async (_e, target: string): Promise<boolean> => {
    const file = assertInsideRoot(target)
    if (!fs.existsSync(file)) throw new Error(`文件不存在: ${file}`)
    const root = getWorkspaceRoot()
    const url = await serveOnce(root, path.relative(root, file))
    await shell.openExternal(url)
    logger.info('workspace', `预览: ${url} → ${file}`)
    return true
  })

  ipcMain.handle(IPC.wsSetHidden, (_e, showHidden: boolean): unknown => {
    logger.info('workspace', `显示隐藏文件: ${showHidden ? '开' : '关'}`)
    return setConfig({ explorer: { ...getConfig().explorer, showHidden: Boolean(showHidden) } })
  })

  ipcMain.handle(IPC.editorSessionGet, (): EditorSession => getConfig().editorSession)

  /**
   * 保存编辑器状态（打开过哪些文件、光标在哪、分割比例）。
   *
   * 这里要过滤一遍：渲染层传来的是真实存在的路径，但关机时工作区可能已被
   * 移动或删除，下次启动如果直接照单全开会在 UI 上弹一排「打开失败」。
   * 所以落盘前把已经不存在的路径剔掉。
   */
  ipcMain.handle(IPC.editorSessionSet, (_e, session: EditorSession): boolean => {
    const tabs = Array.isArray(session?.tabs) ? session.tabs : []
    const alive = tabs
      .filter((tab) => tab && typeof tab.path === 'string')
      .filter((tab) => {
        try {
          return fs.existsSync(tab.path) && fs.statSync(tab.path).isFile()
        } catch {
          return false
        }
      })
      .slice(0, EDITOR_TABS_MAX)
      .map((tab) => ({
        path: tab.path,
        line: Math.max(1, Number(tab.line) || 1),
        column: Math.max(1, Number(tab.column) || 1)
      }))

    // activePath 必须真的在 tabs 里，否则恢复后编辑器会指向一个不存在的标签
    const wanted = typeof session?.activePath === 'string' ? session.activePath : ''
    const activePath = alive.some((tab) => tab.path === wanted) ? wanted : (alive[0]?.path ?? '')

    // 分割比例夹到安全范围：如果内存里存了个 0，编辑器就彻底看不见了
    const rawSplit = Number(session?.split)
    const split = Number.isFinite(rawSplit)
      ? Math.min(SPLIT_MAX, Math.max(SPLIT_MIN, rawSplit))
      : DEFAULT_SPLIT

    setConfig({ editorSession: { tabs: alive, activePath, split } })
    return true
  })

  ipcMain.handle(IPC.editorUndo, (_e, target?: string): UndoOutcome => {
    const result = undoSnapshot(target ? assertInsideRoot(target) : undefined)
    if (result.ok) logger.info('workspace', `撤销: ${result.path || '(最近一条)'}`)
    return result
  })

  /**
   * 列出可撤销的记录。
   *
   * 只返回当前工作区里的那些 —— 撤销记录是跨项目累积的，
   * 把别的项目的文件列出来，使用者按一下会改到另一个项目的代码，
   * 这一点很难向使用者解释。
   */
  ipcMain.handle(IPC.editorListSnapshots, (): SnapshotSummary[] => {
    const all = listSnapshots(50)
    const root = workspaceRoot
    if (!root) return all
    return all.filter((item) => {
      const rel = path.relative(root, item.path)
      return !rel.startsWith('..') && !path.isAbsolute(rel)
    })
  })
}

/** 默认分割比例，和 shared/types 里 DEFAULT_CONFIG 保持一致 */
const DEFAULT_SPLIT = 0.62

/** 预览服务：同一时刻只保留一个，第二次预览直接复用端口 */
let previewServer: http.Server | null = null
let previewPort = 0

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8'
}

/**
 * 起（或复用）预览服务，返回要打开的 URL。
 *
 * URL 带时间戳是给「使用者改完代码再点一次预览」准备的：
 * 不带的话浏览器会拿缓存里的旧页面糊弄人，使用者会以为代码没生效。
 */
async function serveOnce(root: string, relativeFile: string): Promise<string> {
  if (!previewServer) {
    previewServer = http.createServer((req, res) => {
      try {
        const raw = decodeURIComponent((req.url || '/').split('?')[0])
        // 关键：拼完必须再校验一次，`..%2f` 这类编码绕过就挡在这里
        const resolved = path.resolve(root, `.${raw}`)
        const rel = path.relative(root, resolved)
        if (rel.startsWith('..') || path.isAbsolute(rel)) {
          res.writeHead(403).end('403 路径越界')
          return
        }
        if (!fs.existsSync(resolved) || fs.statSync(resolved).isDirectory()) {
          res.writeHead(404).end('404 未找到')
          return
        }
        const ext = path.extname(resolved).toLowerCase()
        res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' })
        fs.createReadStream(resolved).pipe(res)
      } catch (err) {
        res.writeHead(500).end(`500 ${String(err)}`)
      }
    })

    await new Promise<void>((resolve) => {
      previewServer?.listen(0, '127.0.0.1', () => {
        const address = previewServer?.address()
        if (address && typeof address === 'object') previewPort = address.port
        resolve()
      })
    })
    logger.info('workspace', `预览服务已启动: http://127.0.0.1:${previewPort}/（工作区根目录）`)
  }

  const rel = relativeFile.split(path.sep).map(encodeURIComponent).join('/')
  // 不用绝对路径拼 URL，避免 Windows 的 `C:\` 出现在 http:// 后面
  return `http://127.0.0.1:${previewPort}/${rel}?t=${Date.now()}`
}

/** 退出前关掉预览服务，否则端口会一直挂着 */
export function closePreviewServer(): void {
  previewServer?.close()
  previewServer = null
  previewPort = 0
}

/** 启动时恢复上次的工作区 */
export function restoreLastWorkspace(): void {
  const last = getConfig().lastWorkspace
  if (last && fs.existsSync(last)) setWorkspaceRoot(last)
}
