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

export interface AppConfig {
  ai: AIConfig
  editor: EditorConfig
  legacyGraphics: LegacyGraphicsConfig
  lastWorkspace: string
}

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
  kind: 'delta' | 'done' | 'error'
  text?: string
  message?: string
  /** 只在 kind === 'done' 时给出 */
  usage?: AiUsage
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

  configGet: 'config:get',
  configSet: 'config:set',

  wsOpen: 'ws:open',
  wsReadDir: 'ws:read-dir',
  wsReadFile: 'ws:read-file',
  wsWriteFile: 'ws:write-file',
  wsCreate: 'ws:create',
  wsRename: 'ws:rename',
  wsDelete: 'ws:delete',

  aiChat: 'ai:chat',
  aiAbort: 'ai:abort',
  aiTest: 'ai:test',
  aiListModels: 'ai:list-models',

  evtAiStream: 'evt:ai-stream',
  evtLog: 'evt:log',
  evtMenu: 'evt:menu'
} as const

/** 教学场景的 System Prompt：约束回答方式，而不是让它自由发挥 */
export const TEACHING_SYSTEM_PROMPT =
  '你是一位面向零基础学生的编程老师，中文授课。要求：\n' +
  '1. 先一句话说明这段代码在做什么，再指出问题，最后给出可直接运行的完整修改片段。\n' +
  '2. 每次只讲一个知识点，不要堆砌术语；必要术语用一句话解释。\n' +
  '3. 回答尽量短，代码用 Markdown 代码块包裹。\n' +
  '4. 如果学生的代码没有错，也要说明它为什么是对的。'

export const DEFAULT_CONFIG: AppConfig = {
  ai: {
    // 留空强制用户显式配置中转站，避免默认值静默失败
    baseUrl: '',
    apiKey: '',
    model: '',
    temperature: 0.3,
    systemPrompt: TEACHING_SYSTEM_PROMPT,
    extraHeaders: {}
  },
  editor: { fontSize: 14, tabSize: 2, wordWrap: true, minimap: false },
  legacyGraphics: { softwareRendering: true },
  lastWorkspace: ''
}
