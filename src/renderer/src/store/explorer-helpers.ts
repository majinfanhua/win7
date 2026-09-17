import type { AppConfig, EditorSession, ExplorerConfig, ExplorerSortBy, FileNode, OpenTab } from '@shared/types'
import { DEFAULT_CONFIG, EDITOR_TABS_MAX, SESSION_TITLE_MAX } from '@shared/types'

/**
 * 文件树相关的纯函数（排序 / 扩展名 / 路径）。
 *
 * 从 useAppStore.ts 里抽出来，原因有两个：
 *   1. 那个文件已经到 800 行的红线附近，而这些函数与 store 的
 *      「状态 + 动作」无关，只是纯粹的取值 / 排序 / 归一化
 *   2. 排序与扩展名判定同时被工具栏、菜单、节点三处用到，
 *      放在 store 文件里会让「谁引谁」变得别扭
 *
 * 这里不 import zustand，也不持有任何状态 —— 纯函数才能被随意复用。
 */

/** 取扩展名（小写、不带点）。没有扩展名或只有扩展名时返回空串 */
export function extOf(name: string): string {
  const idx = name.lastIndexOf('.')
  return idx > 0 ? name.slice(idx + 1).toLowerCase() : ''
}

/** 取路径末段（文件名 / 目录名），跨平台 */
export function baseName(filePath: string): string {
  const parts = filePath.split(/[\\/]/)
  return parts[parts.length - 1] || filePath
}

/** 取父目录，跨平台。没有分隔符时返回原值 */
export function parentDirOf(target: string): string {
  const idx = Math.max(target.lastIndexOf('/'), target.lastIndexOf('\\'))
  return idx > 0 ? target.slice(0, idx) : target
}

/**
 * 取当前配置里的 explorer 段，缺字段时给默认值。
 *
 * 收敛到一处是为了防止「只改 treeOpen 却把 chatOpen 冲成 undefined」——
 * setConfig 是整体替换 explorer 对象的，漏一个字段就会把它清掉。
 * 所以这里直接复用共享的 DEFAULT_CONFIG.explorer，加字段时不用改两处。
 */
export function explorerOf(config: AppConfig | null): ExplorerConfig {
  return config?.explorer || DEFAULT_CONFIG.explorer
}

/**
 * 按当前排序方式整理一个目录的节点。
 *
 * 只对「已经读出来的这一层」排序，不递归、不预读子目录：
 * 排序偏好要立刻可见，而遍历整棵树在 Win7 机械盘 + 杀软实时扫描下会把主进程拖死。
 *
 * 文件夹永远排在文件前面 —— 这一条与主进程 sortNodes 保持一致，
 * 否则换排序方式时目录会「跳」一下，看起来像文件被移动了。
 * 按名称时不重排：主进程已经用 localeCompare(name, 'zh-Hans-CN') 排过，
 * 再排一次只是白花时间，还可能因为排序规则细微差别把顺序弄乱。
 */
export function sortNodesBy(nodes: FileNode[], sortBy: ExplorerSortBy): FileNode[] {
  if (sortBy === 'name') return nodes
  const dirFirst = (a: FileNode, b: FileNode): number =>
    a.kind === b.kind ? 0 : a.kind === 'dir' ? -1 : 1
  return [...nodes].sort((a, b) => {
    const byKind = dirFirst(a, b)
    if (byKind !== 0) return byKind
    if (sortBy === 'type') {
      const ea = extOf(a.name)
      const eb = extOf(b.name)
      if (ea !== eb) return ea.localeCompare(eb, 'zh-Hans-CN')
      return a.name.localeCompare(b.name, 'zh-Hans-CN')
    }
    // mtime：新的在前。缺 mtime 的节点（旧版本主进程返的）当 0，
    // 稳定地排在最后，而不是随机插在中间
    return (b.mtime || 0) - (a.mtime || 0)
  })
}

/** 会话标题的截断长度。定义放在这里，是为了让 titleFrom 的调用方不用再引一次 shared/types */
export const TITLE_MAX = SESSION_TITLE_MAX

/** 从提问里截一个标题；空白提问给个兜底文案 */
export function titleFrom(text: string): string {
  const line = text.split('\n').find((item) => item.trim()) || ''
  const clean = line.replace(/\s+/g, ' ').trim()
  return clean ? clean.slice(0, TITLE_MAX) : '新会话'
}

/**
 * 把持久化的编辑器会话折算成「能直接用的标签数组」。
 *
 * 抽出理由：这里有三道上限与去重规则（路径唯一、总数封顶、跳过空路径），
 * 任何一条漏掉都会出现「重启后打开了两个同名标签」或
 * 「标签数超过上限把界面撑坏」。集中一处才不容易漏。
 */
export function tabsFromSession(session: EditorSession | null, workspace: string): OpenTab[] {
  const raw = session?.tabs || []
  const out: OpenTab[] = []
  const seen = new Set<string>()
  raw.forEach((tab) => {
    if (!tab.path || seen.has(tab.path)) return
    // 只恢复当前工作区里的文件：换了项目还把上一个项目的文件开回来会很困惑
    if (workspace && !tab.path.startsWith(workspace)) return
    if (out.length >= EDITOR_TABS_MAX) return
    seen.add(tab.path)
    out.push(tab)
  })
  return out
}
