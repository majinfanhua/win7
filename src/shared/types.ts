/**
 * 主进程 / 预加载 / 渲染进程 三方共享的类型与 IPC 契约。
 * 任何跨进程的数据结构都定义在这里，改动一处两边同时生效。
 */

export type FileKind = 'file' | 'dir'

export interface FileNode {
  name: string
  path: string
  kind: FileKind
  size?: number
  /** 最后修改时间（毫秒时间戳）。用于「按修改时间」排序，老版本可能没有 */
  mtime?: number
}

export interface LoadedFile {
  path: string
  content: string
  language: string
  truncated: boolean
}

export interface AIConfig {
  /** 中转站地址，OpenAI 兼容；可填到 /v1，也可只填域名，由主进程归一化 */
  baseUrl: string
  apiKey: string
  model: string
  temperature: number
  systemPrompt: string
  /** 部分中转站需要额外的鉴权头或自定义头 */
  extraHeaders: Record<string, string>
}

export interface EditorConfig {
  fontSize: number
  tabSize: number
  wordWrap: boolean
  minimap: boolean
}

export interface LegacyGraphicsConfig {
  /** Win7/8 上是否使用软件渲染 */
  softwareRendering: boolean
}

/** 工作区里记录的一个项目目录 */
export interface WorkspaceEntry {
  /** 绝对路径，同时用作去重键 */
  path: string
  /** 显示名，取末级目录名 */
  name: string
  /** 最后一次打开时间（ISO 字符串），用于排序 */
  lastOpenedAt: string
}

/**
 * 一次对话会话的索引（不是完整消息，消息只在内存里）。
 *
 * 只落盘「标题 + 时间 + 用了哪个工作区」，是为了两件事：
 *   1. 左侧「最近会话」列表有东西可看，关掉应用再打开还在
 *   2. 使用者能找回「昨天那个问题」，但不会把整段聊天记录堆在磁盘上
 */
export interface SessionEntry {
  id: string
  /** 第一条用户提问截断而来 */
  title: string
  workspace: string
  /** 最后一条消息时间（ISO 字符串） */
  updatedAt: string
  /** 消息条数，列表右侧显示 */
  messageCount: number
}

/** 落盘的一条消息。只保留对话必需字段，不含 tools/usage 这类展示态 */
export interface StoredMessage {
  role: 'user' | 'assistant' | 'system'
  text: string
  /** 时间戳（ISO 字符串），回看时按需显示 */
  at: string
}

/** 一个会话的完整正文，单独一个文件 */
export interface StoredSession {
  id: string
  title: string
  workspace: string
  updatedAt: string
  messages: StoredMessage[]
}

/** 单个会话文件的大小上限，超过就不再往 messages 里追加（只保留最近 N 条） */
export const SESSION_MESSAGES_MAX = 200
/** 单条消息落盘时的字符上限，防止一个超大粘贴把 jsonl 撑到几十 MB */
export const SESSION_MESSAGE_CHARS_MAX = 200_000

/**
 * 工具能力的放开程度。
 *
 * 最终生效的工具表 = 设置上限 ∩ 本机探测能力 − disabled（见 src/main/capabilities.ts）。
 * 设置只回答「愿意放开到哪」，探测只回答「这台机器实际能做到哪」，两者不混。
 */
export type CapabilityMode = 'auto' | 'conservative' | 'full'

export interface CapabilityConfig {
  /** auto：按本机探测；conservative：只放开跨系统那几个；full：忽略探测全开 */
  mode: CapabilityMode
  /** 在上一层范围内再逐项关掉，值是工具名（ToolName） */
  disabled: string[]
}

/**
 * 文件树的排序方式。
 *
 * 排序只在渲染层做（主进程 wsReadDir 已经保证「文件夹优先 + 中文名称序」），
 * 这样换排序方式不用重新读盘，机械盘上不会卡。
 */
export type ExplorerSortBy = 'name' | 'type' | 'mtime'

/** 排序方式的全部取值，用于 normalize 白名单校验与工具栏下拉 */
export const EXPLORER_SORT_BY: ExplorerSortBy[] = ['name', 'type', 'mtime']

/** 界面偏好：左侧栏与面板的展开状态 */
export interface ExplorerConfig {
  /** 是否显示以 . 开头的隐藏文件 / 目录 */
  showHidden: boolean
  /** 左侧栏里嵌的文件树是否展开 */
  treeOpen: boolean
  /** 右侧对话栏是否展开。收起后编辑器撑满内容区 */
  chatOpen: boolean
  /**
   * 文件树排序方式。
   *
   * 注意：新增这个字段必须同步改 src/main/config.ts 的 normalize()——
   * 那一份是白名单式的，漏加会表现为「改完重启就没了，还不报错」。
   */
  sortBy: ExplorerSortBy
}

/**
 * 编辑器里打开过的一个标签。
 *
 * 只存路径与光标位置，不存文件内容 —— 内容是磁盘上的真实状态，
 * 缓存一份下来就会和磁盘分叉，下次启动反而显示旧代码。
 */
export interface OpenTab {
  path: string
  /** 光标位置（Monaco 的行列，从 1 开始） */
  line: number
  column: number
}

/**
 * 编辑器会话：重启后要恢复成什么样。
 *
 * 和 OpenTab 分开是因为 activePath 可能为空（一个标签都没打开），
 * 单独放一个字段比在 OpenTab 里加 `active: boolean` 更好判断。
 */
export interface EditorSession {
  tabs: OpenTab[]
  activePath: string
  /** 对话与编辑器的分割比例（0~1），上次拖到哪儿就恢复成哪儿 */
  split: number
}

/** 编辑器会话的标签数量上限，超过就只留最后 N 个 */
export const EDITOR_TABS_MAX = 12

/**
 * 分割比例的安全范围。
 *
 * ⚠️ 必须与前端 useSplitter 的 min/max（App.tsx）**逐字一致**。
 *
 * 这两处曾经不一致：界面限 0.28~0.78，而这里写 0.2~0.9。
 * 后果是一条很难查的路径 —— 拖到 0.25 落盘、重启读回来是 0.25
 * （在 0.2~0.9 之内，不会被夹），但界面把它当越界值处理，
 * 于是同一次拖动在「当次会话」与「重启后」表现不同。
 * 界面的范围更窄，是更严的那一侧，所以以它为准。
 */
export const SPLIT_MIN = 0.28
export const SPLIT_MAX = 0.78

export interface AppConfig {
  ai: AIConfig
  editor: EditorConfig
  legacyGraphics: LegacyGraphicsConfig
  capability: CapabilityConfig
  explorer: ExplorerConfig
  lastWorkspace: string
  /** 最近打开过的工作区，最新在前，最多 RECENT_WORKSPACES_MAX 条 */
  recentWorkspaces: WorkspaceEntry[]
  /** 最近会话索引，最新在前，最多 RECENT_SESSIONS_MAX 条 */
  recentSessions: SessionEntry[]
  /** 上次退出时的编辑器状态，启动时恢复 */
  editorSession: EditorSession
}

/**
 * 文件变化事件。
 *
 * 只有「工作区里某个文件被改了」这一种情况会推给渲染层 ——
 * 目录增删走文件树的 refreshDir，不从这里走，避免两套刷新逻辑打架。
 */
export interface FileChangeEvent {
  /** 变更文件的绝对路径 */
  path: string
  /** 变更来源。ai 表示工具写的，编辑器据此把「AI 改过」标记显示出来 */
  origin: 'ai' | 'external' | 'unknown'
  /** 事件时间（ISO 字符串） */
  at: string
}

/** 撤销结果，设置页与编辑器工具栏都用 */
export interface UndoOutcome {
  ok: boolean
  message: string
  path?: string
}

/** 一条快照的摘要（不含正文，供列表展示） */
export interface SnapshotSummary {
  id: string
  time: string
  path: string
  source: string
  /** before 与 after 的行数差，正数表示新增行 */
  lineDelta: number
}

/** 最近工作区列表长度上限 */
export const RECENT_WORKSPACES_MAX = 8
/** 最近会话列表长度上限 */
export const RECENT_SESSIONS_MAX = 20
/** 会话标题截断长度 */
export const SESSION_TITLE_MAX = 40

export type OsTier = 'win7' | 'win8' | 'win10' | 'win11' | 'other'
export type SupportLevel = 'full' | 'incidental' | 'unsupported'

export interface RuntimeInfo {
  appVersion: string
  electron: string
  chrome: string
  node: string
  v8: string
  platform: string
  arch: string
  osRelease: string
  osName: string
  osTier: OsTier
  osBuild: number
  osSupport: SupportLevel
  osSupportNote: string
  softwareRendering: boolean
  compatNotes: string[]
  userDataPath: string
  logsPath: string
  locale: string
}

export type DoctorStatus = 'pass' | 'warn' | 'fail'

export interface DoctorCheck {
  id: string
  label: string
  status: DoctorStatus
  detail: string
}

export interface DoctorReport {
  runtime: RuntimeInfo
  checks: DoctorCheck[]
  generatedAt: string
}

export type ChatRole = 'system' | 'user' | 'assistant'

export interface ChatMessage {
  role: ChatRole
  content: string
}

/**
 * 一次对话的 token 用量。
 *
 * cachedTokens 是命中 prompt 缓存的输入 tokens。
 * 中转站返回真实用量时 source 为 'api'；不返回时主进程会按
 * “与上一次请求的公共前缀”估算一个量级，此时 source 为 'estimate'。
 */
export interface AiUsage {
  promptTokens: number
  completionTokens: number
  cachedTokens: number
  /** 缓存命中率，0 ~ 1 */
  cacheHitRate: number
  source: 'api' | 'estimate'
}

export interface AiStreamChunk {
  requestId: string
  kind: 'delta' | 'done' | 'error' | 'tool'
  text?: string
  message?: string
  /** 只在 kind === 'done' 时给出 */
  usage?: AiUsage
  /** 只在 kind === 'tool' 时给出：AI 正在调用哪个工具 */
  tool?: ToolProgress
}

export interface AiTestResult {
  ok: boolean
  detail: string
  latencyMs?: number
}

export interface ModelListResult {
  ok: boolean
  models: string[]
  detail: string
}

/* ------------------------------------------------------------------ *
 * 工具调用
 * ------------------------------------------------------------------ */

/** 工具对运行环境的要求；none 表示纯文件操作，任何系统都能跑 */
export type ToolRequirement = 'none' | 'commandExec' | 'backgroundJobs'

export type ToolName =
  | 'readFile'
  | 'writeFile'
  | 'editFile'
  | 'multiEdit'
  | 'listDir'
  | 'undoSnapshot'
  | 'runCommand'
  | 'jobRun'
  | 'jobPoll'
  | 'jobKill'

/** 工具执行过程，推给界面展示「AI 正在做什么」 */
export interface ToolProgress {
  name: string
  phase: 'start' | 'done'
  /** 一行人类可读摘要，如「读取 hello.py」 */
  summary: string
  ok?: boolean
}

/** 本机能力探测 + 设置求交后的结果，供设置界面展示 */
export interface CapabilityInfo {
  /** 探测依据，如「Windows 7 SP1 (6.1.7601)」 */
  profile: string
  /** 本机是否满足各项要求 */
  detected: Record<ToolRequirement, boolean>
  /** 探测说明，如「未找到 powershell.exe」 */
  notes: string[]
  mode: CapabilityMode
  /** 最终生效的工具名 */
  effective: ToolName[]
  /** 被过滤掉的工具及原因 */
  filtered: Array<{ name: ToolName; reason: string }>
  /** 工具名 -> 中文短名，设置界面直接用 */
  labels: Record<string, string>
  /** 是否由 --capability-profile 强制覆盖（CI 用） */
  overridden: boolean
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export interface LogLine {
  time: string
  level: LogLevel
  scope: string
  text: string
}

/** IPC 频道常量：主进程与预加载共用，避免字符串写错 */
export const IPC = {
  appRuntime: 'app:runtime',
  appDoctor: 'app:doctor',
  appOpenLogs: 'app:open-logs',
  appCapabilities: 'app:capabilities',

  configGet: 'config:get',
  configSet: 'config:set',

  wsOpen: 'ws:open',
  wsReadDir: 'ws:read-dir',
  wsReadFile: 'ws:read-file',
  wsWriteFile: 'ws:write-file',
  wsCreate: 'ws:create',
  wsRename: 'ws:rename',
  /** 把文件/目录移到另一个目录下（拖拽、剪切粘贴） */
  wsMove: 'ws:move',
  wsDelete: 'ws:delete',
  wsList: 'ws:list',
  wsRemoveRecent: 'ws:remove-recent',
  wsReveal: 'ws:reveal',
  wsPreview: 'ws:preview',
  wsSetHidden: 'ws:set-hidden',

  sessionList: 'session:list',
  sessionTouch: 'session:touch',
  sessionRemove: 'session:remove',
  sessionLoad: 'session:load',
  sessionSave: 'session:save',

  aiChat: 'ai:chat',
  aiAbort: 'ai:abort',
  aiTest: 'ai:test',
  aiListModels: 'ai:list-models',

  /** 编辑器会话（打开过哪些标签）的读写 */
  editorSessionGet: 'editor:session-get',
  editorSessionSet: 'editor:session-set',
  /** 撤销 AI / 手工修改，并列出可撤销记录 */
  editorUndo: 'editor:undo',
  editorListSnapshots: 'editor:list-snapshots',

  evtAiStream: 'evt:ai-stream',
  evtLog: 'evt:log',
  evtMenu: 'evt:menu',
  /** 工作区里文件被改动（含 AI 工具写入） */
  evtFileChanged: 'evt:file-changed'
} as const

/**
 * 默认 System Prompt：约束回答方式，而不是让它自由发挥。
 *
 * 这段会作为指令发给模型，措辞直接影响回答的口吻与结构，
 * 所以不用「老师 / 学生」这类特定关系设定 —— 使用者可能是任何人，
 * 用一个中性但明确的技术助手口吻反而更稳。
 * 四条要求的核心都是「可操作」：先说在做什么，一次一个点，给出能直接跑的片段。
 */
export const DEFAULT_SYSTEM_PROMPT =
  '你是一名中文技术助手。回答时请遵循：\n' +
  '1. 先一句话说明这段代码在做什么，再指出问题，最后给出可直接运行的完整修改片段。\n' +
  '2. 每次只讲一个知识点，不要堆砌术语；必要术语用一句话解释。\n' +
  '3. 回答尽量短，代码用 Markdown 代码块包裹。\n' +
  '4. 如果代码没有错，也要说明它为什么是对的。'

export const DEFAULT_CONFIG: AppConfig = {
  ai: {
    // 留空强制用户显式配置中转站，避免默认值静默失败
    baseUrl: '',
    apiKey: '',
    model: '',
    temperature: 0.3,
    systemPrompt: DEFAULT_SYSTEM_PROMPT,
    extraHeaders: {}
  },
  editor: { fontSize: 14, tabSize: 2, wordWrap: true, minimap: false },
  legacyGraphics: { softwareRendering: true },
  // 默认按本机探测，不额外关任何工具
  capability: { mode: 'auto', disabled: [] },
  // sortBy 默认按名称：教师视角最可预期，学生也最容易找到自己刚建的文件
  explorer: { showHidden: false, treeOpen: true, chatOpen: true, sortBy: 'name' },
  lastWorkspace: '',
  recentWorkspaces: [],
  recentSessions: [],
  // 默认对话占 62%，剩下的给编辑器
  editorSession: { tabs: [], activePath: '', split: 0.62 }
}
