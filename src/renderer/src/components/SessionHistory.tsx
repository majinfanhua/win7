import { useEffect, useRef, useState } from 'react'
import { useAppStore } from '../store/useAppStore'

/**
 * 顶栏「历史会话」按钮 + 下拉。
 *
 * ## 为什么从对话区搬到顶栏
 *
 * 它原来待在 AI 面板的抬头左侧，与「当前会话标题」并排。
 * 但它的性质是**全局导航** —— 和「打开文件夹」一样，
 * 是「去别的地方干活」，而不是针对当前这轮对话的动作。
 * 放在顶栏之后，对话区抬头那个位置就空出来给了「新对话」，
 * 那才是紧贴当前对话、会频繁点的东西。
 *
 * ## 为什么用 portal-ish 的 fixed 定位
 *
 * 它挂在顶栏里，而顶栏有 overflow 约束（窄窗口下按钮会横向排布）。
 * 用 absolute 会被裁掉一半，所以下拉用 fixed + 按按钮 rect 算坐标 ——
 * 与自绘下拉（components/ui/Select.tsx）同一个理由、同一套做法。
 * 顶栏本身没有 transform / backdrop-filter，fixed 不会被改基准。
 */

/** 会话列表里的相对时间 */
function relTime(iso: string): string {
  if (!iso) return ''
  const at = new Date(iso).getTime()
  if (!Number.isFinite(at)) return ''
  const diff = Date.now() - at
  if (diff < 60_000) return '刚刚'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`
  if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)} 天前`
  return new Date(at).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' })
}

export default function SessionHistory(): JSX.Element {
  const sessions = useAppStore((s) => s.sessions)
  const sessionId = useAppStore((s) => s.sessionId)
  const sessionLoading = useAppStore((s) => s.sessionLoading)
  const openSession = useAppStore((s) => s.openSession)
  const removeSession = useAppStore((s) => s.removeSession)
  const archiveSession = useAppStore((s) => s.archiveSession)
  const unarchiveSession = useAppStore((s) => s.unarchiveSession)

  const [open, setOpen] = useState(false)
  const [status, setStatus] = useState('')
  const [box, setBox] = useState<{ left: number; top: number } | null>(null)
  const btnRef = useRef<HTMLButtonElement | null>(null)
  const popRef = useRef<HTMLDivElement | null>(null)

  /** 下拉贴按钮右下角，且不超出视口 */
  const measure = (): void => {
    const el = btnRef.current
    if (!el) return
    const r = el.getBoundingClientRect()
    const width = 340
    setBox({
      // 右对齐按钮，再往左收以避免超出视口右边
      left: Math.max(6, Math.min(r.right - width, window.innerWidth - width - 6)),
      top: r.bottom + 6
    })
  }

  useEffect(() => {
    if (!open) return
    measure()
    const onScroll = (): void => measure()
    window.addEventListener('resize', onScroll)
    // 捕获滚动：内层容器滚动时也要跟着走，否则下拉会脱节
    window.addEventListener('scroll', onScroll, true)
    return () => {
      window.removeEventListener('resize', onScroll)
      window.removeEventListener('scroll', onScroll, true)
    }
  }, [open])

  // 点外面 / Esc 收起
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      const t = e.target as Node
      if (popRef.current?.contains(t) || btnRef.current?.contains(t)) return
      setOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  // 状态文字自动消失，避免一直挂着让人以为操作还没结束
  useEffect(() => {
    if (!status) return
    const timer = window.setTimeout(() => setStatus(''), 4_000)
    return () => window.clearTimeout(timer)
  }, [status])

  return (
    <>
      <button
        ref={btnRef}
        className={`bar-btn${open ? ' active' : ''}`}
        aria-label="历史会话"
        aria-expanded={open}
        title="最近会话（切换 / 归档 / 删除）"
        onClick={() => setOpen((v) => !v)}
      >
        <HistoryIcon />
        {sessions.length > 0 && <span className="bar-btn-badge">{sessions.length}</span>}
      </button>

      {open && box && (
        <div
          ref={popRef}
          className="session-pop"
          style={{ left: box.left, top: box.top }}
        >
          {sessions.length === 0 ? (
            <div className="chat-pop-empty">还没有会话记录，发一条消息就会出现在这里</div>
          ) : (
            <div className="chat-pop-list">
              {sessions.map((item) => (
                <div key={item.id} className="chat-pop-row">
                  <button
                    className={`chat-pop-item${sessionId === item.id ? ' active' : ''}`}
                    title={`${item.title}\n${relTime(item.updatedAt)} · ${item.messageCount} 条消息`}
                    disabled={sessionLoading}
                    onClick={() => {
                      void openSession(item.id)
                      setOpen(false)
                    }}
                  >
                    <span className="chat-pop-name">{item.title}</span>
                    <span className="chat-pop-time">{relTime(item.updatedAt)}</span>
                  </button>
                  <button
                    className={`chat-pop-x${item.archived ? ' is-archived' : ''}`}
                    aria-label={item.archived ? `取消归档 ${item.title}` : `归档 ${item.title}`}
                    title={
                      item.archived
                        ? '已归档（AI 可以检索到它）。点一下取消归档'
                        : '归档：宣布这段对话结束，让 AI 总结并存档，以后可以检索'
                    }
                    onClick={(e) => {
                      e.stopPropagation()
                      void (item.archived
                        ? unarchiveSession(item.id)
                        : archiveSession(item.id)
                      ).then(setStatus)
                    }}
                  >
                    {item.archived ? '↺' : '⌸'}
                  </button>
                  <button
                    className="chat-pop-x"
                    aria-label={`删除会话 ${item.title}`}
                    title="删除这条记录"
                    onClick={(e) => {
                      e.stopPropagation()
                      void removeSession(item.id)
                    }}
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          )}
          {status && <div className="chat-pop-note">{status}</div>}
        </div>
      )}
    </>
  )
}

/** 历史会话：一个带指针的钟面 */
function HistoryIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true">
      <g
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M3.8 12a8.2 8.2 0 1 0 2.6-6" />
        <path d="M3.5 4.5V9H8" />
        <path d="M12 8v4.4l3 1.8" />
      </g>
    </svg>
  )
}
