import { useEffect, useRef, useState } from 'react'
import type { AiUsage, ChatMessage } from '@shared/types'
import { useAppStore } from '../store/useAppStore'

type Role = 'user' | 'assistant' | 'system' | 'error'

interface ChatItem {
  id: string
  role: Role
  text: string
  /** 本轮用量的统计，流结束时才有 */
  usage?: AiUsage
}

function formatTokens(n: number): string {
  if (n >= 10_000) return `${Math.round(n / 1000)}k`
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`
  return String(n)
}

/** 气泡下面那行小字：输入 / 输出 token + 缓存命中率 */
function formatUsage(usage: AiUsage): string {
  const rate = Math.round(usage.cacheHitRate * 100)
  return [
    `输入 ${formatTokens(usage.promptTokens)}`,
    `输出 ${formatTokens(usage.completionTokens)}`,
    `缓存命中 ${rate}%${usage.source === 'estimate' ? '（估算）' : ''}`
  ].join(' · ')
}

/** 已配置好之后给几个现成的问题，省得学生不知道能问什么 */
const SAMPLES = [
  '这段 Python 循环为什么报 IndexError？',
  '什么是变量作用域，举个例子',
  '我的按钮点了没反应，帮我看看'
]

export default function AiPanel({ onOpenSettings }: { onOpenSettings: () => void }): JSX.Element {
  const config = useAppStore((s) => s.config)
  const [items, setItems] = useState<ChatItem[]>([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const requestRef = useRef('')
  const scrollRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    return window.api.onAiStream((chunk) => {
      if (chunk.requestId !== requestRef.current) return
      if (chunk.kind === 'delta') {
        setItems((prev) =>
          prev.map((it) =>
            it.id === chunk.requestId ? { ...it, text: it.text + (chunk.text || '') } : it
          )
        )
      } else if (chunk.kind === 'error') {
        setItems((prev) =>
          prev.map((it) =>
            it.id === chunk.requestId
              ? { ...it, role: 'error', text: `${it.text}${chunk.message || ''}` }
              : it
          )
        )
        setBusy(false)
      } else {
        setBusy(false)
        if (chunk.usage) {
          const usage = chunk.usage
          setItems((prev) => prev.map((it) => (it.id === chunk.requestId ? { ...it, usage } : it)))
        }
      }
    })
  }, [])

  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [items])

  const configured = Boolean(config?.ai.baseUrl && config?.ai.apiKey && config?.ai.model)

  const send = async (raw?: string): Promise<void> => {
    const text = (raw ?? input).trim()
    if (!text || busy) return

    const requestId = `req-${Date.now()}`
    requestRef.current = requestId

    const userItem: ChatItem = { id: `u-${Date.now()}`, role: 'user', text }
    const aiItem: ChatItem = { id: requestId, role: 'assistant', text: '' }

    const history = [...items, userItem].filter((it) => it.role === 'user' || it.role === 'assistant')
    setItems((prev) => [...prev, userItem, aiItem])
    setInput('')
    setBusy(true)

    const messages: ChatMessage[] = [
      { role: 'system', content: config?.ai.systemPrompt || '' },
      ...history.map((it) => ({ role: it.role as 'user' | 'assistant', content: it.text }))
    ]

    await window.api.aiChat(requestId, messages)
    setBusy(false)
  }

  const stop = async (): Promise<void> => {
    if (requestRef.current) await window.api.aiAbort(requestRef.current)
    setBusy(false)
  }

  return (
    <section className="chat">
      <div className="chat-scroll" ref={scrollRef}>
        <div className="chat-inner">
          {items.length === 0 ? (
            <div className="welcome">
              <div className="welcome-badge">AI</div>
              <h1>你好，我是你的编程老师</h1>
              <p>
                把代码或报错贴进来。我先说它在做什么，再指出问题，最后给出能直接运行的改法。
              </p>
              {configured ? (
                <div className="samples">
                  {SAMPLES.map((s) => (
                    <button key={s} className="sample" onClick={() => void send(s)}>
                      {s}
                    </button>
                  ))}
                </div>
              ) : (
                <div className="welcome-actions">
                  <button className="primary" onClick={onOpenSettings}>
                    先去配置 AI 模型
                  </button>
                  <span className="muted">未配置也可以先翻翻界面</span>
                </div>
              )}
            </div>
          ) : (
            items.map((it) => (
              <div key={it.id} className={`msg-row ${it.role}`}>
                <div className="msg-col">
                  <div className="bubble">
                    {it.text ? (
                      it.text
                    ) : (
                      <span className="dots">
                        <i />
                        <i />
                        <i />
                      </span>
                    )}
                  </div>
                  {it.usage && <div className="usage">{formatUsage(it.usage)}</div>}
                </div>
              </div>
            ))
          )}
        </div>
      </div>

      <div className="composer glass">
        <textarea
          rows={1}
          placeholder="问一个问题，或粘贴你的代码 / 报错信息…"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
              e.preventDefault()
              void send()
            }
          }}
        />
        <div className="composer-row">
          <span className="muted">Ctrl + Enter 发送</span>
          <span className="spacer" />
          {busy && (
            <button className="ghost" onClick={() => void stop()}>
              停止
            </button>
          )}
          <button
            className="primary"
            disabled={!configured || busy || !input.trim()}
            onClick={() => void send()}
          >
            {busy ? '生成中…' : '发送'}
          </button>
        </div>
      </div>
    </section>
  )
}
