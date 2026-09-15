import { contextBridge, ipcRenderer } from 'electron'
import { IPC } from '../shared/types'
import type { AppApi } from '../shared/api'
import type {
  AiStreamChunk,
  AppConfig,
  ChatMessage,
  EditorSession,
  FileChangeEvent,
  LogLine,
  StoredSession
} from '../shared/types'

/** 把 ipcRenderer.on 封装成返回取消订阅函数的订阅器 */
function subscribe<T>(channel: string, cb: (payload: T) => void): () => void {
  const listener = (_event: Electron.IpcRendererEvent, payload: T): void => cb(payload)
  ipcRenderer.on(channel, listener)
  return () => {
    ipcRenderer.removeListener(channel, listener)
  }
}

const api: AppApi = {
  runtime: () => ipcRenderer.invoke(IPC.appRuntime),
  doctor: () => ipcRenderer.invoke(IPC.appDoctor),
  openLogs: () => ipcRenderer.invoke(IPC.appOpenLogs),
  capabilities: () => ipcRenderer.invoke(IPC.appCapabilities),

  getConfig: () => ipcRenderer.invoke(IPC.configGet),
  setConfig: (patch: Partial<AppConfig>) => ipcRenderer.invoke(IPC.configSet, patch),

  openWorkspace: (preset?: string) => ipcRenderer.invoke(IPC.wsOpen, preset),
  readDir: (dir: string) => ipcRenderer.invoke(IPC.wsReadDir, dir),
  readFile: (file: string) => ipcRenderer.invoke(IPC.wsReadFile, file),
  writeFile: (file: string, content: string) => ipcRenderer.invoke(IPC.wsWriteFile, file, content),
  createEntry: (parent: string, name: string, kind: 'file' | 'dir') =>
    ipcRenderer.invoke(IPC.wsCreate, parent, name, kind),
  rename: (from: string, newName: string) => ipcRenderer.invoke(IPC.wsRename, from, newName),
  moveEntry: (from: string, destDir: string) => ipcRenderer.invoke(IPC.wsMove, from, destDir),
  remove: (target: string) => ipcRenderer.invoke(IPC.wsDelete, target),

  listWorkspaces: () => ipcRenderer.invoke(IPC.wsList),
  removeRecentWorkspace: (path: string) => ipcRenderer.invoke(IPC.wsRemoveRecent, path),
  revealInOs: (target: string) => ipcRenderer.invoke(IPC.wsReveal, target),
  previewInBrowser: (target: string) => ipcRenderer.invoke(IPC.wsPreview, target),
  previewUrl: (target: string) => ipcRenderer.invoke(IPC.wsPreviewUrl, target),
  setShowHidden: (showHidden: boolean) => ipcRenderer.invoke(IPC.wsSetHidden, showHidden),

  listSessions: () => ipcRenderer.invoke(IPC.sessionList),
  touchSession: (entry: { id: string; title: string; workspace: string; messageCount: number }) =>
    ipcRenderer.invoke(IPC.sessionTouch, entry),
  removeSession: (id: string) => ipcRenderer.invoke(IPC.sessionRemove, id),
  loadSession: (id: string) => ipcRenderer.invoke(IPC.sessionLoad, id),
  saveSession: (session: StoredSession) => ipcRenderer.invoke(IPC.sessionSave, session),

  getEditorSession: () => ipcRenderer.invoke(IPC.editorSessionGet),
  setEditorSession: (session: EditorSession) => ipcRenderer.invoke(IPC.editorSessionSet, session),

  undoChange: (target?: string) => ipcRenderer.invoke(IPC.editorUndo, target),
  listSnapshots: () => ipcRenderer.invoke(IPC.editorListSnapshots),

  aiChat: (requestId: string, messages: ChatMessage[]) => ipcRenderer.invoke(IPC.aiChat, requestId, messages),
  aiAbort: (requestId: string) => ipcRenderer.invoke(IPC.aiAbort, requestId),
  aiTest: () => ipcRenderer.invoke(IPC.aiTest),
  aiListModels: () => ipcRenderer.invoke(IPC.aiListModels),

  onAiStream: (cb: (chunk: AiStreamChunk) => void) => subscribe<AiStreamChunk>(IPC.evtAiStream, cb),
  onLog: (cb: (line: LogLine) => void) => subscribe<LogLine>(IPC.evtLog, cb),
  onMenu: (cb: (action: string) => void) => subscribe<string>(IPC.evtMenu, cb),
  onFileChanged: (cb: (event: FileChangeEvent) => void) =>
    subscribe<FileChangeEvent>(IPC.evtFileChanged, cb)
}

contextBridge.exposeInMainWorld('api', api)
