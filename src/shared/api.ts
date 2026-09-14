import type {
  AiStreamChunk,
  AiTestResult,
  AppConfig,
  ChatMessage,
  DoctorReport,
  FileNode,
  LoadedFile,
  LogLine,
  ModelListResult,
  RuntimeInfo
} from './types'

/**
 * 渲染进程能看到的全部能力。
 * 预加载层必须严格实现这个接口，渲染进程只能通过 window.api 访问主进程。
 */
export interface AppApi {
  runtime(): Promise<RuntimeInfo>
  doctor(): Promise<DoctorReport>
  openLogs(): Promise<string>

  getConfig(): Promise<AppConfig>
  setConfig(patch: Partial<AppConfig>): Promise<AppConfig>

  openWorkspace(preset?: string): Promise<string>
  readDir(dir: string): Promise<FileNode[]>
  readFile(file: string): Promise<LoadedFile>
  writeFile(file: string, content: string): Promise<boolean>
  createEntry(parent: string, name: string, kind: 'file' | 'dir'): Promise<string>
  rename(from: string, newName: string): Promise<string>
  remove(target: string): Promise<boolean>

  aiChat(requestId: string, messages: ChatMessage[]): Promise<void>
  aiAbort(requestId: string): Promise<boolean>
  aiTest(): Promise<AiTestResult>
  aiListModels(): Promise<ModelListResult>

  onAiStream(cb: (chunk: AiStreamChunk) => void): () => void
  onLog(cb: (line: LogLine) => void): () => void
  onMenu(cb: (action: string) => void): () => void
}
