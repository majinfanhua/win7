/** 「要保存吗」的三个选项 */
export type UnsavedChoice = 'save' | 'discard' | 'cancel'

/**
 * 未保存改动的确认框。
 *
 * 单独一个模块，因为 tree slice（换项目）与 editor slice（关标签）都要用它，
 * 而两个 slice 不该互相 import —— 那会绕成循环依赖。
 *
 * 用 `window.confirm` 而不是自绘弹层：Electron 里 confirm 是可用的
 * （只有 prompt 被移除，那是另一个坑），而这里只需要三选一。
 *
 * confirm 只有两个按钮，所以把「丢弃」做成第二轮确认 —— 按「取消」= 留在原地。
 * 两次确认才允许真的丢代码：一次 confirm 就把学生写的东西删掉太廉价了。
 *
 * 文案刻意把三条出路都写出来：只问「要保存吗」的话，
 * 按「否」到底等于丢弃还是取消，学生根本没法判断。
 */
export async function askUnsaved(what: string, opts?: { multiple?: boolean }): Promise<UnsavedChoice> {
  const body = opts?.multiple ? what : `「${what}」还有未保存的修改。\n`
  const save = window.confirm(
    `${body}\n点「确定」= 先保存再继续\n点「取消」= 不保存并放弃这些修改\n`
  )
  if (save) return 'save'
  const discard = window.confirm(
    `确定放弃${opts?.multiple ? '这些' : '这个'}文件的修改吗？\n\n放弃后内容无法找回（撤销记录里没有未保存的内容）。`
  )
  return discard ? 'discard' : 'cancel'
}
