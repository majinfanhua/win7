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
import { checkWorkspaceSafety } from '../command-safety'
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

/**
 * 一次 stat 同时取 size 与 mtime。
 *
 * 为什么合成一次：Win7 机械盘 + 校园杀软实时扫描下，每个文件 stat 一次已经够贵，
 * 分两次拿 size 与 mtime 等于把代价翻倍，而目录里几十个文件时体感很明显。
 * 失败（权限、文件刚被删）时两项都留空，不抛 —— 文件树不该因为一个文件读不到就整目录报错。
 */
function safeStat(file: string): { size?: number; mtime?: number } {
  try {
    const st = fs.statSync(file)
    return { size: st.size, mtime: st.mtimeMs }
  } catch {
    return {}
  }
}

function toNode(dir: string, entry: fs.Dirent): FileNode {
  const full = path.join(dir, entry.name)
  if (entry.isDirectory()) {
    // 目录不给 size/mtime：目录的 mtime 是「目录项本身被改」的时间，
    // 和「里面文件改了没」无关，拿它排序会误导使用者
    return { name: entry.name, path: full, kind: 'dir' }
  }
  return { name: entry.name, path: full, kind: 'file', ...safeStat(full) }
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

/**
 * 删除策略：交给系统回收站，而不是物理删除。
 *
 * 曾经是自己往工作区里的 `.trash` 目录 rename。那个做法有三个问题，
 * 换掉之前先看清为什么不该退回去：
 *   1. `.trash` 被放进了 ALWAYS_IGNORED，文件树里看不见 ——
 *      学生误删之后既看不到也拿不回来，等于物理删除但占了磁盘
 *   2. 没有任何清理与还原入口，删得越多工作区越胖
 *   3. 跨盘/挂载点 rename 会抛 EXDEV，而目标目录是工作区内的固定位置，
 *      工作区本身跨盘时必然踩到
 * `shell.trashItem` 走的是系统回收站（Windows 上是 SHFileOperation），
 * 学生能自己右键还原，也由系统按回收站策略清理。
 * 它在 Win7 上可用，且不依赖任何原生模块。
 *
 * 注意：不进回收站的情况是「文件太大超过回收站配额」——那时系统会直接删除。
 * 这是系统行为，不在这里兜底（兜底等于又写一个自制的垃圾桶）。
 */
async function moveToTrash(target: string): Promise<void> {
  await shell.trashItem(target)
}

/**
 * 工作区落在敏感目录（home、磁盘根、~/.ssh …）时记一条警告。
 *
 * 这里**只警告、不阻止**。原因：这是给教学用的编辑器，
 * 直接拒绝打开会变成「老师打不开自己的课件文件夹」这种莫名其妙的故障；
 * 而风险本身是「AI 的读写范围过大」，靠一条日志 + 设置页的提示足以让
 * 使用者知道该换个目录。真出问题是可解释的，不是静默发生的。
 */
function warnIfUnsafeWorkspace(root: string): void {
  const verdict = checkWorkspaceSafety(root)
  if (verdict.ok) return
  logger.warn(
    'workspace',
    `当前工作区范围过大：${verdict.reason}（AI 的读写围栏等于没有，建议换一个具体的项目文件夹）`
  )
}

export function registerWorkspaceIpc(): void {
  ipcMain.handle(IPC.wsOpen, async (event, preset?: string) => {
    if (preset) {
      setWorkspaceRoot(preset)
      logger.info('workspace', `打开工作区: ${workspaceRoot}`)
      warnIfUnsafeWorkspace(workspaceRoot)
      return workspaceRoot
    }
    const win = BrowserWindow.fromWebContents(event.sender)
    const result = win
      ? await dialog.showOpenDialog(win, { properties: ['openDirectory'], title: '选择项目文件夹' })
      : await dialog.showOpenDialog({ properties: ['openDirectory'], title: '选择项目文件夹' })
    if (result.canceled || !result.filePaths[0]) return ''
    setWorkspaceRoot(result.filePaths[0])
    logger.info('workspace', `打开工作区: ${workspaceRoot}`)
    warnIfUnsafeWorkspace(workspaceRoot)
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

  ipcMain.handle(IPC.wsMove, async (_e, from: string, destDir: string): Promise<string> => {
    const source = assertInsideRoot(from)
    const dir = assertInsideRoot(destDir)

    const stat = await fsp.stat(dir).catch(() => null)
    if (!stat) throw new Error(`目标文件夹不存在: ${dir}`)
    if (!stat.isDirectory()) throw new Error(`目标不是文件夹: ${dir}`)

    const target = path.join(dir, path.basename(source))

    // 移到自己所在的目录 = 什么都没做。当成成功返回，不报错 ——
    // 拖拽落到原处是很自然的操作，弹一句「不能移动到自己」是纯噪音
    if (path.resolve(target) === path.resolve(source)) return source

    /*
     * 不能把目录移进它自己的子孙目录里。
     * 不做这个检查的话，`fs.rename` 在 Windows 上会抛 EINVAL，
     * 但那句英文错误学生读不懂；更糟的是 copy 回退路径会递归复制到无穷。
     */
    const rel = path.relative(source, dir)
    if (!rel.startsWith('..') && !path.isAbsolute(rel)) {
      throw new Error('不能把一个文件夹移动到它自己里面')
    }

    // 目标重名必须显式拦住。Windows 上 rename 对文件是覆盖、对目录是失败，
    // 行为不一致且都不提示，所以先探一次，并且给一句能照做的中文原因
    if (fs.existsSync(target)) {
      throw new Error(`目标文件夹里已经有「${path.basename(source)}」了，请先改名或删除它`)
    }

    try {
      await fsp.rename(source, target)
    } catch (err) {
      /*
       * 跨盘（Windows 上是不同盘符，Linux 上是不同挂载点）rename 会抛 EXDEV。
       * 回退成「复制 + 删源」。只用 Node 自带的 cp（Node 16.7+ 有），
       * 不引 fs-extra —— 这个项目零运行时依赖。
       */
      if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err
      await fsp.cp(source, target, { recursive: true, errorOnExist: true, force: false })
      await fsp.rm(source, { recursive: true, force: true })
      logger.info('workspace', `跨盘移动，已回退为复制 + 删除: ${source} -> ${target}`)
    }

    logger.info('workspace', `已移动: ${source} -> ${target}`)
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

  /**
   * 只取预览 URL，**不**打开系统浏览器 —— 给内嵌预览面板用。
   *
   * 与 wsPreview 分开而不是加个参数：两者的副作用完全不同
   * （一个会拉起浏览器抢焦点，一个什么也不做）。
   * 合成一个的话，以后有人传错参数就会莫名其妙弹出浏览器。
   */
  ipcMain.handle(IPC.wsPreviewUrl, async (_e, target: string): Promise<string> => {
    const file = assertInsideRoot(target)
    if (!fs.existsSync(file)) throw new Error(`文件不存在: ${file}`)
    const root = getWorkspaceRoot()
    return serveOnce(root, path.relative(root, file))
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
