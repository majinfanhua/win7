import { create } from 'zustand'
import type {
  AppConfig,
  EditorSession,
  ExplorerSortBy,
  FileChangeEvent,
  FileNode,
  LogLine,
  OpenTab,
  RuntimeInfo,
  SessionEntry,
  SnapshotSummary,
  StoredMessage,
  UndoOutcome,
  WorkspaceEntry
} from '@shared/types'
import { EDITOR_TABS_MAX } from '@shared/types'
import { languageFromPath } from '@shared/language'
import { templateContent, type FileTemplate } from '../file-templates'
import { baseName, explorerOf, parentDirOf as parentOf, titleFrom } from './explorer-helpers'
import { isDescendantOf } from '../components/file-tree/shared'

/**
 * 文件树排序与扩展名工具已经搬到 store/explorer-helpers.ts ——
 * 这里只安排一次转出，避免调用方要记住两个 import 路径。
 */
export { extOf, parentDirOf, sortNodesBy } from './explorer-helpers'

export interface EditorTab {
  path: string
  name: string
  content: string
  language: string
  dirty: boolean
  /**
   * 光标位置。
   *
   * 由 EditorPane 在切换/关闭前回写，用于「关掉再打开回到原处」和重启恢复。
   * 存 store 而不是 Monaco 自己管：Monaco 的 viewState 只活在它自己的实例里，
   * 标签切走时实例会被复用掉。
   */
  line: number
  column: number
  /**
   * 被 AI 工具改过、还没保存过的时间戳。
   *
   * 有值时编辑器顶栏显示「AI 已修改」＋撤销按钮，保存或撤销后清掉。
   */
  aiTouchedAt: string
}

/** 会话落盘与编辑器状态落盘的防抖句柄（模块级，见各自注释） */
let persistTimer: ReturnType<typeof setTimeout> | null = null
let editorSessionTimer: ReturnType<typeof setTimeout> | null = null

/** 「要保存吗」的三个选项 */
type UnsavedChoice = 'save' | 'discard' | 'cancel'

/**
 * 未保存改动的确认框。
 *
 * 用 window.confirm 而不是自绘弹层：Electron 里 confirm 是可用的
 * （只有 prompt 被移除，那是另一个坑），而这里只需要一个三选一。
 * confirm 只有两个按钮，所以把「丢弃」做成取消 —— 提示文案里写清楚，
 * 学生按「取消」= 不丢弃、留在原地，这是最安全的默认。
 *
 * 文案刻意把「丢弃」显式写出来：只问「要保存吗」的话，
 * 按「否」到底等于丢弃还是取消，学生根本没法判断。
 */
async function askUnsaved(what: string, opts?: { multiple?: boolean }): Promise<UnsavedChoice> {
  const body = opts?.multiple ? what : `「${what}」还有未保存的修改。\n`
  const save = window.confirm(`${body}\n点「确定」= 先保存再继续\n点「取消」= 不保存并放弃这些修改\n`)
  if (save) return 'save'
  // 二次确认才允许真的丢弃。一次 confirm 就把学生的代码删掉太廉价了
  const discard = window.confirm(
    `确定放弃${opts?.multiple ? '这些' : '这个'}文件的修改吗？\n\n放弃后内容无法找回（撤销记录里没有未保存的内容）。`
  )
  return discard ? 'discard' : 'cancel'
}

interface AppState {
  ready: boolean
  workspace: string
  workspaces: WorkspaceEntry[]
  sessions: SessionEntry[]
  /** 当前会话 id，发送第一条消息时分配 */
  sessionId: string
  /** 当前会话的消息列表。切换历史会话时整份替换 */
  messages: StoredMessage[]
  /** 正在读取历史会话正文，期间输入框可禁用 */
  sessionLoading: boolean
  childMap: Record<string, FileNode[]>
  expanded: Record<string, boolean>
  tabs: EditorTab[]
  activePath: string
  logs: LogLine[]
  runtime: RuntimeInfo | null
  config: AppConfig | null
  /**
   * 左侧栏里嵌的文件树是否展开。
   *
   * 与 chatOpen 一样从 config 读，不另存一份 state ——
   * 两份状态会分叉：改了一处另一处不跟着变，界面就会自相矛盾。
   */
  treeOpen: boolean
  /** 文件树里当前选中的路径，右键菜单作用于它 */
  selectedPath: string
  /**
   * 正在被拖拽的树节点路径（空串表示没有在拖）。
   *
   * 放 store 而不是组件 state：TreeNode 是递归渲染的，
   * 每个节点都要知道自己该不该显示成「可落点」，而拖拽起点在另一个节点里。
   * 放在最近的公共祖先（store）里，比一层层 prop 传下去干净得多。
   */
  dragPath: string
  /** 当前高亮的落点目录（拖拽经过时设置，离开或放下就清空） */
  dropTarget: string
  /** 被「插入引用」引用进输入框的文件，AiPanel 消费后清空 */
  pendingRefs: string[]
  /** 对话区占中间栏的比例，0~1 */
  split: number
  /**
   * 最近一次「切换会话」的时间戳。
   *
   * AiPanel 订阅它来中断在飞的请求 —— 见 openSession 的注释：
   * 带着一个未完成的流切会话，那个流收尾时会把内容写进**新**会话。
   * 用时间戳而不是布尔，是为了让「连续切两次」也能各触发一次 effect。
   */
  sessionSwitchAt: number
  /** 可撤销的修改记录（只含当前工作区） */
  snapshots: SnapshotSummary[]

  init: () => Promise<void>
  setTreeOpen: (open: boolean) => Promise<void>
  setChatOpen: (open: boolean) => Promise<void>
  select: (path: string) => void

  openWorkspace: () => Promise<void>
  openWorkspaceAt: (dir: string) => Promise<void>
  removeWorkspace: (dir: string) => Promise<void>
  loadRoot: (dir: string) => Promise<void>
  /** 重新读一遍某个目录（刷新 / 增删改名之后） */
  refreshDir: (dir: string) => Promise<void>
  toggleDir: (dir: string) => Promise<void>
  collapseAll: () => void

  openFile: (file: string, line?: number, column?: number) => Promise<void>
  setActive: (path: string) => void
  setContent: (path: string, content: string) => void
  setCursor: (path: string, line: number, column: number) => void
  saveActive: () => Promise<void>
  closeTab: (path: string) => void
  /** 用户主动关标签：脏就弹「保存 / 放弃 / 取消」 */
  closeTabChecked: (path: string) => Promise<'saved' | 'discarded' | 'cancelled'>
  /** 换项目前的守卫。false 表示用户取消了切换 */
  confirmLeaveWorkspace: () => Promise<boolean>

  /** 新建文件 / 文件夹，返回新路径（失败返回空串） */
  createEntry: (parent: string, name: string, kind: 'file' | 'dir') => Promise<string>
  /**
   * 按模板新建文件：先建空文件，再写骨架内容，最后自动打开。
   *
   * 之所以拆成「createEntry + writeFile」两步而不是新增一个 IPC：
   * writeFile 内部已经有「临时文件 + rename」的防掉电写与快照记录，
   * 复用它等于白拿这两件事，而且 shared/api、preload、主进程一行都不用改。
   */
  createFromTemplate: (parent: string, template: FileTemplate, name: string) => Promise<string>
  renameEntry: (target: string, newName: string) => Promise<string>
  /** 把文件/目录移到另一个目录下，返回新路径 */
  moveEntry: (from: string, destDir: string) => Promise<string>
  removeEntry: (target: string) => Promise<boolean>

  /* ---- 拖拽移动（文件树） ---- */
  /** 开始拖拽某个节点 */
  beginDrag: (path: string) => void
  /** 拖拽经过某个目录：更新高亮。传空串清掉高亮 */
  hoverDropTarget: (dir: string) => void
  /** 拖拽结束（无论有没有放下），清掉全部拖拽状态 */
  endDrag: () => void
  /** 放下：把 from 移进 dir。内部带全部合法性检查，非法时静默不动 */
  dropOn: (from: string, dir: string) => Promise<void>

  /**
   * 让某个目录整棵子树的 `childMap` / `expanded` 缓存失效。
   * 删目录、改名目录、移动目录之后都必须调，否则重名重建时会显示幽灵文件。
   */
  forgetSubtrees: (root: string) => void

  /** 切换文件树排序方式，写进配置，重启保持 */
  setSortBy: (sortBy: ExplorerSortBy) => Promise<void>
  setShowHidden: (showHidden: boolean) => Promise<void>
  setSplit: (split: number) => void

  /** 磁盘上的文件变了（AI 工具写的、或外部程序改的） */
  handleFileChanged: (event: FileChangeEvent) => Promise<void>
  /** 撤销 AI / 手工的最近一次修改 */
  undoLast: (path?: string) => Promise<UndoOutcome>

  startNewSession: () => void
  /** 记一条会话索引，发送第一条消息时调 */
  recordSession: (title: string, messageCount: number) => Promise<void>
  removeSession: (id: string) => Promise<void>
  /** 点开左侧一条历史会话：把正文读回 messages */
  openSession: (id: string) => Promise<void>
  /** 把当前 messages 落盘。消息变化后调，内部自己防抖 */
  persistSession: () => void
  /** 覆写当前会话的消息列表。流式回答期间会被反复调用，由调用方传完整文本 */
  setSessionMessages: (messages: StoredMessage[]) => void

  /** 编辑器状态落盘（打开过哪些文件、光标、分割比例），内部防抖 */
  persistEditorSession: () => void
  /** 立刻落盘，不等防抖。关窗时调 */
  flushEditorSession: () => Promise<boolean>
  /** 重新拉一次可撤销记录 */
  refreshSnapshots: () => Promise<void>

  pushLog: (line: LogLine) => void
  /** 清空日志抽屉。只清界面这一份，主进程的日志文件不动 */
  clearLogs: () => void
  loadConfig: () => Promise<void>
  applyConfig: (config: AppConfig) => void
  /** 把一个文件路径塞进输入框的引用队列 */
  insertReference: (file: string) => void
  consumeRefs: () => string[]
}

export const useAppStore = create<AppState>((set, get) => ({
  ready: false,
  workspace: '',
  workspaces: [],
  sessions: [],
  sessionId: '',
  messages: [],
  sessionLoading: false,
  childMap: {},
  expanded: {},
  // 初始为空。以前这里塞了一个虚拟的「欢迎.md」标签，
  // 但现在的欢迎页在对话区（AiPanel 的空态），编辑器再放一份就是重复，
  // 而且那个假标签导致标签栏、保存、编辑器三处都要写特例
  tabs: [],
  activePath: '',
  logs: [],
  runtime: null,
  config: null,
  treeOpen: true,
  selectedPath: '',
  pendingRefs: [],
  dragPath: '',
  dropTarget: '',
  split: 0.62,
  sessionSwitchAt: 0,
  snapshots: [],

  async init() {
    const [runtime, config, workspaces, sessions] = await Promise.all([
      window.api.runtime(),
      window.api.getConfig(),
      window.api.listWorkspaces(),
      window.api.listSessions()
    ])
    set({
      runtime,
      config,
      workspaces,
      sessions,
      treeOpen: config.explorer.treeOpen,
      split: config.editorSession.split,
      ready: true
    })
    // 上次的工作区在 main 侧已经恢复过了，这里把文件树真正读出来
    if (config.lastWorkspace) await get().loadRoot(config.lastWorkspace)
    // 恢复上次打开的文件。放在 loadRoot 之后：工作区没就绪时 readFile 会被拒绝
    await restoreTabs(config.editorSession)
  },

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

  select(path: string) {
    set({ selectedPath: path })
  },

  async loadRoot(dir: string) {
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

  async openWorkspaceAt(dir: string) {
    if (!(await get().confirmLeaveWorkspace())) return
    const opened = await window.api.openWorkspace(dir)
    if (!opened) return
    set({ childMap: {}, expanded: {}, selectedPath: '', tabs: [], activePath: '' })
    await get().loadRoot(opened)
    set({ workspaces: await window.api.listWorkspaces() })
    get().persistEditorSession()
  },

  async removeWorkspace(dir: string) {
    set({ workspaces: await window.api.removeRecentWorkspace(dir) })
  },

  async refreshDir(dir: string) {
    try {
      const nodes = await window.api.readDir(dir)
      set({ childMap: { ...get().childMap, [dir]: nodes } })
    } catch (err) {
      get().pushLog({ time: '', level: 'error', scope: 'tree', text: `刷新失败: ${String(err)}` })
    }
  },

  async toggleDir(dir: string) {
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

  async openFile(file, line = 1, column = 1) {
    const existing = get().tabs.find((t) => t.path === file)
    if (existing) {
      set({ activePath: file, selectedPath: file })
      return
    }
    try {
      const loaded = await window.api.readFile(file)
      const tab: EditorTab = {
        path: loaded.path,
        name: baseName(loaded.path),
        content: loaded.content,
        language: loaded.language || languageFromPath(loaded.path),
        dirty: false,
        line,
        column,
        aiTouchedAt: ''
      }
      // 标签数量有上限：无限开下去内存扛不住，而且标签栏会挤成一条线
      const tabs = [...get().tabs, tab].slice(-EDITOR_TABS_MAX)
      set({ tabs, activePath: loaded.path, selectedPath: loaded.path })
      get().persistEditorSession()
    } catch (err) {
      get().pushLog({ time: '', level: 'error', scope: 'file', text: `打开失败: ${String(err)}` })
    }
  },

  setActive(path: string) {
    set({ activePath: path })
    get().persistEditorSession()
  },

  setContent(path: string, content: string) {
    set({
      tabs: get().tabs.map((t) => (t.path === path ? { ...t, content, dirty: true } : t))
    })
  },

  setCursor(path: string, line: number, column: number) {
    const tab = get().tabs.find((t) => t.path === path)
    if (!tab || (tab.line === line && tab.column === column)) return
    set({
      tabs: get().tabs.map((t) => (t.path === path ? { ...t, line, column } : t))
    })
    get().persistEditorSession()
  },

  async saveActive() {
    const tab = get().tabs.find((t) => t.path === get().activePath)
    if (!tab) return
    try {
      await window.api.writeFile(tab.path, tab.content)
      set({
        tabs: get().tabs.map((t) =>
          // 保存后清掉「AI 改过」标记：学生已经看过并接受了这份内容
          t.path === tab.path ? { ...t, dirty: false, aiTouchedAt: '' } : t
        )
      })
      get().pushLog({ time: '', level: 'info', scope: 'file', text: `已保存 ${tab.path}` })
      void get().refreshSnapshots()
    } catch (err) {
      get().pushLog({ time: '', level: 'error', scope: 'file', text: `保存失败: ${String(err)}` })
    }
  },

  closeTab(path: string) {
    const tabs = get().tabs.filter((t) => t.path !== path)
    // 关掉当前标签时切到相邻的：优先它右边那个（浏览器行为），没有就取最后一个
    let activePath = get().activePath
    if (activePath === path) {
      const idx = get().tabs.findIndex((t) => t.path === path)
      const next = tabs[idx] || tabs[idx - 1] || tabs[tabs.length - 1]
      activePath = next ? next.path : ''
    }
    set({ tabs, activePath })
    get().persistEditorSession()
  },

  /**
   * 关标签，但先处理未保存的改动。
   *
   * 为什么单独一个动作而不是把守卫塞进 closeTab：
   * closeTab 还被「文件已删除」「重命名」这些**非用户主动**的路径调用，
   * 那些情况下弹一个「要保存吗」是纯粹的干扰。守卫只该挂在用户真的
   * 点了 × 这条路径上（见 EditorPane 的 onClose）。
   *
   * 返回 'saved'（已保存并关闭）/ 'discarded'（丢弃并关闭）/ 'cancelled'。
   */
  async closeTabChecked(path) {
    const tab = get().tabs.find((t) => t.path === path)
    if (!tab) return 'cancelled'
    if (!tab.dirty) {
      get().closeTab(path)
      return 'discarded'
    }
    const name = baseName(path)
    const choice = await askUnsaved(name)
    if (choice === 'cancel') return 'cancelled'
    if (choice === 'save') {
      // 保存到**这个**路径，不是 activePath —— 右键关一个非当前标签时两者不同
      try {
        await window.api.writeFile(path, tab.content)
        get().pushLog({ time: '', level: 'info', scope: 'file', text: `已保存 ${path}` })
        void get().refreshSnapshots()
      } catch (err) {
        get().pushLog({
          time: '',
          level: 'error',
          scope: 'file',
          text: `保存失败，标签未关闭: ${String(err)}`
        })
        // 保存失败就**不关**：关掉等于把内容丢了，而那正是这次守卫要防的事
        return 'cancelled'
      }
    }
    get().closeTab(path)
    return choice === 'save' ? 'saved' : 'discarded'
  },

  /**
   * 换工作区前的守卫。
   *
   * openWorkspace / openWorkspaceAt 会把 tabs 整个清空 —— 学生改了文件没存、
   * 顺手点了左侧另一个项目，改动就无声消失了。这和 README 里
   * 「绝不覆盖学生未保存改动」是同一条原则的两个面：那条守的是 AI 写入路径，
   * 这条守的是关闭路径。
   *
   * 返回 true 表示可以继续换。
   */
  async confirmLeaveWorkspace() {
    const dirty = get().tabs.filter((t) => t.dirty)
    if (dirty.length === 0) return true
    const names = dirty.map((t) => baseName(t.path)).join('、')
    const message =
      dirty.length === 1
        ? `「${names}」还有未保存的修改。`
        : `这 ${dirty.length} 个文件还有未保存的修改：\n${names}\n`
    const choice = await askUnsaved(message, { multiple: true })
    if (choice === 'cancel') return false
    if (choice === 'save') {
      let failed = 0
      for (const tab of dirty) {
        try {
          await window.api.writeFile(tab.path, tab.content)
        } catch (err) {
          failed++
          get().pushLog({
            time: '',
            level: 'error',
            scope: 'file',
            text: `保存 ${tab.path} 失败: ${String(err)}`
          })
        }
      }
      if (failed > 0) {
        // 有一个没存上就不能换 —— 换了这些标签就被清掉了，没存的内容再也找不回来
        get().pushLog({
          time: '',
          level: 'error',
          scope: 'file',
          text: `有 ${failed} 个文件保存失败，已取消切换项目。请先处理后重试。`
        })
        return false
      }
      void get().refreshSnapshots()
    }
    return true
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
      await get().refreshDir(parentOf(target))
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
      await Promise.all([get().refreshDir(parentOf(from)), get().refreshDir(moved ? parentOf(moved) : destDir)])
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

      if (doomedPaths.has(get().selectedPath) || get().selectedPath === target) set({ selectedPath: '' })
      // 目录删掉后，它子孙目录的缓存必须一并清掉
      get().forgetSubtrees(target)
      await get().refreshDir(parentOf(target))
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
    if (parentOf(from) === dir) return
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

  async setSortBy(sortBy) {
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

  /**
   * 磁盘文件变化处理。
   *
   * 分三种情况，因为「文件变了」在三处有不同的正确反应：
   *   1. 没打开 → 只在文件树/日志里体现
   *   2. 打开了、本地没改 → 静默重载，并标上「AI 改过」
   *   3. 打开了、本地有未保存改动 → 绝不覆盖！只提示，由学生决定
   *
   * 第 3 条是最关键的：AI 改了文件，而学生手里有没保存的编辑，
   * 这时把磁盘内容盖上去就等于把学生写的代码删了。宁可保留冲突让学生选。
   */
  async handleFileChanged(event) {
    const tab = get().tabs.find((t) => t.path === event.path)

    // 目录内容可能变了（新建/删除），刷一下它所在的目录
    void get().refreshDir(parentOf(event.path))
    if (event.origin === 'ai') void get().refreshSnapshots()

    if (!tab) {
      // 没打开的文件：只在日志里记一笔，不打扰学生
      if (event.origin === 'ai') {
        get().pushLog({
          time: '',
          level: 'info',
          scope: 'file',
          text: `AI 修改了 ${baseName(event.path)}（未在编辑器中打开）`
        })
      }
      return
    }

    if (tab.dirty) {
      // 本地有未保存的改动。不覆盖，只在日志里明确告诉学生怎么处理
      get().pushLog({
        time: '',
        level: 'warn',
        scope: 'file',
        text: `${baseName(event.path)} 在磁盘上被改过，但编辑器里有未保存的改动，已保留你的版本。保存会覆盖磁盘内容。`
      })
      return
    }

    // 静默重载：本地没有未保存改动，直接以磁盘为准
    try {
      const loaded = await window.api.readFile(event.path)
      if (loaded.content === tab.content) return
      set({
        tabs: get().tabs.map((t) =>
          t.path === event.path
            ? {
                ...t,
                content: loaded.content,
                language: loaded.language || t.language,
                dirty: false,
                // AI 改的才标出来。外部改动静默同步就好，弹一堆提示反而吵
                aiTouchedAt: event.origin === 'ai' ? event.at : ''
              }
            : t
        )
      })
      get().pushLog({
        time: '',
        level: 'info',
        scope: 'file',
        text: `${baseName(event.path)} 已自动重载${event.origin === 'ai' ? '（AI 修改）' : '（外部改动）'}`
      })
    } catch (err) {
      // 文件可能被删了。这种情况把标签关掉，比留一个保存就报错的标签好
      get().pushLog({
        time: '',
        level: 'warn',
        scope: 'file',
        text: `${baseName(event.path)} 已不可读，标签已关闭`
      })
      get().closeTab(event.path)
    }
  },

  async undoLast(path) {
    const result = await window.api.undoChange(path)
    if (result.ok) {
      get().pushLog({ time: '', level: 'info', scope: 'file', text: result.message })
      await get().refreshSnapshots()
      // 撤销会触发文件变化事件，重载由 handleFileChanged 负责，这里不重复读
    } else {
      get().pushLog({ time: '', level: 'warn', scope: 'file', text: result.message })
    }
    return result
  },

  startNewSession() {
    // 换新会话前先把旧的存下来，否则最后几句话会丢
    get().persistSession()
    set({
      sessionId: `s-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      messages: []
    })
  },

  async recordSession(title, messageCount) {
    let id = get().sessionId
    if (!id) {
      id = `s-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
      set({ sessionId: id })
    }
    const sessions = await window.api.touchSession({
      id,
      title: titleFrom(title),
      workspace: get().workspace,
      messageCount
    })
    set({ sessions })
  },

  async removeSession(id) {
    const sessions = await window.api.removeSession(id)
    // 删掉的正好是当前会话：清成新会话，否则接着发消息会把记录写回列表
    if (get().sessionId === id) {
      set({ sessionId: '', messages: [] })
    }
    set({ sessions })
  },

  /**
   * 点开左侧历史会话。
   *
   * 先把当前会话存盘再切 —— 否则「问了半句 → 点另一条会话 → 点回来」
   * 会发现刚才那句话不见了。
   *
   * 如果当前有流式回答在跑，**必须先中断**：
   * AiPanel 的 requestId 只认它自己发起的那个请求，切换会话后
   * `syncStore()` 仍会把这一轮的完整回答写进 `messages` —— 而那已经是
   * 另一条会话的容器了。结果是回答的尾部落进错误的会话记录里。
   * 中断这一步放在这里而不是 AiPanel：openSession 是「切会话」这件事的
   * 唯一入口，把守卫挂在入口上才不会有漏网的调用路径。
   */
  async openSession(id) {
    if (get().sessionId === id) return
    // 通知界面中断在飞的请求。用事件而不是直接 import AiPanel：
    // store 不该知道组件的存在，而 AiPanel 订阅这个计数器即可
    set({ sessionSwitchAt: Date.now() })
    get().persistSession()
    set({ sessionLoading: true })
    try {
      const stored = await window.api.loadSession(id)
      set({
        sessionId: id,
        // 读不到（文件被清理、旧版本没存正文）就是空对话，不弹错
        messages: stored ? stored.messages : []
      })
      if (!stored) {
        get().pushLog({
          time: '',
          level: 'warn',
          scope: 'session',
          text: `会话 ${id} 的正文不可读，已作为空对话打开`
        })
      }
    } finally {
      set({ sessionLoading: false })
    }
  },

  /**
   * 落盘当前会话。
   *
   * 防抖 400ms：流式回答期间 messages 每来一个 token 都会变，
   * 每次都整份写盘的话，一轮回答要写几百次几 MB 的文件。
   */
  persistSession() {
    // 只取 sessionId。messages 在 setTimeout 回调里重新 get() 拿，
    // 因为防抖期间可能又追加了新消息，用闭包里这份就是旧的
    const { sessionId } = get()
    if (!sessionId) return
    if (persistTimer) clearTimeout(persistTimer)
    persistTimer = setTimeout(() => {
      persistTimer = null
      const current = get()
      // 防抖期间用户可能又切了会话，写错文件就麻烦了
      if (current.sessionId !== sessionId) return
      if (!current.messages.length) return
      const title = titleFrom(
        current.messages.find((m) => m.role === 'user')?.text || current.sessionId
      )
      void window.api
        .saveSession({
          id: sessionId,
          title,
          workspace: current.workspace,
          updatedAt: new Date().toISOString(),
          messages: current.messages
        })
        .catch((err) => {
          current.pushLog({
            time: '',
            level: 'error',
            scope: 'session',
            text: `保存会话失败: ${err instanceof Error ? err.message : String(err)}`
          })
        })
    }, 400)
  },

  setSessionMessages(messages) {
    set({ messages })
    get().persistSession()
  },

  pushLog(line: LogLine) {
    const logs = [...get().logs, line]
    set({ logs: logs.length > 500 ? logs.slice(logs.length - 500) : logs })
  },

  clearLogs() {
    set({ logs: [] })
  },

  async loadConfig() {
    set({ config: await window.api.getConfig() })
  },

  applyConfig(config: AppConfig) {
    set({ config, treeOpen: config.explorer.treeOpen })
  },

  insertReference(file: string) {
    set({ pendingRefs: [...get().pendingRefs, file] })
  },

  consumeRefs() {
    const refs = get().pendingRefs
    if (refs.length) set({ pendingRefs: [] })
    return refs
  },

  /**
   * 编辑器状态落盘（防抖 600ms）。
   *
   * 开关标签、切标签、移光标都会触发，太频繁；
   * 600ms 能把这些密集操作合成一次写盘。
   */
  persistEditorSession() {
    if (editorSessionTimer) clearTimeout(editorSessionTimer)
    editorSessionTimer = setTimeout(() => {
      editorSessionTimer = null
      const { tabs, activePath, split } = get()
      const payload: EditorSession = {
        tabs: tabs.map((tab): OpenTab => ({ path: tab.path, line: tab.line, column: tab.column })),
        activePath,
        split
      }
      void window.api.setEditorSession(payload).catch(() => undefined)
    }, 600)
  },

  async refreshSnapshots() {
    try {
      set({ snapshots: await window.api.listSnapshots() })
    } catch {
      set({ snapshots: [] })
    }
  },

  /** 供测试与工具栏用：立刻把编辑器状态落盘，不等防抖 */
  flushEditorSession() {
    if (editorSessionTimer) {
      clearTimeout(editorSessionTimer)
      editorSessionTimer = null
    }
    const { tabs, activePath, split } = get()
    return window.api.setEditorSession({
      tabs: tabs.map((tab): OpenTab => ({ path: tab.path, line: tab.line, column: tab.column })),
      activePath,
      split
    })
  }
}))

/**
 * 按上次退出时的状态恢复标签页。
 *
 * 逐个 try：某个文件可能已被删除或移动，那就不恢复它、继续恢复其余的，
 * 而不是一个失败就整批放弃 —— 学生打开五个文件，其中一个被删了，
 * 不该让另外四个也白开。
 */
async function restoreTabs(session: EditorSession): Promise<void> {
  if (!session.tabs.length) return
  const store = useAppStore.getState()
  for (const item of session.tabs) {
    try {
      await store.openFile(item.path, item.line, item.column)
    } catch {
      /* 单个文件恢复失败就跳过，openFile 内部已经记了日志 */
    }
  }
  // 激活项在最后设：openFile 每次都会把新标签设成 active，
  // 恢复完再切回上次真正在看的那个
  if (session.activePath) useAppStore.getState().setActive(session.activePath)
}
