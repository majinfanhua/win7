import { create } from 'zustand'

/**
 * 应用内确认框（Promise 版）。
 *
 * ## 为什么必须有它
 *
 * 这个项目**已经**为此踩过一次坑，而且踩得很难看：
 *
 *   Electron 里 `window.confirm` / `alert` 会**阻塞渲染进程**。
 *   阻塞期间整个界面不响应，而且原生模态框会吞掉 `mouseup` 事件 ——
 *   渲染层于是认为鼠标一直按着，之后**点什么都点不中**，
 *   连输入框都进不去，只能重启应用。
 *
 * `components/ConfirmDialog.tsx` 的文件头早就把这条写清楚了，
 * 但「删除文件」和「未保存改动」这两条路仍在用 `window.confirm` ——
 * 症状正是用户报的「删掉一个文件后输入框选不中」。
 *
 * ## 为什么做成 Promise
 *
 * 调用方是**store 里的异步流程**（删除文件、关标签、换项目），
 * 它们不是组件、没法自己渲染弹层。用一个 Promise 把「问用户」
 * 这件事变成可 await 的一步，调用方写法与 `window.confirm` 几乎一样：
 *
 *     if ((await askConfirm({...})) !== 'yes') return
 *
 * ## 为什么是独立模块、不放进 useAppStore
 *
 * store 的 slice 要用它（tree-slice 删文件、editor-slice 关标签），
 * 而它又要被 App 渲染。若把它塞进 useAppStore，就变成
 * `slice → useAppStore → slice` 的自引用。
 * 这里不 import 任何应用模块，依赖方向是干净的单向。
 */

export interface ConfirmAction {
  /** 返回值。调用方据此判断用户选了什么 */
  id: string
  label: string
  /** 视觉：primary 强调色 / danger 危险色 / ghost 次要 */
  kind?: 'primary' | 'danger' | 'ghost'
}

export interface ConfirmRequest {
  title: string
  /** 正文段落，一行一段 */
  lines: string[]
  actions: ConfirmAction[]
  /** 想让用户多用一秒看清楚时给 true（删除、放弃修改这类不可逆操作） */
  tone?: 'danger'
}

interface ConfirmState {
  request: ConfirmRequest | null
  resolve: ((id: string) => void) | null
  open: (req: ConfirmRequest, resolve: (id: string) => void) => void
  close: () => void
}

export const useConfirmStore = create<ConfirmState>((set) => ({
  request: null,
  resolve: null,
  open: (request, resolve) => set({ request, resolve }),
  close: () => set({ request: null, resolve: null })
}))

/**
 * 问用户一个问题，等他的选择。
 *
 * 返回选中的 action id；用户按 Esc / 点遮罩关闭时返回 `''`。
 * 调用方**必须**把 `''` 当作「取消」处理（什么都不做）——
 * 把它当确认会让「随手按 Esc」变成破坏性操作。
 */
export async function askConfirm(req: ConfirmRequest): Promise<string> {
  return new Promise<string>((resolve) => {
    const done = (id: string): void => {
      useConfirmStore.getState().close()
      resolve(id)
    }
    useConfirmStore.getState().open(req, done)
  })
}

/**
 * 未保存改动的三选一。
 *
 * 返回 `save` / `discard` / `cancel`。
 *
 * 与原来的实现（连着弹两次 confirm）相比，这里合成**一个**三按钮弹层：
 *   - 原来第一次问「要保存吗」，按「否」之后再问一次「真放弃吗」——
 *     两次都只有「确定/取消」两个按钮，含义还得靠正文解释，很容易选错
 *   - 现在三个按钮各自写清后果，一次选完，不必记上一轮问了什么
 *
 * 安全性没有放松：要丢代码必须点那个明确写着「不保存并放弃」的按钮，
 * 而它**不是**默认焦点（默认焦点在「取消」上，连按回车不会丢东西）。
 */
export type UnsavedChoice = 'save' | 'discard' | 'cancel'

export async function askUnsaved(what: string, opts?: { multiple?: boolean }): Promise<UnsavedChoice> {
  const target = opts?.multiple ? '这些文件' : `「${what}」`
  const choice = await askConfirm({
    title: '有未保存的修改',
    lines: [
      `${target}还有未保存的修改。`,
      '放弃之后内容无法找回 —— 撤销记录里没有未保存的内容。'
    ],
    tone: 'danger',
    actions: [
      // 默认焦点在「取消」：连按回车时留在原地，不会误丢代码
      { id: 'cancel', label: '取消', kind: 'ghost' },
      { id: 'discard', label: '不保存并放弃', kind: 'danger' },
      { id: 'save', label: '先保存再继续', kind: 'primary' }
    ]
  })
  if (choice === 'save') return 'save'
  if (choice === 'discard') return 'discard'
  return 'cancel'
}
