import { useEffect } from 'react'

/**
 * 应用内确认弹层。
 *
 * 复用 dialog.css 的 .overlay / .dialog 原语，不新造视觉语言 ——
 * 与 InputDialog 是同一套外壳，只是内容换成「一句话 + 两个按钮」。
 *
 * ## 为什么不用 window.confirm
 *
 * Electron 里 `window.confirm` 会**阻塞渲染进程**：它弹出期间整个界面
 * 卡住不动（连输入框都点不了）。而权限模式这种确认以后可能要
 * 边说边看上下文，阻塞式弹窗会让人没法核对。
 * `window.alert` / `prompt` 同理（prompt 在 Electron 里甚至直接不支持）。
 *
 * ## 为什么危险操作的确认按钮不做成默认焦点
 *
 * 默认焦点放在**取消**上。用户连按两下回车（或习惯性确认）时，
 * 落到的是取消而不是「确认放开权限」。这类「误加速」在危险操作上
 * 是最常见的失误来源，代价又不可逆。
 */

type Props = {
  title: string
  /** 正文。支持传节点，因为危险提示常要分段或强调 */
  children: React.ReactNode
  /** 确认按钮文字。写得具体（如「我明白，完全放开」）而不是「确定」 */
  confirmText: string
  /** 取消按钮文字 */
  cancelText?: string
  /** 确认按钮是否用危险色。放开权限类操作应当为 true */
  danger?: boolean
  onConfirm: () => void
  onCancel: () => void
}

export default function ConfirmDialog({
  title,
  children,
  confirmText,
  cancelText = '取消',
  danger = false,
  onConfirm,
  onCancel
}: Props): JSX.Element {
  /*
   * Esc 关闭。
   *
   * 这里直接监听并 stopPropagation：App 的全局 Esc 只处理设置页/弹层，
   * 不认这个对话框，所以必须自己接。
   */
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      onCancel()
    }
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [onCancel])

  /*
   * 打开期间锁住 body 滚动。
   *
   * 与 InputDialog 同一个理由：弹层后面是消息列表与文件树，
   * 不锁的话在弹层上滚轮会把后面的内容一起滚走，看着像弹层飘了。
   */
  useEffect(() => {
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = prev
    }
  }, [])

  return (
    <div className="overlay" onClick={onCancel}>
      <div className="dialog dialog-confirm" onClick={(e) => e.stopPropagation()}>
        <h2>{title}</h2>
        <div className="confirm-body">{children}</div>
        <div className="dialog-actions">
          {/*
            取消自动聚焦。理由见文件头：连按回车时应落到取消，
            而不是「确认放开权限」。
          */}
          <button className="ghost" autoFocus onClick={onCancel}>
            {cancelText}
          </button>
          <span className="spacer" />
          <button className={danger ? 'danger-solid' : 'primary'} onClick={onConfirm}>
            {confirmText}
          </button>
        </div>
      </div>
    </div>
  )
}
