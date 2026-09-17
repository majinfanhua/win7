import type {
  AppConfig,
  ExplorerSortBy,
  FileChangeEvent,
  FileNode,
  LogLine,
  RuntimeInfo,
  SessionEntry,
  SnapshotSummary,
  StoredMessage,
  UndoOutcome,
  WorkspaceEntry
} from '@shared/types'
import type { FileTemplate } from '../file-templates'

/**
 * store 各 slice 共用的状态形状。
 *
 * ## 为什么要把 store 拆开
 *
 * `useAppStore.ts` 曾经 1100 行，而项目自己的红线是 800 行。
 * 更要紧的不是行数，是**改一处不知道会影响谁**：这个 store 同时管着
 * 会话、文件树、编辑器标签、日志、快照五件事，而它们之间几乎不互相调用。
 *
 * 拆成三个 slice 后：改文件树的移动逻辑不会碰到会话逻辑。
 *
 * ## slice 的边界怎么定的
 *
 * 按「谁跟谁真的会一起变」分，不是按行数平均切：
 *
 * | slice | 管什么 | 依赖 |
 * |---|---|---|
 * | `session-slice` | 会话与消息、日志、快照、配置 | 无（最底层）|
 * | `tree-slice` | 工作区、文件树、增删改名移动、拖拽 | 会话（要它记日志）|
 * | `editor-slice` | 标签页、内容、光标、保存、会话恢复 | 树（要它刷新目录）|
 *
 * 依赖是**单向**的：editor → tree → session。反向调用会让循环 import
 * 立刻爆炸，所以新增跨 slice 操作时先确认方向。
 *
 * ## 为什么用一个 StateCreator 而不是三个独立 store
 *
 * 组件里读的是同一个 `useAppStore`，拆成三个 store 会让
 * 「打开文件同时要动标签和文件树」这类操作变成跨 store 事务。
 * slice 模式保持单一 store，只是把**定义**分开 —— 组件代码一行不用改。
 */

/** 编辑器里打开的一个标签 */
export interface EditorTab {
  path: string
  name: string
  content: string
  language: string
  dirty: boolean
  /**
   * 这份内容是不是**不完整**的（主进程因文件过大只给了占位说明）。
   *
   * ⚠️ 有这个标记的标签**绝不允许保存**。
   *
   * 主进程对超过上限的文件返回的是「// 文件过大（x MB），已跳过加载。」
   * 这样一段占位文本，而不是真实内容。以前渲染层完全不看这个标记，
   * 把它当成正常文件建标签，于是：
   *   打开一个 5MB 的日志 → 按 Ctrl+S → **原文件被那句占位注释覆盖**。
   * 不可逆，而且用户完全不知道发生了什么。
   */
  truncated: boolean
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

/** 会话 slice：会话、消息、日志、快照、配置。最底层，不依赖其他 slice */
export interface SessionSlice {
  sessions: SessionEntry[]
  /** 当前会话 id，发送第一条消息时分配 */
  sessionId: string
  /** 当前会话的消息列表。切换历史会话时整份替换 */
  messages: StoredMessage[]
  /** 正在读取历史会话正文，期间输入框可禁用 */
  sessionLoading: boolean
  logs: LogLine[]
  config: AppConfig | null
  runtime: RuntimeInfo | null
  /** 可撤销的修改记录（只含当前工作区） */
  snapshots: SnapshotSummary[]
  /**
   * 最近一次「切换会话」的时间戳。
   *
   * AiPanel 订阅它来中断在飞的请求 —— 带着一个未完成的流切会话，
   * 那个流收尾时会把内容写进**新**会话。用时间戳而不是布尔，
   * 是为了让「连续切两次」也能各触发一次 effect。
   */
  sessionSwitchAt: number

  startNewSession: () => void
  recordSession: (title: string, messageCount: number) => Promise<void>
  removeSession: (id: string) => Promise<void>
  /**
   * 归档一条会话。
   *
   * 归档 = 宣布这段对话结束了。主进程会立刻在后台生成梗概，
   * 并把这条会话放进 AI 可检索的范围。
   * 返回一句给用户看的话（成功或失败）。
   */
  archiveSession: (id: string) => Promise<string>
  /** 取消归档（撤掉梗概） */
  unarchiveSession: (id: string) => Promise<string>
  openSession: (id: string) => Promise<void>
  /** 把当前 messages 落盘。消息变化后调，内部自己防抖 */
  persistSession: () => void
  setSessionMessages: (messages: StoredMessage[]) => void
  pushLog: (line: LogLine) => void
  clearLogs: () => void
  loadConfig: () => Promise<void>
  applyConfig: (config: AppConfig) => void
  refreshSnapshots: () => Promise<void>
  undoLast: (path?: string) => Promise<UndoOutcome>
}

/** 文件树 slice：工作区、目录缓存、增删改名移动、拖拽 */
export interface TreeSlice {
  workspace: string
  workspaces: WorkspaceEntry[]
  childMap: Record<string, FileNode[]>
  expanded: Record<string, boolean>
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
  /**
   * 最近一次「在预览面板中打开」的时间戳（空串表示没有请求）。
   *
   * 用时间戳而不是布尔：同一个文件连续点两次也要各触发一次 effect。
   * 右键菜单在文件树组件里，而预览面板挂在 App —— 用 store 做单向通知，
   * 比把回调从 App 一路 prop 传到 TreeNode 干净得多。
   */
  previewRequestAt: string
  /** 对话区占中间栏的比例，0~1 */
  split: number

  setTreeOpen: (open: boolean) => Promise<void>
  /** 侧栏上下分割比例（工作空间 / 文件树），落盘由主进程夹取 */
  setSidebarSplit: (ratio: number) => Promise<void>
  setChatOpen: (open: boolean) => Promise<void>
  select: (path: string) => void
  openWorkspace: () => Promise<void>
  openWorkspaceAt: (dir: string) => Promise<void>
  removeWorkspace: (dir: string) => Promise<void>
  loadRoot: (dir: string) => Promise<void>
  refreshDir: (dir: string) => Promise<void>
  toggleDir: (dir: string) => Promise<void>
  collapseAll: () => void
  createEntry: (parent: string, name: string, kind: 'file' | 'dir') => Promise<string>
  createFromTemplate: (parent: string, template: FileTemplate, name: string) => Promise<string>
  renameEntry: (target: string, newName: string) => Promise<string>
  moveEntry: (from: string, destDir: string) => Promise<string>
  removeEntry: (target: string) => Promise<boolean>
  forgetSubtrees: (root: string) => void
  setSortBy: (sortBy: ExplorerSortBy) => Promise<void>
  setShowHidden: (showHidden: boolean) => Promise<void>
  setSplit: (split: number) => void
  beginDrag: (path: string) => void
  hoverDropTarget: (dir: string) => void
  endDrag: () => void
  dropOn: (from: string, dir: string) => Promise<void>
  insertReference: (file: string) => void
  consumeRefs: () => string[]
  /** 请求在预览面板里打开某个文件 */
  requestPreview: (file: string) => void
}

/** 编辑器 slice：标签页、内容、光标、保存、会话恢复、文件变化响应 */
export interface EditorSlice {
  tabs: EditorTab[]
  activePath: string

  openFile: (file: string, line?: number, column?: number) => Promise<void>
  setActive: (path: string) => void
  setContent: (path: string, content: string) => void
  setCursor: (path: string, line: number, column: number) => void
  saveActive: () => Promise<void>
  closeTab: (path: string) => void
  closeTabChecked: (path: string) => Promise<'saved' | 'discarded' | 'cancelled'>
  confirmLeaveWorkspace: () => Promise<boolean>
  handleFileChanged: (event: FileChangeEvent) => Promise<void>
  persistEditorSession: () => void
  flushEditorSession: () => Promise<boolean>
}

/** 应用外壳：启动流程。放这里因为它同时要碰三个 slice */
export interface ShellSlice {
  ready: boolean
  init: () => Promise<void>
}

export type AppState = SessionSlice & TreeSlice & EditorSlice & ShellSlice

/**
 * 这几个类型被 slice 与组件共用，从 @shared/types 直接转出 ——
 * 让调用方不用同时记两个 import 路径。
 */
export type {
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
