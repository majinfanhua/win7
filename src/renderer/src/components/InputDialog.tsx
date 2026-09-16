import { useEffect, useRef, useState } from 'react'

/**
 * 应用内输入弹层。
 *
 * 为什么必须有它：Electron 里 **`window.prompt` 不被支持** ——
 * 调用它不会弹框，而是直接抛错并返回 undefined。
 * 文件树的新建 / 重命名原本全靠 prompt，所以真机上点「新建文件」什么也不会发生，
 * 这就是「只能建文件夹、建不了文件」的根因。
 *
 * 所以这里自己实现一个：遮罩 + 居中卡片 + 输入框 + 校验错误行，
 * 复用 dialog.css 的 .overlay / .dialog / .field 原语，不新造视觉语言。
 *
 * 行为上守三条约定（都是真机上踩过的）：
 *   - 打开即聚焦并选中文件名主干（不含扩展名），改名时不用先删掉 `.html`
 *   - Enter 提交、Esc 取消（Esc 交给 App 的全局监听处理，这里 stopPropagation）
 *   - 打开期间锁住 body 滚动，否则弹层里滚轮会带着后面的文件树一起滚
 */

type Props = {
  title: string
  /** 输入框标签，如「名称」 */
  label: string
  initial: string
  placeholder?: string
  /** 输入框下方的固定说明（校验错误单独一行，红色） */
  hint?: string
  confirmText?: string
  /** 返回中文错误原因，空串表示通过 */
  validate: (value: string) => string
  /** 提交时可能异步失败，返回错误原因则弹层不关闭并显示该原因 */
  onSubmit: (value: string) => Promise<string>
  onCancel: () => void
  /** 弹层里除了输入框还要渲染的东西（新建弹层的类型胶囊就从这里进去） */
  children?: React.ReactNode
  /**
   * 输入内容变化时回调。
   *
   * 新建弹层用它把「当前输入的名字」接出去 —— 类型胶囊要跟着
   * 名字里的扩展名走（打 a.css 就高亮 CSS），而那需要知道用户敲了什么。
   * 可选：重命名弹层不关心这个。
   */
  onValueChange?: (value: string) => void
}

/** 只在第一次渲染时算一次：选中主干所需的 offset 与长度 */
function splitName(name: string): { start: number; end: number } {
  const dot = name.lastIndexOf('.')
  if (dot <= 0) return { start: 0, end: name.length }
  return { start: 0, end: dot }
}

export default function InputDialog({
  title,
  label,
  initial,
  placeholder,
  hint,
  confirmText = '创建',
  validate,
  onSubmit,
  onCancel,
  children,
  onValueChange: notifyChange
}: Props): JSX.Element {
  const [value, setValue] = useState(initial)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const inputRef = useRef<HTMLInputElement | null>(null)

  // 聚焦 + 选中主干。放在 rAF 里：弹层的挂载与首次布局还没完成时
  // setSelectionRange 在部分老 Chromium 上会被忽略
  useEffect(() => {
    const id = window.requestAnimationFrame(() => {
      const el = inputRef.current
      if (!el) return
      el.focus()
      const { start, end } = splitName(initial)
      el.setSelectionRange(start, end)
    })
    return () => window.cancelAnimationFrame(id)
  }, [initial])

  // 锁 body 滚动：弹层在时后面的文件树不该跟着滚
  useEffect(() => {
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = prev
    }
  }, [])

  /** 提交。三道关：本地校验 → onSubmit → 失败原因留在弹层里 */
  const submit = async (): Promise<void> => {
    if (busy) return
    const reason = validate(value)
    if (reason) {
      setError(reason)
      return
    }
    setBusy(true)
    setError('')
    try {
      const failed = await onSubmit(value.trim())
      // 失败时不关闭弹层：关掉之后原因就没地方显示了，
      // 学生只会看到「点了没反应」，与最初的 bug 表现一样
      if (failed) setError(failed)
    } finally {
      setBusy(false)
    }
  }

  /** 边输边清错误：错误还挂在屏幕上但用户已经在改了，会很困惑 */
  const onValueChange = (next: string): void => {
    setValue(next)
    notifyChange?.(next)
    if (error) setError(validate(next))
  }

  return (
    <div className="overlay" onMouseDown={onCancel}>
      <div
        className="dialog is-narrow"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            void submit()
          }
          if (e.key === 'Escape') {
            // 不 stopPropagation 的话 App 的全局 Esc 会顺带把设置页也关掉
            e.stopPropagation()
            onCancel()
          }
        }}
      >
        <div className="dialog-head">
          <h2>{title}</h2>
        </div>

        {children}

        <div className="field">
          <label htmlFor="input-dialog-name">{label}</label>
          <input
            id="input-dialog-name"
            ref={inputRef}
            value={value}
            spellCheck={false}
            autoComplete="off"
            placeholder={placeholder}
            aria-invalid={error ? 'true' : undefined}
            aria-describedby={error ? 'input-dialog-error' : undefined}
            onChange={(e) => onValueChange(e.target.value)}
          />
          {error ? (
            <div className="field-error" id="input-dialog-error" role="alert">
              {error}
            </div>
          ) : (
            hint && <div className="hint">{hint}</div>
          )}
        </div>

        <div className="dialog-actions">
          <span className="spacer" />
          <button className="ghost" onClick={onCancel} disabled={busy}>
            取消
          </button>
          <button className="primary" onClick={() => void submit()} disabled={busy}>
            {busy ? '处理中…' : confirmText}
          </button>
        </div>
      </div>
    </div>
  )
}
