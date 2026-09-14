import { create } from 'zustand'
import type { AppConfig, FileNode, LogLine, RuntimeInfo } from '@shared/types'
import { languageFromPath } from '@shared/language'

/** 内置欢迎页用虚拟路径，不可保存 */
export const WELCOME_PATH = '__welcome__'

export interface EditorTab {
  path: string
  name: string
  content: string
  language: string
  dirty: boolean
}

const WELCOME = [
  '# 欢迎使用 AI 教学编辑器',
  '',
  '这是一个面向教学的代码编辑器，支持 Windows 7 SP1 及以上系统。',
  '',
  '## 开始使用',
  '',
  '1. 点左上角「打开文件夹」，选一个目录作为工作区',
  '2. 在左侧文件树里双击文件即可编辑',
  '3. 右侧「AI 教学助手」需要先在「设置 → AI 模型」中配置中转站地址和密钥',
  '',
  '## 两个常用快捷键',
  '',
  '- Ctrl+S  保存当前文件',
  '- Ctrl+,  打开设置',
  '',
  '## 遇到启动问题？',
  '',
  '菜单「帮助 → 运行环境体检」会检查系统版本、运行库、渲染模式，',
  '把结果截图发给老师即可定位问题。',
  ''
].join('\n')

function baseName(filePath: string): string {
  const parts = filePath.split(/[\\/]/)
  return parts[parts.length - 1] || filePath
}

interface AppState {
  ready: boolean
  workspace: string
  childMap: Record<string, FileNode[]>
  expanded: Record<string, boolean>
  tabs: EditorTab[]
  activePath: string
  logs: LogLine[]
  runtime: RuntimeInfo | null
  config: AppConfig | null
  outputOpen: boolean

  init: () => Promise<void>
  openWorkspace: () => Promise<void>
  loadRoot: (dir: string) => Promise<void>
  toggleDir: (dir: string) => Promise<void>
  openFile: (file: string) => Promise<void>
  setActive: (path: string) => void
  setContent: (path: string, content: string) => void
  saveActive: () => Promise<void>
  closeTab: (path: string) => void
  pushLog: (line: LogLine) => void
  loadConfig: () => Promise<void>
  applyConfig: (config: AppConfig) => void
  toggleOutput: () => void
}

export const useAppStore = create<AppState>((set, get) => ({
  ready: false,
  workspace: '',
  childMap: {},
  expanded: {},
  tabs: [{ path: WELCOME_PATH, name: '欢迎.md', content: WELCOME, language: 'markdown', dirty: false }],
  activePath: WELCOME_PATH,
  logs: [],
  runtime: null,
  config: null,
  outputOpen: false,

  async init() {
    const [runtime, config] = await Promise.all([window.api.runtime(), window.api.getConfig()])
    // 当前版本没有文件树，不需要在启动时恢复上次的工作区
    set({ runtime, config, ready: true })
  },

  async loadRoot(dir: string) {
    try {
      const nodes = await window.api.readDir(dir)
      set({ workspace: dir, childMap: { ...get().childMap, [dir]: nodes } })
    } catch (err) {
      get().pushLog({ time: '', level: 'error', scope: 'tree', text: `读取目录失败: ${String(err)}` })
    }
  },

  async openWorkspace() {
    const dir = await window.api.openWorkspace()
    if (dir) await get().loadRoot(dir)
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
    if (!get().childMap[dir]) await get().loadRoot(dir)
  },

  async openFile(file: string) {
    if (get().tabs.some((t) => t.path === file)) {
      set({ activePath: file })
      return
    }
    try {
      const loaded = await window.api.readFile(file)
      const tab: EditorTab = {
        path: loaded.path,
        name: baseName(loaded.path),
        content: loaded.content,
        language: loaded.language || languageFromPath(loaded.path),
        dirty: false
      }
      set({ tabs: [...get().tabs, tab], activePath: loaded.path })
    } catch (err) {
      get().pushLog({ time: '', level: 'error', scope: 'file', text: `打开失败: ${String(err)}` })
    }
  },

  setActive(path: string) {
    set({ activePath: path })
  },

  setContent(path: string, content: string) {
    set({
      tabs: get().tabs.map((t) => (t.path === path ? { ...t, content, dirty: true } : t))
    })
  },

  async saveActive() {
    const tab = get().tabs.find((t) => t.path === get().activePath)
    if (!tab || tab.path === WELCOME_PATH) return
    try {
      await window.api.writeFile(tab.path, tab.content)
      set({ tabs: get().tabs.map((t) => (t.path === tab.path ? { ...t, dirty: false } : t)) })
      get().pushLog({ time: '', level: 'info', scope: 'file', text: `已保存 ${tab.path}` })
    } catch (err) {
      get().pushLog({ time: '', level: 'error', scope: 'file', text: `保存失败: ${String(err)}` })
    }
  },

  closeTab(path: string) {
    const tabs = get().tabs.filter((t) => t.path !== path)
    const activePath =
      get().activePath === path ? (tabs.length ? tabs[tabs.length - 1].path : '') : get().activePath
    set({ tabs, activePath })
  },

  pushLog(line: LogLine) {
    const logs = [...get().logs, line]
    set({ logs: logs.length > 500 ? logs.slice(logs.length - 500) : logs })
  },

  async loadConfig() {
    set({ config: await window.api.getConfig() })
  },

  applyConfig(config: AppConfig) {
    set({ config })
  },

  toggleOutput() {
    set({ outputOpen: !get().outputOpen })
  }
}))
