import { create } from 'zustand'
import { createEditorSlice, restoreTabs } from './editor-slice'
import { createSessionSlice } from './session-slice'
import { createTreeSlice } from './tree-slice'
import type { AppState, ShellSlice } from './types'

/**
 * 应用状态。
 *
 * ## 结构
 *
 * 这个文件只负责**组装**，具体逻辑在三个 slice 里：
 *
 * | 文件 | 管什么 |
 * |---|---|
 * | `session-slice.ts` | 会话与消息、日志、快照、配置 |
 * | `tree-slice.ts` | 工作区、文件树、增删改名移动、拖拽、引用 |
 * | `editor-slice.ts` | 标签页、内容、光标、保存、文件变化响应 |
 * | `types.ts` | 三个 slice 的状态形状与依赖关系 |
 * | `dialogs.ts` | 「要保存吗」确认框（tree 与 editor 都要用，避免互相 import）|
 * | `explorer-helpers.ts` | 排序 / 扩展名 / 父目录等纯函数 |
 *
 * 依赖方向是**单向**的：editor → tree → session。
 * 反向调用会让循环 import 立刻爆炸，新增跨 slice 操作前先确认方向。
 *
 * ## 为什么拆
 *
 * 这个文件曾经 1100 行，项目自己的红线是 800 行。更要紧的不是行数，
 * 是「改一处不知道会影响谁」—— 它同时管着会话、文件树、编辑器、日志、
 * 快照五件事，而这几件之间几乎不互相调用。
 *
 * ## 为什么还是一个 store
 *
 * 组件里读的仍然是同一个 `useAppStore`（`useAppStore((s) => s.tabs)` 照旧），
 * slice 只是把**定义**分开。拆成三个独立 store 的话，「打开文件同时要动
 * 标签和文件树」这类操作就变成跨 store 事务了。
 */

/** 应用外壳：启动流程。它同时要碰三个 slice，所以单独放这里 */
const createShellSlice = (
  set: (partial: Partial<AppState>) => void,
  get: () => AppState
): ShellSlice => ({
  ready: false,

  async init() {
    const [runtime, config, workspaces, sessions] = await Promise.all([
      window.api.runtime(),
      window.api.getConfig(),
      window.api.listWorkspaces(),
      window.api.listSessions()
    ])
    set({
      runtime,
      config,
      workspaces,
      sessions,
      treeOpen: config.explorer.treeOpen,
      split: config.editorSession.split,
      ready: true
    })
    // 上次的工作区在 main 侧已经恢复过了，这里把文件树真正读出来
    if (config.lastWorkspace) await get().loadRoot(config.lastWorkspace)
    // 恢复上次打开的文件。放在 loadRoot 之后：工作区没就绪时 readFile 会被拒绝
    await restoreTabs(useAppStore, config.editorSession)
  }
})

export const useAppStore = create<AppState>((...args) => {
  const [set, get] = args
  return {
    ...createSessionSlice(...args),
    ...createTreeSlice(...args),
    ...createEditorSlice(...args),
    ...createShellSlice(set as (partial: Partial<AppState>) => void, get)
  }
})

/**
 * 文件树排序与扩展名工具在 explorer-helpers.ts —— 这里只安排一次转出，
 * 避免调用方要记住两个 import 路径。
 */
export { extOf, parentDirOf, sortNodesBy } from './explorer-helpers'

export type { EditorTab, AppState } from './types'
