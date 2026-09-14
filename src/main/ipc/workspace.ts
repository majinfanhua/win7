import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { BrowserWindow, dialog, ipcMain } from 'electron'
import { IPC, type FileNode, type LoadedFile } from '../../shared/types'
import { languageFromPath } from '../../shared/language'
import { getConfig, setConfig } from '../config'
import { logger } from '../logger'

/** 单文件读取上限，防止误开大文件把编辑器卡死 */
const MAX_FILE_BYTES = 4 * 1024 * 1024
/** 目录列表忽略项 */
const IGNORED = new Set(['node_modules', '.git', 'out', 'dist', '__pycache__', '.venv', 'venv', '.trash'])

let workspaceRoot = ''

export function getWorkspaceRoot(): string {
  return workspaceRoot
}

export function setWorkspaceRoot(root: string): void {
  workspaceRoot = root ? path.resolve(root) : ''
  setConfig({ lastWorkspace: workspaceRoot })
}

/** 所有文件操作必须落在工作区目录内，防止路径穿越 */
function assertInsideRoot(target: string): string {
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
      ? await dialog.showOpenDialog(win, { properties: ['openDirectory'], title: '选择教学项目目录' })
      : await dialog.showOpenDialog({ properties: ['openDirectory'], title: '选择教学项目目录' })
    if (result.canceled || !result.filePaths[0]) return ''
    setWorkspaceRoot(result.filePaths[0])
    logger.info('workspace', `打开工作区: ${workspaceRoot}`)
    return workspaceRoot
  })

  ipcMain.handle(IPC.wsReadDir, async (_e, dir: string): Promise<FileNode[]> => {
    const target = assertInsideRoot(dir)
    const entries = await fsp.readdir(target, { withFileTypes: true })
    return sortNodes(entries.filter((e) => !IGNORED.has(e.name)).map((e) => toNode(target, e)))
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
    // 先写临时文件再改名，避免写一半掉电导致源码损坏
    const tmp = `${target}.tmp-${process.pid}`
    await fsp.writeFile(tmp, content, 'utf8')
    await fsp.rename(tmp, target)
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
}

/** 启动时恢复上次的工作区 */
export function restoreLastWorkspace(): void {
  const last = getConfig().lastWorkspace
  if (last && fs.existsSync(last)) setWorkspaceRoot(last)
}
