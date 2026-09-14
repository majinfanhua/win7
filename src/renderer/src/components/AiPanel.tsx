import { useEffect, useRef, useState } from 'react'
import type { ChatMessage } from '@shared/types'
import { useAppStore } from '../store/useAppStore'

type Role = 'user' | 'assistant' | 'system' | 'error'

interface ChatItem {
  id: string
  role: Role
  text: string
}

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
          prev.map((it) => (it.id === chunk.requestId ? { ...it, text: it.text + (chunk.text || '') } : it))
        )
      } else if (chunk.kind === 'error') {
        setItems((prev) =>
          prev.map((it) =>
            it.id === chunk.requestId ? { ...it, role: 'error', text: `${it.text}${chunk.message || ''}` } : it
          )
        )
        setBusy(false)
      } else {
        setBusy(false)
      }
    })
  }, [])

  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [items])

  const configured = Boolean(config?.ai.baseUrl && config?.ai.apiKey && config?.ai.model)

  const send = async (): Promise<void> => {
    const text = input.trim()
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
    <div className="right">
      <div className="panel-title">
        <span>AI 教学助手</span>
        <span style={{ flex: 1 }} />
        <button onClick={onOpenSettings}>设置</button>
      </div>

      <div className="scroll" ref={scrollRef}>
        {!configured && (
          <div className="chat">
            <div className="msg system">
              尚未配置 AI。请点右上角「设置」，填入中转站地址、密钥，并选择模型。
              未配置时编辑器功能不受影响。
            </div>
          </div>
        )}
        <div className="chat">
          {items.map((it) => (
            <div key={it.id} className={`msg ${it.role}`}>
              {it.text || (it.role === 'assistant' ? '…' : '')}
            </div>
          ))}
        </div>
      </div>

      <div className="composer">
        <textarea
          rows={3}
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
        <div className="row">
          <button disabled={!configured || busy || !input.trim()} onClick={() => void send()}>
            {busy ? '生成中…' : '发送（Ctrl+Enter）'}
          </button>
          {busy && <button onClick={() => void stop()}>停止</button>}
        </div>
      </div>
    </div>
  )
}
