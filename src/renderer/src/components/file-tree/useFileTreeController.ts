import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ExplorerSortBy, FileNode } from '@shared/types'
import { useAppStore, sortNodesBy } from '../../store/useAppStore'
import type { FileTemplate } from '../../file-templates'
import type { NewEntryTarget } from '../NewEntryDialog'
import { baseName, existingNamesOf, parentDirOf } from './shared'
import { buildTreeMenu, canPreview, type TreeMenuItem, type TreeMenuTarget } from './tree-menu'

/**
 * 文件树的全部交互逻辑。
 *
 * 抽成 hook 是为了让「侧栏嵌入树」与「内容区资源管理器」**共用同一份行为**：
 * 两种形态只是外壳不同（一个在窄栏里、一个占整页），
 * 右键菜单、弹层、排序、落点计算必须完全一致，
 * 否则很快就会出现「这边能建 html、那边不能」这种割裂。
 */

/** 一次「新建」请求：类型 + 落点 */
export type NewEntryRequest = {
  kind: 'file' | 'dir'
  target: NewEntryTarget
}

/** 一次「重命名」请求 */
export type RenameRequest = { path: string }

/** 一次「移动到…」请求：要移动的路径 */
export type MoveRequest = { path: string }

/** 右键菜单的定位与落点状态 */
export type MenuState = {
  x: number
  y: number
  /** 菜单实际显示的位置（越界时往回挪过），由 useMenuPosition 计算 */
  target: TreeMenuTarget
}

export type FileTreeController = {
  /** 已按当前偏好排好序的顶层节点，直接渲染 */
  sortedRoot: FileNode[]
  /** 整棵树是否为空（工作区已打开、但一个可见项都没有） */
  isEmpty: boolean
  sortBy: ExplorerSortBy
  showHidden: boolean
  workspace: string
  menu: MenuState | null
  menuItems: TreeMenuItem[]
  newEntry: NewEntryRequest | null
  rename: RenameRequest | null
  /** 「移动到…」弹层：非 null 时显示目录选择器 */
  move: MoveRequest | null
  /** 发起「新建」。parent 不给就是项目根目录（Sidebar 用的就是这个形态） */
  requestNew: (kind: 'file' | 'dir', parent?: string) => void
  closeNewEntry: () => void
  /** 提交新建。返回空串表示成功，否则是中文失败原因 */
  submitNewEntry: (name: string, template: FileTemplate | undefined) => Promise<string>
  /** 提交重命名。返回空串表示成功，否则是中文失败原因 */
  submitRename: (name: string) => Promise<string>
  closeRename: () => void
  /** 提交「移动到…」。返回空串表示成功，否则是中文失败原因 */
  submitMove: (destDir: string) => Promise<string>
  closeMove: () => void
  onContextMenu: (e: React.MouseEvent) => void
  closeMenu: () => void
  setSortBy: (sortBy: ExplorerSortBy) => void
  /** 切换「显示隐藏文件」。写到配置并重读所有已展开目录 */
  toggleHidden: () => void
  /** 面包屑：从磁盘根到当前目录，末两段起（太长时前面省略） */
  crumbs: Array<{ name: string; path: string }>
  /** 刷新当前目录 */
  refresh: () => void
  /** 是否有可预览的 HTML（菜单置灰依据，导出便于容器显示提示） */
  canPreviewTarget: boolean
}

/**
 * 计算「新建落点」。
 *
 * 语义固定为三条：
 *   - 右键文件夹 → 进那个文件夹（这正是「建完文件夹接着建 html」要的行为）
 *   - 右键文件    → 落到它同级的目录
 *   - 右键空白    → 落项目根目录
 * 只能有一处实现：两种形态各自算一遍，早晚会跑偏。
 */
export function resolveParentDir(target: TreeMenuTarget, workspace: string): string {
  if (!target.path) return workspace
  if (target.kind === 'dir') return target.path
  return parentDirOf(target.path) || workspace
}

/** 落点的显示标签：相对路径，太长时只留末两段（侧栏只有 232px 宽） */
export function labelOf(dir: string): string {
  const parts = dir.split(/[\\/]/).filter(Boolean)
  if (parts.length <= 2) return parts.join(' / ')
  return `… / ${parts.slice(-2).join(' / ')}`
}

/** 取父目录下已有的名字，供弹层即时重名校验 */
function takenNames(dir: string): string[] {
  return existingNamesOf(dir)
}

export function useFileTreeController(): FileTreeController {
  const workspace = useAppStore((s) => s.workspace)
  const childMap = useAppStore((s) => s.childMap)
  const showHidden = useAppStore((s) => Boolean(s.config?.explorer.showHidden))
  const sortBy = useAppStore((s) => s.config?.explorer.sortBy || 'name')
  const refreshDir = useAppStore((s) => s.refreshDir)
  const createEntry = useAppStore((s) => s.createEntry)
  const createFromTemplate = useAppStore((s) => s.createFromTemplate)
  const renameEntry = useAppStore((s) => s.renameEntry)
  const moveEntry = useAppStore((s) => s.moveEntry)
  const removeEntry = useAppStore((s) => s.removeEntry)
  const setShowHidden = useAppStore((s) => s.setShowHidden)
  const setSortBy = useAppStore((s) => s.setSortBy)
  const pushLog = useAppStore((s) => s.pushLog)

  const [menu, setMenu] = useState<MenuState | null>(null)
  const [newEntry, setNewEntry] = useState<NewEntryRequest | null>(null)
  const [rename, setRename] = useState<RenameRequest | null>(null)
  const [move, setMove] = useState<MoveRequest | null>(null)
  /** 防止连点两次弹出两个弹层 */
  const busyRef = useRef(false)

  const rootChildren = workspace ? childMap[workspace] : undefined

  /** 只对当前这一层排序：不递归、不预读子目录（机械盘上整树扫描会卡主进程） */
  const sortedRoot = useMemo(
    () => sortNodesBy(rootChildren || [], sortBy),
    [rootChildren, sortBy]
  )

  const isEmpty = Boolean(workspace) && sortedRoot.length === 0

  /** 面包屑：末 4 段。全部列出在窄栏里会挤成一行点，前面省略更实用 */
  const crumbs = useMemo(() => {
    if (!workspace) return []
    const sep = workspace.includes('\\') ? '\\' : '/'
    const parts = workspace.split(/[\\/]/).filter(Boolean)
    const out: Array<{ name: string; path: string }> = []
    let acc = ''
    parts.forEach((part, index) => {
      // 第一段是盘符（C:）或根（空）。盘符后面必须补反斜杠，
      // 否则拼出来 `C:Users...` 这种相对路径，点开一定是错的
      if (index === 0) acc = sep === '\\' ? `${part}\\` : `/${part}`
      else acc = acc.endsWith(sep) ? `${acc}${part}` : `${acc}${sep}${part}`
      out.push({ name: part, path: acc })
    })
    return out.slice(-4)
  }, [workspace])

  const target: TreeMenuTarget = menu?.target || { path: '', kind: '' }
  const parentDir = resolveParentDir(target, workspace)

  /* ---------------- 弹层 ---------------- */

  const requestNew = useCallback(
    (kind: 'file' | 'dir', parent?: string) => {
      const dir = parent || workspace
      if (!dir) {
        pushLog({ time: '', level: 'warn', scope: 'tree', text: '还没有打开项目，无法新建' })
        return
      }
      setNewEntry({
        kind,
        target: { parent: dir, parentLabel: labelOf(dir), existing: takenNames(dir) }
      })
    },
    [workspace, pushLog]
  )

  const closeNewEntry = useCallback(() => setNewEntry(null), [])

  /**
   * 提交新建。
   *
   * 失败返回中文原因而不是抛错：弹层要把原因显示在自己身上。
   * 关掉弹层再只写一条日志，就等于回到最初那个「点了没反应」的体验。
   */
  const submitNewEntry = useCallback(
    async (name: string, template: FileTemplate | undefined): Promise<string> => {
      if (!newEntry) return ''
      if (busyRef.current) return '正在处理上一步，请稍候'
      busyRef.current = true
      try {
        if (newEntry.kind === 'file' && template) {
          await createFromTemplate(newEntry.target.parent, template, name)
        } else {
          await createEntry(newEntry.target.parent, name, newEntry.kind)
        }
        setNewEntry(null)
        return ''
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        // store 里已经记了一条「新建失败」，这里补上用户填的名字 ——
        // 否则日志只有路径，学生认不出是自己哪一次操作
        pushLog({ time: '', level: 'error', scope: 'tree', text: `新建「${name}」失败: ${msg}` })
        return `创建失败：${msg}`
      } finally {
        busyRef.current = false
      }
    },
    [newEntry, createEntry, createFromTemplate, pushLog]
  )

  const closeRename = useCallback(() => setRename(null), [])

  const closeMove = useCallback(() => setMove(null), [])

  /**
   * 提交「移动到…」。
   *
   * 与 submitRename 同样把失败原因**返回**而不是抛出去 ——
   * 弹层要把原因显示在自己身上。关掉弹层再只写一条日志，
   * 就回到了最初那个「点了没反应」的体验。
   */
  const submitMove = useCallback(
    async (destDir: string): Promise<string> => {
      if (!move) return ''
      if (busyRef.current) return '正在处理上一步，请稍候'
      busyRef.current = true
      try {
        await moveEntry(move.path, destDir)
        setMove(null)
        return ''
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return `移动失败：${msg}`
      } finally {
        busyRef.current = false
      }
    },
    [move, moveEntry]
  )

  const submitRename = useCallback(
    async (name: string): Promise<string> => {
      if (!rename) return ''
      if (busyRef.current) return '正在处理上一步，请稍候'
      const current = baseName(rename.path)
      if (name === current) {
        // 名字没变就直接关掉。当成成功而不是报错 —— 用户按了回车但什么也没改，
        // 弹一个「名称未变化」是纯噪音
        setRename(null)
        return ''
      }
      busyRef.current = true
      try {
        await renameEntry(rename.path, name)
        setRename(null)
        return ''
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        pushLog({ time: '', level: 'error', scope: 'tree', text: `重命名「${current}」失败: ${msg}` })
        return `重命名失败：${msg}`
      } finally {
        busyRef.current = false
      }
    },
    [rename, renameEntry, pushLog]
  )

  /* ---------------- 右键菜单 ---------------- */
  const onContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    const el = (e.target as HTMLElement).closest('[data-path]') as HTMLElement | null
    const path = el?.dataset.path || ''
    if (path) useAppStore.getState().select(path)
    setMenu({ x: e.clientX, y: e.clientY, target: { path, kind: el?.dataset.kind || '' } })
  }, [])

  const closeMenu = useCallback(() => setMenu(null), [])

  /** 关菜单：点任意处 / Esc / 窗口尺寸变化。
   *  用 mousedown 而非 click —— 菜单项自己的 click 会先冒泡到这里把菜单关掉，
   *  导致「点了没反应」 */
  useEffect(() => {
    if (!menu) return
    const close = (): void => setMenu(null)
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') close()
    }
    document.addEventListener('mousedown', close)
    document.addEventListener('keydown', onKey)
    window.addEventListener('resize', close)
    return () => {
      document.removeEventListener('mousedown', close)
      document.removeEventListener('keydown', onKey)
      window.removeEventListener('resize', close)
    }
  }, [menu])

  const doCopyPath = useCallback((): void => {
    if (!target.path) return
    const value = target.path
    void navigator.clipboard.writeText(value).then(
      () => pushLog({ time: '', level: 'info', scope: 'tree', text: `已复制路径 ${value}` }),
      // 剪贴板失败极少见，但降级不能用 prompt —— Electron 里它根本不存在，
      // 反而会再抛一次错。改成写进日志，学生至少能看见并手动复制
      () =>
        pushLog({
          time: '',
          level: 'warn',
          scope: 'tree',
          text: `自动复制失败，路径是：${value}（可在输出面板选中复制）`
        })
    )
  }, [target.path, pushLog])

  const menuItems = useMemo((): TreeMenuItem[] => {
    if (!menu) return []
    return buildTreeMenu(
      { target, workspace, parentDir, showHidden, sortBy },
      {
        onPreview: () => void window.api.previewInBrowser(target.path),
        onNewFile: () => requestNew('file', parentDir),
        onNewDir: () => requestNew('dir', parentDir),
        onRename: () => setRename({ path: target.path }),
        onMove: () => setMove({ path: target.path }),
        onDelete: () => {
          if (!target.path) return
          const name = baseName(target.path)
          // confirm 在 Electron 里是可用的（只有 prompt 被移除）
          if (!window.confirm(`确定删除「${name}」？\n\n会先移入回收目录，不会立刻永久删除。`)) return
          void removeEntry(target.path)
        },
        onToggleHidden: () => void setShowHidden(!showHidden),
        onCopyPath: doCopyPath,
        onReveal: () => void window.api.revealInOs(target.path),
        onInsertRef: () => {
          useAppStore.getState().insertReference(target.path)
          pushLog({ time: '', level: 'info', scope: 'tree', text: `已插入引用 ${target.path}` })
        },
        onRefresh: () => void refreshDir(parentDir || workspace),
        onSort: (next) => void setSortBy(next)
      }
    )
  }, [
    menu,
    target,
    workspace,
    parentDir,
    showHidden,
    sortBy,
    requestNew,
    doCopyPath,
    removeEntry,
    setShowHidden,
    setSortBy,
    refreshDir,
    pushLog
  ])

  return {
    sortedRoot,
    isEmpty,
    sortBy,
    showHidden,
    workspace,
    menu,
    menuItems,
    newEntry,
    rename,
    move,
    requestNew,
    closeNewEntry,
    submitNewEntry,
    submitRename,
    closeRename,
    submitMove,
    closeMove,
    onContextMenu,
    closeMenu,
    setSortBy: (next) => void setSortBy(next),
    toggleHidden: () => void setShowHidden(!showHidden),
    crumbs,
    refresh: () => void refreshDir(workspace),
    canPreviewTarget: canPreview(target)
  }
}
