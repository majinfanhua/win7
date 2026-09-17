import type { StateCreator } from 'zustand'
import type { EditorSession, OpenTab } from '@shared/types'
import { EDITOR_TABS_MAX } from '@shared/types'
import { languageFromPath } from '@shared/language'
import { baseName, parentDirOf } from './explorer-helpers'
import { askUnsaved } from './confirm'
import type { AppState, EditorSlice, EditorTab } from './types'

/**
 * 编辑器 slice：标签页、内容、光标、保存、会话恢复、文件变化响应。
 *
 * 依赖会话 slice（记日志）与文件树 slice（刷目录），但不被它们依赖。
 */

let editorSessionTimer: ReturnType<typeof setTimeout> | null = null

export const createEditorSlice: StateCreator<AppState, [], [], EditorSlice> = (set, get) => ({
  tabs: [],
  activePath: '',

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
        // 主进程会为超大文件返回占位说明，这个标记决定它能不能被保存
        truncated: Boolean(loaded.truncated),
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

  setActive(path) {
    set({ activePath: path })
    get().persistEditorSession()
  },

  setContent(path, content) {
    set({
      tabs: get().tabs.map((t) => (t.path === path ? { ...t, content, dirty: true } : t))
    })
  },

  setCursor(path, line, column) {
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
    /*
     * ★ 内容不完整的标签一律不许保存。
     *
     * 超大文件打开时，主进程给的是「// 文件过大…已跳过加载。」这段**占位文本**。
     * 不拦的话，用户按一下 Ctrl+S 就会用这句注释覆盖掉原文件 ——
     * 不可逆，而且他完全不知道发生了什么（界面看起来就是「保存成功」）。
     *
     * 这里必须拦住，而不是指望用户自己注意：界面上的内容与真实文件
     * 长得一样，没有任何视觉线索提示「这不是真内容」。
     */
    if (tab.truncated) {
      get().pushLog({
        time: '',
        level: 'warn',
        scope: 'file',
        text: `${baseName(tab.path)} 太大，只加载了说明文字，不能保存（保存会覆盖原文件）。请用别的编辑器打开。`
      })
      return
    }
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

  closeTab(path) {
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

  /**
   * 关标签，但先处理未保存的改动。
   *
   * 为什么单独一个动作而不是把守卫塞进 closeTab：
   * closeTab 还被「文件已删除」「重命名」这些**非用户主动**的路径调用，
   * 那些情况下弹一个「要保存吗」是纯粹的干扰。守卫只该挂在用户真的
   * 点了 × 这条路径上（见 EditorPane 的 onClose）。
   *
   * 返回 'saved'（已保存并关闭）/ 'discarded'（丢弃并关闭）/ 'cancelled'。
   */
  async closeTabChecked(path) {
    const tab = get().tabs.find((t) => t.path === path)
    if (!tab) return 'cancelled'
    if (!tab.dirty) {
      get().closeTab(path)
      return 'discarded'
    }
    const name = baseName(path)
    const choice = await askUnsaved(name)
    if (choice === 'cancel') return 'cancelled'
    if (choice === 'save') {
      // 保存到**这个**路径，不是 activePath —— 右键关一个非当前标签时两者不同
      try {
        await window.api.writeFile(path, tab.content)
        get().pushLog({ time: '', level: 'info', scope: 'file', text: `已保存 ${path}` })
        void get().refreshSnapshots()
      } catch (err) {
        get().pushLog({
          time: '',
          level: 'error',
          scope: 'file',
          text: `保存失败，标签未关闭: ${String(err)}`
        })
        // 保存失败就**不关**：关掉等于把内容丢了，而那正是这次守卫要防的事
        return 'cancelled'
      }
    }
    get().closeTab(path)
    return choice === 'save' ? 'saved' : 'discarded'
  },

  /**
   * 换工作区前的守卫。
   *
   * openWorkspace / openWorkspaceAt 会把 tabs 整个清空 —— 学生改了文件没存、
   * 顺手点了左侧另一个项目，改动就无声消失了。这和 README 里
   * 「绝不覆盖学生未保存改动」是同一条原则的两个面：那条守的是 AI 写入路径，
   * 这条守的是关闭路径。
   *
   * 返回 true 表示可以继续换。
   */
  async confirmLeaveWorkspace() {
    const dirty = get().tabs.filter((t) => t.dirty)
    if (dirty.length === 0) return true
    const names = dirty.map((t) => baseName(t.path)).join('、')
    const message =
      dirty.length === 1
        ? `「${names}」还有未保存的修改。`
        : `这 ${dirty.length} 个文件还有未保存的修改：\n${names}\n`
    const choice = await askUnsaved(message, { multiple: true })
    if (choice === 'cancel') return false
    if (choice === 'save') {
      let failed = 0
      for (const tab of dirty) {
        try {
          await window.api.writeFile(tab.path, tab.content)
        } catch (err) {
          failed++
          get().pushLog({
            time: '',
            level: 'error',
            scope: 'file',
            text: `保存 ${tab.path} 失败: ${String(err)}`
          })
        }
      }
      if (failed > 0) {
        // 有一个没存上就不能换 —— 换了这些标签就被清掉了，没存的内容再也找不回来
        get().pushLog({
          time: '',
          level: 'error',
          scope: 'file',
          text: `有 ${failed} 个文件保存失败，已取消切换项目。请先处理后重试。`
        })
        return false
      }
      void get().refreshSnapshots()
    }
    return true
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
   *
   * ⚠️ 第 3 条的警告走 `pushLog`，所以**日志抽屉必须存在** ——
   * 没有消费者的话这条警告等于没发（踩过一次，见 LogDrawer 的注释）。
   */
  async handleFileChanged(event) {
    const tab = get().tabs.find((t) => t.path === event.path)

    // 目录内容可能变了（新建/删除），刷一下它所在的目录
    void get().refreshDir(parentDirOf(event.path))
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
    } catch {
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
})

/**
 * 按上次退出时的状态恢复标签页。
 *
 * 逐个 try：某个文件可能已被删除或移动，那就不恢复它、继续恢复其余的，
 * 而不是一个失败就整批放弃 —— 学生打开五个文件，其中一个被删了，
 * 不该让另外四个也白开。
 */
export async function restoreTabs(
  store: { getState: () => AppState },
  session: EditorSession
): Promise<void> {
  if (!session.tabs.length) return
  for (const item of session.tabs) {
    try {
      await store.getState().openFile(item.path, item.line, item.column)
    } catch {
      /* 单个文件恢复失败就跳过，openFile 内部已经记了日志 */
    }
  }
  // 激活项在最后设：openFile 每次都会把新标签设成 active，
  // 恢复完再切回上次真正在看的那个
  if (session.activePath) store.getState().setActive(session.activePath)
}
