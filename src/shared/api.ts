import type {
  AiStreamChunk,
  AiTestResult,
  AppConfig,
  ApprovalRequest,
  ArchivedSession,
  CapabilityInfo,
  ChatMessage,
  DoctorReport,
  EditorSession,
  FileChangeEvent,
  FileNode,
  LoadedFile,
  LogLine,
  McpServerStatus,
  ModelListResult,
  RuntimeInfo,
  SessionEntry,
  SkillEntry,
  SnapshotSummary,
  StoredSession,
  SystemDocState,
  UndoOutcome,
  UsageStats,
  WorkspaceEntry
} from './types'

/**
 * 渲染进程能看到的全部能力。
 * 预加载层必须严格实现这个接口，渲染进程只能通过 window.api 访问主进程。
 */
export interface AppApi {
  runtime(): Promise<RuntimeInfo>
  doctor(): Promise<DoctorReport>
  openLogs(): Promise<string>
  /** 本机探测 ∩ 设置之后的工具能力，设置界面与自检用 */
  capabilities(): Promise<CapabilityInfo>

  getConfig(): Promise<AppConfig>
  setConfig(patch: Partial<AppConfig>): Promise<AppConfig>

  /** 当前权限模式（对话 / 计划 / 完全允许） */
  getPermissionMode(): Promise<string>
  /**
   * 切换权限模式，返回**整份配置**。
   *
   * 返回整份而不是只回模式：调用方（输入框下方的切换器）要立刻把新配置
   * 写回 store，让顶栏、设置页与下一次对话的 system prompt 都同步。
   * 切换会清掉本次运行内已授予的越界授权，避免上个模式的放行残留。
   */
  setPermissionMode(mode: string): Promise<AppConfig>
  /**
   * 计划模式：用户点了「开始执行」，本会话放行写入。
   * 必须带上 sessionId —— 批准是按会话记的，主进程不自己猜是哪个会话。
   */
  startExecuting(sessionId: string): Promise<boolean>
  /** 回一个越界审批请求（allow-once / allow-dir / deny） */
  resolveApproval(id: string, choice: string): Promise<boolean>

  /** 列出可用技能（用户级 + 项目级合并，项目级优先） */
  listSkills(): Promise<SkillEntry[]>
  /** 读一个技能的正文（设置页的预览用） */
  readSkillText(id: string): Promise<string>
  /** 用系统文件管理器打开技能目录，方便用户放自己的技能 */
  openSkillsDir(): Promise<boolean>

  /** 各 MCP 服务器的运行状态与工具列表 */
  mcpStatus(): Promise<McpServerStatus[]>
  /** 连接 / 重连一个 MCP 服务器 */
  mcpReconnect(id: string): Promise<McpServerStatus[]>
  /** 有越界请求等用户决定 */
  onApprovalRequest(cb: (req: ApprovalRequest) => void): () => void

  openWorkspace(preset?: string): Promise<string>
  readDir(dir: string): Promise<FileNode[]>
  readFile(file: string): Promise<LoadedFile>
  writeFile(file: string, content: string): Promise<boolean>
  createEntry(parent: string, name: string, kind: 'file' | 'dir'): Promise<string>
  rename(from: string, newName: string): Promise<string>
  /**
   * 把 from 移到 destDir 下（保持原名），返回新路径。
   *
   * 目标已存在同名项时**抛错**，不覆盖 —— 覆盖等于无声删掉学生另一个文件，
   * 而删除至少还走回收站。跨盘场景主进程内部会回退成 copy + unlink。
   */
  moveEntry(from: string, destDir: string): Promise<string>
  remove(target: string): Promise<boolean>
  /**
   * 列出工作区里所有文件的相对路径（已跳过 node_modules 这类重目录）。
   *
   * 给输入框的 `@` 引用用：一次取回全量，之后在渲染层本地过滤。
   * 未打开工作区时返回空数组（而不是抛错）—— 输入框不该因为
   * 没打开项目就报一堆错。
   */
  listFiles(): Promise<string[]>

  /** 最近打开过的工作区列表（最新在前） */
  listWorkspaces(): Promise<WorkspaceEntry[]>
  /** 从最近列表里移除一条（只删记录，不动磁盘上的目录） */
  removeRecentWorkspace(path: string): Promise<WorkspaceEntry[]>
  /** 打开工作区里的一个文件，交系统默认程序处理（右键「预览文件」） */
  revealInOs(target: string): Promise<boolean>
  /** 用系统默认浏览器打开 HTML（自动起一个临时本地服务，页面里的相对路径也能加载） */
  previewInBrowser(target: string): Promise<boolean>
  /** 切换「显示隐藏文件」，写进设置并立即生效 */
  setShowHidden(showHidden: boolean): Promise<AppConfig>

  /** 最近会话索引 */
  listSessions(): Promise<SessionEntry[]>
  /** 新建或更新一条会话记录（发第一条消息时调，之后每轮刷新时间与条数） */
  touchSession(entry: {
    id: string
    title: string
    workspace: string
    messageCount: number
  }): Promise<SessionEntry[]>
  removeSession(id: string): Promise<SessionEntry[]>
  /** 读一个会话的完整正文（消息列表）。找不到就返回 null，不抛错 */
  loadSession(id: string): Promise<StoredSession | null>
  /** 整体覆写一个会话的正文。整份写而不是追加，避免 jsonl 半截损坏 */
  saveSession(session: StoredSession): Promise<boolean>

  /**
   * 归档一条会话。
   *
   * 归档 = 「这段对话结束了，可以总结了」。归档后主进程会在后台
   * 生成一段梗概，并把这条会话放进 AI 可检索的范围。
   */
  archiveSession(id: string): Promise<{ message: string; entries: ArchivedSession[] }>
  /** 取消归档，同时撤掉它的梗概 */
  unarchiveSession(id: string): Promise<{ message: string; entries: ArchivedSession[] }>
  /** 已归档会话的索引（含标题与梗概） */
  listArchive(): Promise<ArchivedSession[]>

  /** `系统.md` 的当前内容与同步状态 */
  getSystemDoc(): Promise<SystemDocState>
  /** 按当前设置重新生成 `系统.md`，返回新内容 */
  regenerateSystemDoc(): Promise<SystemDocState>
  /** 用系统默认程序打开 `系统.md` */
  openSystemDoc(): Promise<boolean>

  /** token 用量统计 */
  getUsageStats(): Promise<UsageStats>
  /** 清空统计，返回清空后的结果 */
  resetUsageStats(): Promise<UsageStats>

  /** 上次退出时的编辑器状态（打开过哪些文件、光标在哪、分割比例） */
  getEditorSession(): Promise<EditorSession>
  /** 落盘编辑器状态。关窗时调一次，以及拖动分割条结束后 */
  setEditorSession(session: EditorSession): Promise<boolean>

  /** 撤销最近一次 AI / 手工修改。不传 path 就是全局最近一条 */
  undoChange(path?: string): Promise<UndoOutcome>
  /** 列出可撤销的记录（只有摘要，不含文件正文） */
  listSnapshots(): Promise<SnapshotSummary[]>

  /**
   * 发起一次流式对话。
   *
   * `sessionId` 是**必需**的信息，虽然形式上可选：主进程用它判断
   * 「这是不是一次新会话」。换了会话就要重新校验 userData/系统.md
   * （覆盖用户的手改、让设置改动立刻生效），同一会话内则复用快照
   * 以保证前后一致并命中 prompt 缓存。不传的后果是「改了设置/手改了
   * 系统.md 也不生效」，所以调用方一定要传。
   */
  aiChat(requestId: string, messages: ChatMessage[], sessionId?: string): Promise<void>
  aiAbort(requestId: string): Promise<boolean>
  aiTest(): Promise<AiTestResult>
  aiListModels(): Promise<ModelListResult>

  onAiStream(cb: (chunk: AiStreamChunk) => void): () => void
  onLog(cb: (line: LogLine) => void): () => void
  onMenu(cb: (action: string) => void): () => void
  /** 工作区里文件被改动（AI 工具写入、或外部程序改了） */
  onFileChanged(cb: (event: FileChangeEvent) => void): () => void
}
