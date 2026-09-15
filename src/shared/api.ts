import type {
  AiStreamChunk,
  AiTestResult,
  AppConfig,
  CapabilityInfo,
  ChatMessage,
  DoctorReport,
  EditorSession,
  FileChangeEvent,
  FileNode,
  LoadedFile,
  LogLine,
  ModelListResult,
  RuntimeInfo,
  SessionEntry,
  SnapshotSummary,
  StoredSession,
  UndoOutcome,
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

  /** 最近打开过的工作区列表（最新在前） */
  listWorkspaces(): Promise<WorkspaceEntry[]>
  /** 从最近列表里移除一条（只删记录，不动磁盘上的目录） */
  removeRecentWorkspace(path: string): Promise<WorkspaceEntry[]>
  /** 打开工作区里的一个文件，交系统默认程序处理（右键「预览文件」） */
  revealInOs(target: string): Promise<boolean>
  /** 用系统浏览器预览 HTML（自动起一个临时本地服务，页面里的相对路径也能加载） */
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

  /** 上次退出时的编辑器状态（打开过哪些文件、光标在哪、分割比例） */
  getEditorSession(): Promise<EditorSession>
  /** 落盘编辑器状态。关窗时调一次，以及拖动分割条结束后 */
  setEditorSession(session: EditorSession): Promise<boolean>

  /** 撤销最近一次 AI / 手工修改。不传 path 就是全局最近一条 */
  undoChange(path?: string): Promise<UndoOutcome>
  /** 列出可撤销的记录（只有摘要，不含文件正文） */
  listSnapshots(): Promise<SnapshotSummary[]>

  aiChat(requestId: string, messages: ChatMessage[]): Promise<void>
  aiAbort(requestId: string): Promise<boolean>
  aiTest(): Promise<AiTestResult>
  aiListModels(): Promise<ModelListResult>

  onAiStream(cb: (chunk: AiStreamChunk) => void): () => void
  onLog(cb: (line: LogLine) => void): () => void
  onMenu(cb: (action: string) => void): () => void
  /** 工作区里文件被改动（AI 工具写入、或外部程序改了） */
  onFileChanged(cb: (event: FileChangeEvent) => void): () => void
}
