import type { StateCreator } from 'zustand'
import type { ExplorerSortBy, FileNode } from '@shared/types'
import type { FileTemplate } from '../file-templates'
import { templateContent } from '../file-templates'
import { baseName, explorerOf, parentDirOf, sortNodesBy } from './explorer-helpers'
import { isDescendantOf } from '../components/file-tree/shared'
import type { AppState, TreeSlice } from './types'

/**
 * 文件树 slice：工作区、目录缓存、增删改名移动、拖拽、引用。
 *
 * 依赖会话 slice（要它记日志、要它刷新快照），但不被会话 slice 依赖。
 */

export const createTreeSlice: StateCreator<AppState, [], [], TreeSlice> = (set, get) => ({
  workspace: '',
  workspaces: [],
  childMap: {},
  expanded: {},
  treeOpen: true,
  selectedPath: '',
  dragPath: '',
  dropTarget: '',
  pendingRefs: [],
  previewRequestAt: '',
  split: 0.62,

  /** 左侧栏里的文件树展开/收起。写进配置，重启后保持 */
  async setTreeOpen(treeOpen) {
    set({ treeOpen })
    const saved = await window.api.setConfig({ explorer: { ...explorerOf(get().config), treeOpen } })
    set({ config: saved })
  },

  /** 对话栏展开/收起。收起后编辑器撑满内容区 */
  async setChatOpen(chatOpen) {
    const saved = await window.api.setConfig({ explorer: { ...explorerOf(get().config), chatOpen } })
    set({ config: saved })
  },

  /**
   * 侧栏上下分割的比例（工作空间 / 文件树）。
   *
   * 落盘夹取由主进程的 normalizeExplorer 负责（与界面拖动用同一组常量），
   * 所以这里不再夹一次 —— 两处都夹的话，以后改常量容易只改一处，
   * 表现为「拖到某个位置松手后弹回另一个值」。
   */
  async setSidebarSplit(sidebarSplit) {
    const saved = await window.api.setConfig({ explorer: { ...explorerOf(get().config), sidebarSplit } })
    set({ config: saved })
  },

  select(path) {
    set({ selectedPath: path })
  },

  async loadRoot(dir) {
    try {
      const nodes = await window.api.readDir(dir)
      set({ workspace: dir, childMap: { ...get().childMap, [dir]: nodes } })
      void get().refreshSnapshots()
    } catch (err) {
      get().pushLog({ time: '', level: 'error', scope: 'tree', text: `读取目录失败: ${String(err)}` })
    }
  },

  async openWorkspace() {
    // 先守卫再弹系统目录对话框：反过来会在学生选完目录后才拦他，
    // 那次选择就白做了
    if (!(await get().confirmLeaveWorkspace())) return
    const dir = await window.api.openWorkspace()
    if (!dir) return
    // 换工作区等于换项目：清掉上一个项目的文件树与打开过的标签，避免串味
    set({ childMap: {}, expanded: {}, selectedPath: '', tabs: [], activePath: '' })
    await get().loadRoot(dir)
    set({ workspaces: await window.api.listWorkspaces() })
    get().persistEditorSession()
  },

  async openWorkspaceAt(dir) {
    if (!(await get().confirmLeaveWorkspace())) return
    const opened = await window.api.openWorkspace(dir)
    if (!opened) return
    set({ childMap: {}, expanded: {}, selectedPath: '', tabs: [], activePath: '' })
    await get().loadRoot(opened)
    set({ workspaces: await window.api.listWorkspaces() })
    get().persistEditorSession()
  },

  async removeWorkspace(dir) {
    set({ workspaces: await window.api.removeRecentWorkspace(dir) })
  },

  async refreshDir(dir) {
    try {
      const nodes = await window.api.readDir(dir)
      set({ childMap: { ...get().childMap, [dir]: nodes } })
    } catch (err) {
      get().pushLog({ time: '', level: 'error', scope: 'tree', text: `刷新失败: ${String(err)}` })
    }
  },

  async toggleDir(dir) {
    const expanded = { ...get().expanded }
    if (expanded[dir]) {
      expanded[dir] = false
      set({ expanded })
      return
    }
    expanded[dir] = true
    set({ expanded })
    if (!get().childMap[dir]) await get().refreshDir(dir)
  },

  collapseAll() {
    const workspace = get().workspace
    // 根目录本身保持展开：全折叠之后文件树剩一行，学生容易以为坏了
    set({ expanded: workspace ? { [workspace]: true } : {} })
  },

  async createEntry(parent, name, kind) {
    try {
      const created = await window.api.createEntry(parent, name, kind)
      get().pushLog({
        time: '',
        level: 'info',
        scope: 'tree',
        text: `已新建${kind === 'dir' ? '文件夹' : '文件'} ${created}`
      })
      await get().refreshDir(parent)
      set({ expanded: { ...get().expanded, [parent]: true }, selectedPath: created })
      // 新建的文件直接打开，省一次双击 —— 这是「新建文件」最常见的意图
      if (kind === 'file') await get().openFile(created)
      return created
    } catch (err) {
      get().pushLog({ time: '', level: 'error', scope: 'tree', text: `新建失败: ${String(err)}` })
      throw err
    }
  },

  /**
   * 按模板新建文件。
   *
   * 顺序是「建空文件 → 写模板 → 打开」：
   * 写内容必须等 createEntry 成功拿到真实路径之后，否则会写到不存在的目录里去。
   * 写完再 openFile —— openFile 是先从磁盘读的，先打开会读到空内容，
   * 而且后续 writeFile 触发的外部变化会把刚写的内容标记成「被改过」。
   */
  async createFromTemplate(parent, template, name) {
    const created = await get().createEntry(parent, name, 'file')
    const content = templateContent(template)
    if (!content) return created
    try {
      await window.api.writeFile(created, content)
      // 磁盘内容变了，把已经打开的标签同步成模板内容。
      // 不重读文件：这里我们确切知道刚写了什么，再读一次反而多一次 IO 与竞态窗口。
      set({
        tabs: get().tabs.map((t) =>
          t.path === created ? { ...t, content, dirty: false, aiTouchedAt: '' } : t
        )
      })
      get().pushLog({
        time: '',
        level: 'info',
        scope: 'tree',
        text: `已写入 ${template.label} 初始模板 ${baseName(created)}`
      })
      void get().refreshSnapshots()
    } catch (err) {
      // 文件已经建出来了，只是模板没写进去 —— 这不算失败，但必须说出来，
      // 否则学生看到一个空文件会以为模板功能坏了
      get().pushLog({
        time: '',
        level: 'warn',
        scope: 'tree',
        text: `模板内容写入失败（文件已创建）: ${String(err)}`
      })
    }
    return created
  },

  async renameEntry(target, newName) {
    try {
      const renamed = await window.api.rename(target, newName)
      get().pushLog({ time: '', level: 'info', scope: 'tree', text: `已重命名为 ${renamed}` })
      // 打开过的标签路径也要跟着改，否则再点一次会开出第二个同名标签
      set({
        tabs: get().tabs.map((t) =>
          t.path === target ? { ...t, path: renamed, name: baseName(renamed) } : t
        ),
        activePath: get().activePath === target ? renamed : get().activePath,
        selectedPath: renamed
      })
      // 改的是目录时，它子孙目录的缓存路径全部失效 —— 不清就是幽灵文件
      get().forgetSubtrees(target)
      await get().refreshDir(parentDirOf(target))
      get().persistEditorSession()
      return renamed
    } catch (err) {
      get().pushLog({ time: '', level: 'error', scope: 'tree', text: `重命名失败: ${String(err)}` })
      throw err
    }
  },

  /**
   * 把一个文件/目录移到另一个目录下。
   *
   * 和 renameEntry 是两件事，所以不合并：rename 只改末级名字、父目录不变；
   * move 换父目录、名字不变。合并会得到一个「有时改这个有时改那个」的接口，
   * 而 UI 上它们是两个不同的动作（拖拽落点 vs 弹层输入）。
   */
  async moveEntry(from, destDir) {
    try {
      const moved = await window.api.moveEntry(from, destDir)
      if (moved === from) return moved
      get().pushLog({
        time: '',
        level: 'info',
        scope: 'tree',
        text: `已移动 ${baseName(from)} → ${destDir}`
      })

      /*
       * 打开着的标签要跟着改路径。
       *
       * 分两种：移动的是单个文件（精确匹配），还是整个目录
       * （它下面所有打开的标签都要按前缀改）。
       * 不处理目录这一种的话，移完目录后那些标签的路径全部指向旧位置，
       * 下一次保存会在旧路径上**重新建出**一个文件 —— 看起来像移动失败。
       */
      const movedDir = from.endsWith('/') || from.endsWith('\\')
      set({
        tabs: get().tabs.map((t) => {
          if (t.path === from) return { ...t, path: moved, name: baseName(moved) }
          if (movedDir && t.path.startsWith(from)) {
            const next = moved + t.path.slice(from.length)
            return { ...t, path: next, name: baseName(next) }
          }
          return t
        }),
        activePath:
          get().activePath === from
            ? moved
            : movedDir && get().activePath.startsWith(from)
              ? moved + get().activePath.slice(from.length)
              : get().activePath,
        selectedPath: moved
      })

      // 子孙目录缓存失效（移动目录时）
      get().forgetSubtrees(from)
      await Promise.all([
        get().refreshDir(parentDirOf(from)),
        get().refreshDir(moved ? parentDirOf(moved) : destDir)
      ])
      get().persistEditorSession()
      return moved
    } catch (err) {
      get().pushLog({ time: '', level: 'error', scope: 'tree', text: `移动失败: ${String(err)}` })
      throw err
    }
  },

  async removeEntry(target) {
    try {
      await window.api.remove(target)
      get().pushLog({ time: '', level: 'warn', scope: 'tree', text: `已移入回收站 ${target}` })
      // 删掉的东西如果正开着，标签也得关掉，否则保存会把它写回来。
      // 目录被删时它下面所有标签都要关 —— 只按精确路径匹配的话，
      // 那些标签会留在界面上，一点保存就把刚删掉的目录建回来
      const doomed = get().tabs.filter(
        (t) =>
          t.path === target ||
          t.path.startsWith(`${target}/`) ||
          t.path.startsWith(`${target}\\`)
      )
      const doomedPaths = new Set(doomed.map((t) => t.path))
      const tabs = get().tabs.filter((t) => !doomedPaths.has(t.path))
      let activePath = get().activePath
      if (doomedPaths.has(activePath)) {
        activePath = tabs.length ? tabs[tabs.length - 1].path : ''
      }
      set({ tabs, activePath })

      if (doomedPaths.has(get().selectedPath) || get().selectedPath === target) {
        set({ selectedPath: '' })
      }
      // 目录删掉后，它子孙目录的缓存必须一并清掉
      get().forgetSubtrees(target)
      await get().refreshDir(parentDirOf(target))
      get().persistEditorSession()
      return true
    } catch (err) {
      get().pushLog({ time: '', level: 'error', scope: 'tree', text: `删除失败: ${String(err)}` })
      throw err
    }
  },

  /**
   * 让某个目录的整棵子树的缓存失效。
   *
   * 为什么必须有这个：`childMap` 是「路径 → 该目录的子项」的缓存，
   * `toggleDir` 靠 `if (!childMap[dir])` 判断「这个目录加载过没有」。
   * 当你删掉/搬走一个目录后又建了一个同名目录，那个 key 还在，
   * 展开时就会被判定为「已加载」而**直接显示旧内容** —— 幽灵文件。
   *
   * 对文件调用它也无害（没有以它为前缀的 key，等于什么都不做）。
   */
  forgetSubtrees(root) {
    const prefixSlash = `${root}/`
    const prefixBack = `${root}\\`
    const childMap = { ...get().childMap }
    const expanded = { ...get().expanded }
    let changed = false
    for (const key of Object.keys(childMap)) {
      if (key.startsWith(prefixSlash) || key.startsWith(prefixBack)) {
        delete childMap[key]
        changed = true
      }
    }
    for (const key of Object.keys(expanded)) {
      if (key.startsWith(prefixSlash) || key.startsWith(prefixBack)) {
        delete expanded[key]
        changed = true
      }
    }
    if (changed) set({ childMap, expanded })
  },

  async setSortBy(sortBy: ExplorerSortBy) {
    // 只写配置，不碰 childMap：排序在渲染层按当前偏好实时算，
    // 重新读盘在这里是纯粹的浪费（而且机械盘上是一次实打实的卡顿）
    const saved = await window.api.setConfig({ explorer: { ...explorerOf(get().config), sortBy } })
    set({ config: saved })
  },

  async setShowHidden(showHidden) {
    const saved = await window.api.setShowHidden(showHidden)
    set({ config: saved })
    // 隐藏项变化会改变每个目录的内容，整棵树重读一遍最省事也最不容易漏
    const childMap = get().childMap
    const dirs = Object.keys(childMap).filter((dir) => Boolean(childMap[dir]))
    for (const dir of dirs) await get().refreshDir(dir)
  },

  setSplit(split) {
    set({ split })
    // 拖动结束后才走到这里（useSplitter 松手才提交），所以直接落盘不会写爆磁盘
    get().persistEditorSession()
  },

  /* ---------------- 拖拽移动 ---------------- */

  beginDrag(path) {
    set({ dragPath: path, dropTarget: '' })
  },

  hoverDropTarget(dir) {
    if (get().dropTarget === dir) return
    set({ dropTarget: dir })
  },

  endDrag() {
    if (!get().dragPath && !get().dropTarget) return
    set({ dragPath: '', dropTarget: '' })
  },

  /**
   * 放下：把 from 移进 dir。
   *
   * 这里做的是**界面层的合法性过滤**，非法的情况直接静默返回 —
   * 权威守卫在主进程的 wsMove（渲染层的路径不可信），
   * 这一层只是为了不给用户弹一堆「这个操作本来就不该允许」的报错。
   */
  async dropOn(from, dir) {
    if (!from || !dir) return
    // 拖到自己所在的目录 = 没动。静默忽略，不报错也不写日志
    if (parentDirOf(from) === dir) return
    // 拖进自己的子孙 = 非法
    if (isDescendantOf(dir, from)) {
      get().pushLog({
        time: '',
        level: 'warn',
        scope: 'tree',
        text: '不能把一个文件夹移动到它自己里面'
      })
      return
    }
    // 拖到自己身上
    if (from === dir) return
    try {
      await get().moveEntry(from, dir)
      // 移完之后把落点展开，让学生看到东西确实进去了 ——
      // 否则移到折叠的目录里，界面看起来和「消失了」一样
      set({ expanded: { ...get().expanded, [dir]: true } })
      await get().refreshDir(dir)
    } catch {
      // moveEntry 内部已经记了一条 error 日志，这里不重复弹
    }
  },

  /* ---------------- 引用 ---------------- */

  insertReference(file) {
    set({ pendingRefs: [...get().pendingRefs, file] })
  },

  consumeRefs() {
    const refs = get().pendingRefs
    if (refs.length) set({ pendingRefs: [] })
    return refs
  },

  /**
   * 请求预览某个文件。
   *
   * 先把标签打开（openFile 内部对已打开的会直接激活），
   * 再发通知 —— 预览面板跟着 activePath 走，所以必须先切标签。
   * 顺序反了的话面板会先渲染旧文件，再被下一次渲染换掉，闪一下。
   */
  requestPreview(file) {
    void get().openFile(file)
    set({ previewRequestAt: String(Date.now()) })
  }
})

/** 供 tree slice 内部使用：把节点按当前排序偏好排好（转出给组件用） */
export function sortedChildren(nodes: FileNode[], sortBy: ExplorerSortBy): FileNode[] {
  return sortNodesBy(nodes, sortBy)
}

export type { FileTemplate }
