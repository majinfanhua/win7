import { useEffect } from 'react'
import { useConfirmStore } from '../store/confirm'

/**
 * 应用内确认框的渲染端。
 *
 * 与 store/confirm.ts 配对：那边负责「问什么、等答案」，
 * 这里负责「长什么样、怎么选」。
 *
 * ## 为什么不用 ConfirmDialog / InputDialog 那套
 *
 * 那两个是**受控组件**（父组件拿 state 决定显示什么），
 * 而这里的调用方是 store 里的异步流程 —— 没有组件能持有它的 state。
 * 所以走 store 中转，渲染端只订阅 `request`。
 * 视觉上仍复用 dialog.css 的 .overlay / .dialog 原语，不新造一套语言。
 *
 * ## 为什么挂在 App 最外层
 *
 * `.overlay` 是 position:fixed，但**祖先里有 backdrop-filter / transform
 * 会给 fixed 创建新的包含块**（这个坑在自绘下拉上踩过一次，
 * 弹层直接跑到屏幕外）。挂在最外层就没有任何祖先能影响它。
 *
 * ## 键盘行为
 *
 *   - Esc = 关闭（返回 ''，调用方当取消处理）
 *   - Tab 能到每个按钮（原生 button 即可）
 *   - **默认焦点在第一个按钮**：调用方把「取消」放在第一个，
 *     于是连按回车不会触发危险操作
 */
export default function ConfirmHost(): JSX.Element | null {
  const request = useConfirmStore((s) => s.request)
  const resolve = useConfirmStore((s) => s.resolve)

  /*
   * Esc 关闭。
   *
   * 用 capture 并 stopPropagation：App 那边还有全局 Esc（关设置页等），
   * 不拦住的话一次 Esc 会同时关掉这个框和别的层。
   */
  useEffect(() => {
    if (!request) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      e.preventDefault()
      resolve?.('')
    }
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [request, resolve])

  /*
   * 打开期间锁 body 滚动。
   * 与 InputDialog 同一个理由：弹层后面是消息列表与文件树，
   * 不锁的话在弹层上滚轮会把后面的内容一起滚走。
   */
  useEffect(() => {
    if (!request) return
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = prev
    }
  }, [request])

  if (!request) return null

  return (
    <div className="overlay" onClick={() => resolve?.('')}>
      <div className="dialog dialog-confirm" onClick={(e) => e.stopPropagation()}>
        <h2>{request.title}</h2>
        <div className="confirm-body">
          {request.lines.map((line) => (
            <p key={line}>{line}</p>
          ))}
        </div>
        <div className="dialog-actions">
          {request.actions.map((action, i) => (
            <button
              key={action.id}
              /*
               * 第一个按钮自动聚焦。调用方约定把最安全的那项放第一位
               * （取消 / 留在原地），这样连按回车不会误触发危险操作。
               */
              autoFocus={i === 0}
              className={
                action.kind === 'primary'
                  ? 'primary'
                  : action.kind === 'danger'
                    ? 'danger-solid'
                    : 'ghost'
              }
              onClick={() => resolve?.(action.id)}
            >
              {action.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
