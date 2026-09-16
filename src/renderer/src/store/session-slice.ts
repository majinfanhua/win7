import type { StateCreator } from 'zustand'
import type { LogLine } from '@shared/types'
import { RECENT_SESSIONS_MAX } from '@shared/types'
import { titleFrom } from './explorer-helpers'
import type { AppState, SessionSlice } from './types'

/**
 * 会话 slice：会话索引与正文、消息、日志、快照、配置。
 *
 * 这是三个 slice 里**最底层**的一个，不依赖另外两个。
 * 依赖方向是单向的：editor → tree → session，反向调用会让循环 import 爆炸。
 */

/** 会话落盘与编辑器状态落盘的防抖句柄（模块级，见各自注释） */
let persistTimer: ReturnType<typeof setTimeout> | null = null

/** 日志环形缓冲上限。与主进程 logger 的 MAX_BUFFER 取同一个量级 */
const LOGS_MAX = 500

export const createSessionSlice: StateCreator<AppState, [], [], SessionSlice> = (set, get) => ({
  sessions: [],
  sessionId: '',
  messages: [],
  sessionLoading: false,
  logs: [],
  config: null,
  runtime: null,
  snapshots: [],
  sessionSwitchAt: 0,

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
   * 归档当前会话。
   *
   * 先 persistSession() 并**等它落盘**再调归档 —— 归档总结读的是磁盘上的
   * sessions/<id>.json，而落盘是防抖 400ms 的。不等的话，用户刚问完最后
   * 一句话就点归档，总结读到的正文会缺最后几条（甚至读到空文件）。
   *
   * 所以这里不用 persistSession（它是防抖的，没法等），直接同步落一次。
   */
  async archiveSession(id) {
    try {
      const current = get()
      if (current.sessionId === id && current.messages.length > 0) {
        const title = titleFrom(current.messages.find((m) => m.role === 'user')?.text || id)
        await window.api.saveSession({
          id,
          title,
          workspace: current.workspace,
          updatedAt: new Date().toISOString(),
          messages: current.messages
        })
      }
      const result = await window.api.archiveSession(id)
      // 索引里的 archived 标记由主进程改，这里重新拉一次拿到最新列表
      set({ sessions: await window.api.listSessions() })
      return result.message
    } catch (err) {
      return `归档失败：${err instanceof Error ? err.message : String(err)}`
    }
  },

  async unarchiveSession(id) {
    try {
      const result = await window.api.unarchiveSession(id)
      set({ sessions: await window.api.listSessions() })
      return result.message
    } catch (err) {
      return `取消归档失败：${err instanceof Error ? err.message : String(err)}`
    }
  },

  /**
   * 点开左侧历史会话。
   *
   * 先把当前会话存盘再切 —— 否则「问了半句 → 点另一条会话 → 点回来」
   * 会发现刚才那句话不见了。
   *
   * 如果当前有流式回答在跑，**必须先中断**：
   * AiPanel 的 requestId 只认它自己发起的那个请求，切换会话后
   * `syncStore()` 仍会把这一轮的完整回答写进 `messages` —— 而那已经是
   * 另一条会话的容器了。结果是回答的尾部落进错误的会话记录里。
   * 中断这一步放在这里而不是 AiPanel：openSession 是「切会话」这件事的
   * 唯一入口，把守卫挂在入口上才不会有漏网的调用路径。
   */
  async openSession(id) {
    if (get().sessionId === id) return
    // 通知界面中断在飞的请求。用时间戳而不是直接 import AiPanel：
    // store 不该知道组件的存在，而 AiPanel 订阅它即可
    set({ sessionSwitchAt: Date.now() })
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
    set({ logs: logs.length > LOGS_MAX ? logs.slice(logs.length - LOGS_MAX) : logs })
  },

  clearLogs() {
    set({ logs: [] })
  },

  async loadConfig() {
    set({ config: await window.api.getConfig() })
  },

  applyConfig(config) {
    set({ config, treeOpen: config.explorer.treeOpen })
  },

  async refreshSnapshots() {
    try {
      set({ snapshots: await window.api.listSnapshots() })
    } catch {
      set({ snapshots: [] })
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
  }
})

/** 会话标题的最大长度（与主进程 config.ts 的截断保持一致） */
export const SESSION_TITLE_LIMIT = RECENT_SESSIONS_MAX

/** 供测试与外部使用：取消待执行的会话落盘 */
export function cancelPersist(): void {
  if (persistTimer) {
    clearTimeout(persistTimer)
    persistTimer = null
  }
}
