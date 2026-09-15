import { create } from 'zustand'
import type {
  AppConfig,
  EditorSession,
  ExplorerConfig,
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
import { EDITOR_TABS_MAX, SESSION_TITLE_MAX } from '@shared/types'
import { languageFromPath } from '@shared/language'

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

function baseName(filePath: string): string {
  const parts = filePath.split(/[\\/]/)
  return parts[parts.length - 1] || filePath
}

/** 会话落盘与编辑器状态落盘的防抖句柄（模块级，见各自注释） */
let persistTimer: ReturnType<typeof setTimeout> | null = null
let editorSessionTimer: ReturnType<typeof setTimeout> | null = null

/**
 * 取当前配置里的 explorer 段，缺字段时给默认值。
 *
 * 收敛到一处是为了防止「只改 treeOpen 却把 chatOpen 冲成 undefined」——
 * setConfig 是整体替换 explorer 对象的，漏一个字段就会把它清掉。
 */
function explorerOf(config: AppConfig | null): ExplorerConfig {
  return config?.explorer || { showHidden: false, treeOpen: true, chatOpen: true }
}

/** 从提问里截一个标题；空白提问给个兜底文案 */
function titleFrom(text: string): string {
  const line = text.split('\n').find((item) => item.trim()) || ''
  const clean = line.replace(/\s+/g, ' ').trim()
  return clean ? clean.slice(0, SESSION_TITLE_MAX) : '新会话'
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
  /** 被「插入引用」引用进输入框的文件，AiPanel 消费后清空 */
  pendingRefs: string[]
  /** 对话区占中间栏的比例，0~1 */
  split: number
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

  /** 新建文件 / 文件夹，返回新路径（失败返回空串） */
  createEntry: (parent: string, name: string, kind: 'file' | 'dir') => Promise<string>
  renameEntry: (target: string, newName: string) => Promise<string>
  removeEntry: (target: string) => Promise<boolean>

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
  split: 0.62,
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
    const dir = await window.api.openWorkspace()
    if (!dir) return
    // 换工作区等于换项目：清掉上一个项目的文件树与打开过的标签，避免串味
    set({ childMap: {}, expanded: {}, selectedPath: '', tabs: [], activePath: '' })
    await get().loadRoot(dir)
    set({ workspaces: await window.api.listWorkspaces() })
    get().persistEditorSession()
  },

  async openWorkspaceAt(dir: string) {
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
      await get().refreshDir(parentOf(target))
      get().persistEditorSession()
      return renamed
    } catch (err) {
      get().pushLog({ time: '', level: 'error', scope: 'tree', text: `重命名失败: ${String(err)}` })
      throw err
    }
  },

  async removeEntry(target) {
    try {
      await window.api.remove(target)
      get().pushLog({ time: '', level: 'warn', scope: 'tree', text: `已移入回收目录 ${target}` })
      // 删掉的东西如果正开着，标签也得关掉，否则保存会把它写回来
      set({ tabs: get().tabs.filter((t) => t.path !== target) })
      if (get().activePath === target) {
        const rest = get().tabs
        set({ activePath: rest.length ? rest[rest.length - 1].path : '' })
      }
      if (get().selectedPath === target) set({ selectedPath: '' })
      await get().refreshDir(parentOf(target))
      get().persistEditorSession()
      return true
    } catch (err) {
      get().pushLog({ time: '', level: 'error', scope: 'tree', text: `删除失败: ${String(err)}` })
      throw err
    }
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
   */
  async openSession(id) {
    if (get().sessionId === id) return
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

/** 取父目录，跨平台兼容 */
export function parentOf(target: string): string {
  const idx = Math.max(target.lastIndexOf('/'), target.lastIndexOf('\\'))
  return idx > 0 ? target.slice(0, idx) : target
}
