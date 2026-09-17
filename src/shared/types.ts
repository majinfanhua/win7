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
  /**
   * AI 给自己起的名字（≤5 字）。
   *
   * 为什么需要：教学场景里学生要反复指代这个助手，
   * 「你」「AI」这类称呼在长对话里会让模型分不清是在说它还是说别人。
   * 给个名字是最省事的消歧手段。
   */
  aiName: string
  /** 用户希望 AI 怎么称呼自己（≤5 字）。留空则不做要求 */
  userName: string
  /** 用户的使用习惯，自由文本。会作为「补充要求」附在提示词之后 */
  habits: string
  /** 部分中转站需要额外的鉴权头或自定义头 */
  extraHeaders: Record<string, string>
  /**
   * 当前模型是否支持图片输入（多模态）。
   *
   * 由用户在设置里勾选，不做自动探测 —— 「支持多模态」这件事
   * 中转站的 /models 接口不会告诉你，只有模型名能猜（而模型名千奇百怪）。
   * 猜错的代价不对称：勾了但不支持 → 整个请求被拒（学生一脸茫然）；
   * 不勾但支持 → 只是用不上图片，功能仍在。所以默认关闭，由人确认。
   */
  supportsVision: boolean
  /**
   * 是否校验中转站的 HTTPS 证书。**默认 false（不校验）**。
   *
   * 为什么默认关：目标平台是 Win7 SP1，它的根证书库随系统更新，
   * 而 Win7 早已停止主流支持，**新根 CA 装不进去** —— 典型的就是
   * Let's Encrypt 的 ISRG Root X1 那一批，而中转站用免费证书的非常多。
   * 校验开着的话，Chromium 会判定证书链不可信、在建连阶段直接拒掉，
   * 报 `net::ERR_CERT_AUTHORITY_INVALID`。那不是「中转站配错了」，
   * 而是这台机器老了 —— 用户换多少个中转站都没用。
   *
   * 所以默认「能连上优先」。开关留着，是因为不校验确实有代价：
   * 无法确认对端身份，密钥与对话内容可能被中间人截获。
   * 在证书链正常的环境（Win10/11、或打过补丁的 Win7）里，
   * 用户可以主动把它打开换回这道防护。
   *
   * 只影响 AI 请求（net.request 走的 defaultSession）：
   * 渲染层加载本地文件、预览服务绑 127.0.0.1 的 http，都不受影响。
   */
  verifyTls: boolean
  /**
   * 上下文窗口上限（token）。留 0 表示按内置的模型名表自动判断。
   *
   * 为什么需要：中转站的 /models 只给模型名、不给窗口大小，
   * 而模型名用户想怎么填就怎么填。内置表按常见模型名做了保守估计，
   * 但这个表一定会过时 —— 所以留一个手填的口子，
   * 让遇到问题的用户可以自己修正，而不是只能等应用更新。
   */
  contextWindow: number
  /** 单次回答的输出上限（token）。留 0 表示按内置表。 */
  maxOutputTokens: number
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
  /**
   * 是否已归档。
   *
   * 归档的语义是「这段对话结束了，可以总结了」——
   * 只有归档过的会话才会被总结、才会进入 AI 可检索的范围。
   * 没归档的会话属于「正在进行中」，总结它既浪费 token 又可能打断用户。
   */
  archived?: boolean
}

/**
 * 一条已归档会话的索引。
 *
 * 为什么不复用 SessionEntry：那个列表（recentSessions）**上限 20 条**，
 * 而归档是「长期资料」—— 第 21 条归档进来时，最早的会被挤掉，
 * 它的总结也就跟着消失了，而总结正是归档唯一的价值所在。
 * 所以归档单独存一份不设条数上限（每条只有标题 + 梗概，几十字节）。
 */
export interface ArchivedSession {
  id: string
  /** 会话标题（取自首条提问），用于列表显示与 AI 检索 */
  title: string
  /** AI 生成的梗概。为空表示还没总结（排队中或总结失败） */
  summary: string
  /** 归档时间（ISO 字符串） */
  archivedAt: string
  /** 原会话所在的工作区，便于 AI 判断「这是哪个项目的讨论」 */
  workspace: string
  /** 消息条数 */
  messageCount: number
  /**
   * 总结尝试次数。
   *
   * 有它才能区分「还没轮到」与「试过了但一直失败」——
   * 没有这个计数的话，一个必然失败的会话（比如内容全被敏感信息扫描拦下）
   * 会被无限重试，每次启动都白烧一次请求。
   */
  attempts?: number
}

/** 总结失败超过这个次数就不再自动重试，只在界面上显示「总结失败」 */
export const ARCHIVE_MAX_ATTEMPTS = 3

/** 梗概长度上限。够说清「这段对话解决了什么」，又不至于变成第二份记录 */
export const ARCHIVE_SUMMARY_MAX = 400

/** 归档索引的文件名（放在 userData/sessions/ 下） */
export const ARCHIVE_INDEX_FILE = 'archive.json'

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
  /**
   * 归档时间（ISO 字符串）。空 / 缺失表示未归档。
   *
   * 归档状态同时存在于三处：这里（正文文件）、config.json 的索引、
   * 以及 archive.json。**这不是冗余，是三层各有各的用处**：
   *   - 正文里这份：换台机器拷走 sessions/ 目录时状态跟着走；
   *     也是「这条会话到底归档没有」的最终依据
   *   - 索引里那份：左侧列表每次启动整份读，不能为它去逐个读正文文件
   *   - archive.json：AI 检索用，且不设条数上限
   * 三者不一致时的取舍见 archive.ts 的注释。
   */
  archivedAt?: string
  /** AI 生成的梗概。由归档流程写入，与 archive.json 里的同一份 */
  summary?: string
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
 * 权限模式：**模式控制工具的边界**。
 *
 * 与 capability 是两件事，不要合并：
 *   - capability 决定「AI 手里有哪些工具」（能力维度）
 *   - permission 决定「这些工具能伸到哪儿」（边界维度）
 *
 * 同一个 readFile，在 chat 下只能读工作区，在 full 下能读任何地方 ——
 * 工具没变，变的是模式给它划的界。
 */
export type PermissionMode = 'chat' | 'plan' | 'full'

export interface PermissionConfig {
  mode: PermissionMode
}

/**
 * 权限模式的中文名。
 *
 * 放在 shared 而不是 main：设置页要显示它，而渲染层不能 import 主进程模块。
 * 主进程日志也用这一份，避免两处文案各写各的（那种不一致很难发现）。
 */
export const PERMISSION_LABELS: Record<PermissionMode, string> = {
  chat: '对话模式',
  plan: '计划模式',
  full: '完全允许模式'
}

/** 全部权限模式，供校验与遍历用。顺序即界面上从保守到放开 */
export const PERMISSION_MODES: PermissionMode[] = ['chat', 'plan', 'full']

/* ------------------------------------------------------------------ *
 * 技能（Skills）
 * ------------------------------------------------------------------ */

/**
 * 技能配置。
 *
 * 目前只有一个开关：技能是**文件驱动**的 —— 用户在
 * `<userData>/skills/<id>/SKILL.md`（或项目里的 `.hangke/skills/`）
 * 里写文件即可，不需要在设置里登记。这样「加一个技能」和
 * 「用记事本写一个文件」是同一件事，没有中间状态要同步。
 */
export interface SkillsConfig {
  /**
   * 是否让 AI 能用技能工具。
   *
   * 关掉之后 listSkills / readSkill 都不进工具表，模型看不到就不会调。
   * 留着这个开关是因为技能正文是**用户自己写的指令**，
   * 相当于让 AI 按用户的自定义剧本办事 —— 教学场景里可能需要关掉。
   */
  enabled: boolean
}

/* ------------------------------------------------------------------ *
 * MCP（外部工具服务器）
 * ------------------------------------------------------------------ */

/** 一个 MCP 服务器。字段与 main/mcp/client.ts 的 McpServerConfig 一致 */
export interface McpServerEntry {
  /** 唯一 id。**不能含双下划线**（它是工具名的分隔符，见 mcp/manager.ts） */
  id: string
  /** 展示名 */
  name: string
  /** 启动命令，如 npx / node / python */
  command: string
  /** 命令参数 */
  args: string[]
  /** 额外环境变量 */
  env?: Record<string, string>
  /** 是否启用。关掉后不启动、工具也不进工具表 */
  enabled: boolean
}

export interface McpConfig {
  servers: McpServerEntry[]
}

/**
 * 一个 MCP 服务器的运行状态（发给界面显示）。
 *
 * 除了状态，也带上展示名与启动命令：设置页要在一行里说清
 * 「这是哪个服务器、跑的什么命令、现在怎么样」——
 * 只给 id 和状态的话，排错时还得去翻 config.json 才知道命令是什么。
 */
export interface McpServerStatus {
  id: string
  /** 展示名 */
  name: string
  /** 启动命令与参数，界面上显示出来便于核对 */
  command: string
  args: string[]
  status: 'stopped' | 'starting' | 'ready' | 'error'
  /** 状态说明：错误原因 / 工具数 */
  detail: string
  /** 这个服务器提供的工具名（服务器那边的原始名） */
  tools: string[]
}

/** 一个技能（发给界面显示）。字段与 main/skills.ts 的 SkillSummary 一致 */
export interface SkillEntry {
  id: string
  name: string
  description: string
  source: 'user' | 'project'
  path: string
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
  /**
   * 左侧栏里「上半段（工作空间）」占的高度比例，0~1。
   *
   * 上半段与文件树之间的高度可拖 —— 项目多的时候想多看工作空间，
   * 项目深的时候想多看文件树，固定 62% 两头都不讨好。
   *
   * 与其他界面偏好一样落盘（重启恢复上次拖到的位置）。
   * 落盘时要夹到 SIDEBAR_SPLIT_MIN/MAX 之间，语义与 --split 一致。
   */
  sidebarSplit: number
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


/**
 * 左侧栏上下分割的比例上下限。
 *
 * 语义与 SPLIT_MIN/MAX 相同（都是「前一段占比」），但数字不同：
 * 侧栏很窄，上半段压到 28% 以下就只剩两三行、文件树留太多也没用。
 * 0.2 保证上半段至少能看到一个列表项，0.85 保证文件树至少有几行。
 */
export const SIDEBAR_SPLIT_MIN = 0.2
export const SIDEBAR_SPLIT_MAX = 0.85

/**
 * 双击分割条时复位到的比例。
 *
 * 0.45：文件树通常比工作空间列表长，默认多给它一点。
 * 与 DEFAULT_CONFIG.explorer.sidebarSplit 取同一个值 —— 两处不一致的话，
 * 「双击复位」会跳到一个和初始状态不同的位置，很难解释。
 */
export const DEFAULT_SIDEBAR_SPLIT = 0.45
export interface AppConfig {
  ai: AIConfig
  editor: EditorConfig
  legacyGraphics: LegacyGraphicsConfig
  capability: CapabilityConfig
  /** 权限模式：决定 AI 的工具能伸到哪儿（工作区内 / 越界要授权 / 全局放行） */
  permission: PermissionConfig
  /** 技能：可复用的「怎么做某件事」的说明书 */
  skills: SkillsConfig
  /** MCP：外部工具服务器 */
  mcp: McpConfig
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
  /**
   * 本机装了哪些运行时（python / node / git…）。
   *
   * 单独一个字段而不是混进 checks：checks 是「体检项」（通过/注意/异常），
   * 而这是**能力清单** —— 没装 python 不算体检不通过，只是用不了而已。
   */
  runtimes: DetectedRuntime[]
}

/** 一个被探测到的开发运行时 */
export interface DetectedRuntime {
  /** 程序名，如 python / node / git */
  name: string
  /** 版本字符串，探测失败时为空 */
  version: string
  /** 可执行文件的绝对路径（或命令名） */
  path: string
  /** 给界面用的一句话用途说明 */
  note: string
}

export type ChatRole = 'system' | 'user' | 'assistant'

/**
 * 消息内容。
 *
 * 纯文本时是字符串；带图片时是内容块数组（OpenAI 兼容的多模态格式）。
 * 用联合类型而不是「永远是数组」：绝大多数消息没有图，
 * 强行数组化会让所有下游代码（会话落盘、拍平算缓存）都要处理一层解包。
 */
export type ChatContent = string | ChatContentBlock[]

export type ChatContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }

export interface ChatMessage {
  role: ChatRole
  content: ChatContent
}

/**
 * 一条消息的纯文本部分。
 *
 * 拍平给「缓存命中估算」与「会话标题提取」用 —— 它们只关心文字，
 * 图片的 base64 既不该参与前缀比较（每次都不同，会让命中率永远算成 0），
 * 也不该进标题。
 */
export function textOf(content: ChatContent): string {
  if (typeof content === 'string') return content
  return content
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
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
  /**
   * 这段文本是**思考过程**（模型的思维链），不是最终回答。
   *
   * 带推理的模型把思维链与正文分开送：DeepSeek 官方走
   * `delta.reasoning_content` 这个独立字段，而不少中转站把它并进
   * `delta.content` 并用 `</think>` 之类的标签包起来。
   * 两条路都在主进程归一化成这个标记，渲染层据此折叠显示 ——
   * 不折叠的话，学生要翻过几千字自言自语才看得到答案。
   */
  reasoning?: boolean
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

/**
 * 一次越界访问的授权请求（主进程 → 渲染层）。
 *
 * 由主进程发起：它才是真正要动文件的那一方，必须自己等到用户点头。
 * 渲染层只负责显示与回传选择，不参与判定。
 */
export interface ApprovalRequest {
  id: string
  /** 人类可读的动作描述，如「读取 D:\其他项目\a.ts」 */
  action: string
  /** 要访问的绝对路径 */
  target: string
  /** 「允许此目录」会授权的目录 */
  scopeDir: string
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
  | 'glob'
  | 'grep'
  | 'undoSnapshot'
  | 'runCommand'
  | 'jobRun'
  | 'jobPoll'
  | 'jobKill'
  | 'listSessions'
  | 'readSession'
  | 'memoryGet'
  | 'memoryWrite'
  | 'listSkills'
  | 'readSkill'

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

/**
 * `系统.md` 的当前状态，供设置页展示。
 *
 * 把 `inSync` 单独返回而不是让界面自己比对内容：
 * 「按当前设置应该得到什么」这件事只有主进程算得出来
 * （它要探测运行时、读平台信息），界面拿不到这个基准。
 */
export interface SystemDocState {
  /** 文件绝对路径。界面用它做「打开文件」「复制路径」 */
  path: string
  /** 文件当前内容（可能包含用户的手改） */
  content: string
  /** 与「按当前设置应得的内容」是否一致。false 表示下次对话前会被覆盖 */
  inSync: boolean
  /** 文件是否存在 */
  exists: boolean
}

/* ------------------------------------------------------------------ *
 * token 用量统计
 * ------------------------------------------------------------------ */
/**
 * 一个统计口径下的累计值。
 *
 * `estimatedRequests` 单独记而不是混进 requests：估算值（中转站不回 usage 时
 * 按字数估的）与实际值混在一起会让总数看起来精确、其实一半是猜的。
 * 分开记，用户能一眼看出「有多少是真的从接口来的」。
 */
export interface UsageBucket {
  requests: number
  /** 其中用估算值的请求数 */
  estimatedRequests: number
  promptTokens: number
  completionTokens: number
  /** 命中缓存的 prompt token。缓存命中的部分通常便宜得多 */
  cachedTokens: number
}

/** 按模型分组的累计值 */
export interface UsageByModel extends UsageBucket {
  model: string
}

/** 一天的累计值 */
export interface UsageByDay extends UsageBucket {
  /** YYYY-MM-DD（本地时区） */
  day: string
}

export interface UsageStats {
  today: UsageBucket
  /** 最近 7 天（含今天） */
  week: UsageBucket
  /** 全部历史（受保留天数限制） */
  total: UsageBucket
  /** 最近 N 天的逐日数据，用于画趋势 */
  days: UsageByDay[]
  /** 按模型分组（全部历史），按 token 总量降序 */
  models: UsageByModel[]
  /** 统计覆盖的最早一天。为空表示还没有任何记录 */
  since: string
}

/** 逐日明细保留天数。超过就丢掉 —— 这个功能是「看趋势」，不是账本 */
export const USAGE_KEEP_DAYS = 90
/** 按模型分组最多保留几个（超出并入「其他」不单列，避免设置页被撑爆） */
export const USAGE_MODELS_MAX = 12

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

  /**
   * 权限模式与越界审批。
   *
   * 审批是**主进程发起、渲染层回话**（不是渲染层先答应再干活）：
   * 要动文件的是主进程，它必须自己等到用户点头。
   */
  permissionGetMode: 'permission:get-mode',
  permissionSetMode: 'permission:set-mode',
  /** 用户批准计划模式的执行（按会话记） */
  permissionStartExecuting: 'permission:start-executing',
  /** 主进程 → 渲染层：有一个越界请求等你决定 */
  evtApprovalRequest: 'evt:approval-request',
  /** 渲染层 → 主进程：我的选择 */
  permissionResolve: 'permission:resolve',

  /* 技能（Skills）：列举、读正文、打开目录 */
  skillsList: 'skills:list',
  skillsRead: 'skills:read',
  skillsOpenDir: 'skills:open-dir',

  /* MCP：状态查询、连接/重连、打开配置目录 */
  mcpStatus: 'mcp:status',
  mcpReconnect: 'mcp:reconnect',

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
  /**
   * 列出工作区里的文件（相对路径），供输入框 @ 引用做候选列表。
   *
   * 与 glob 工具的区别：那个是给 AI 用的、按模式匹配；
   * 这个是给人用的，一次返回全量（有上限），由渲染层做模糊过滤 ——
   * 每敲一个字就往返一次 IPC，在机械盘上会明显发涩。
   */
  wsListFiles: 'ws:list-files',

  sessionList: 'session:list',
  sessionTouch: 'session:touch',
  sessionRemove: 'session:remove',
  sessionLoad: 'session:load',
  sessionSave: 'session:save',
  /** 归档一条会话（触发后台总结），归档后才会进入 AI 可检索的范围 */
  sessionArchive: 'session:archive',
  /** 取消归档，并撤掉它的总结 */
  sessionUnarchive: 'session:unarchive',
  /** 已归档会话的索引（含标题与梗概），设置页与 AI 工具共用 */
  sessionArchiveList: 'session:archive-list',

  /** `系统.md` 的当前状态（内容 + 是否与设置一致） */
  systemDocGet: 'system-doc:get',
  /** 按当前设置重新生成 `系统.md` */
  systemDocRegenerate: 'system-doc:regenerate',
  /** 用系统默认程序打开 `系统.md` */
  systemDocOpen: 'system-doc:open',

  /** token 用量统计 */
  usageStats: 'usage:stats',
  usageReset: 'usage:reset',

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

export const DEFAULT_CONFIG: AppConfig = {
  ai: {
    // 留空强制用户显式配置中转站，避免默认值静默失败
    baseUrl: '',
    apiKey: '',
    model: '',
    temperature: 0.3,
    // 身份与习惯默认留空：没有名字时模型用「我」自称，
    // 比塞一个它没同意过的名字更自然
    aiName: '',
    userName: '',
    habits: '',
    extraHeaders: {},
    // 默认关：见 AIConfig.supportsVision 的注释（猜错的代价不对称）
    supportsVision: false,
    /*
     * 默认关（不校验）。Win7 的根证书库装不进新根 CA（如 Let's Encrypt
     * 的 ISRG Root X1），开着校验会让目标平台默认连不上中转站 ——
     * 详见 AIConfig.verifyTls 的注释。设置页里可以手动打开。
     */
    verifyTls: false,
    // 0 = 交给内置模型表判断。填了就以填的为准
    contextWindow: 0,
    maxOutputTokens: 0
  },
  editor: { fontSize: 14, tabSize: 2, wordWrap: true, minimap: false },
  legacyGraphics: { softwareRendering: true },
  // 默认按本机探测，不额外关任何工具
  capability: { mode: 'auto', disabled: [] },
  // 默认对话模式：工作区 + 临时区内自由，越界问用户。最安全也最符合直觉的起点
  permission: { mode: 'chat' },
  /*
   * 技能默认开。它是用户自己写的说明书，风险由用户自己掌握；
   * 而且不开的话这个功能装了等于没装（设置页又不会自己弹出来）。
   */
  skills: { enabled: true },
  /* MCP 默认空列表：一个都不配就不起任何外部进程 */
  mcp: { servers: [] },
  // sortBy 默认按名称：教师视角最可预期，学生也最容易找到自己刚建的文件
  explorer: {
    showHidden: false,
    treeOpen: true,
    chatOpen: true,
    sortBy: 'name',
    // 上半段（工作空间）默认占比。与 DEFAULT_SIDEBAR_SPLIT 同一个值
    sidebarSplit: DEFAULT_SIDEBAR_SPLIT
  },
  lastWorkspace: '',
  recentWorkspaces: [],
  recentSessions: [],
  // 默认对话占 62%，剩下的给编辑器
  editorSession: { tabs: [], activePath: '', split: 0.62 }
}
