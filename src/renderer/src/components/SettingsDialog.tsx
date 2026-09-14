import { useEffect, useState } from 'react'
import type { AppConfig, CapabilityInfo, CapabilityMode } from '@shared/types'
import { useAppStore } from '../store/useAppStore'

/** 把“Key: Value”多行文本解析成请求头对象 */
function parseHeaders(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of text.split('\n')) {
    const idx = line.indexOf(':')
    if (idx <= 0) continue
    const key = line.slice(0, idx).trim()
    const value = line.slice(idx + 1).trim()
    if (key) out[key] = value
  }
  return out
}

function formatHeaders(headers: Record<string, string>): string {
  return Object.entries(headers)
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n')
}

/** 当前只保留 AI 配置（编辑器 / 图形相关项暂时移除） */
export default function SettingsDialog({
  initial,
  onClose
}: {
  initial: AppConfig
  onClose: () => void
}): JSX.Element {
  const applyConfig = useAppStore((s) => s.applyConfig)
  const [draft, setDraft] = useState<AppConfig>(initial)
  const [headerText, setHeaderText] = useState(formatHeaders(initial.ai.extraHeaders || {}))
  const [models, setModels] = useState<string[]>([])
  const [status, setStatus] = useState('')
  const [busy, setBusy] = useState(false)
  /** 能力信息。它反映的是「已保存」的状态，不是正在编辑的草稿 */
  const [caps, setCaps] = useState<CapabilityInfo | null>(null)

  const patchAi = (patch: Partial<AppConfig['ai']>): void => {
    setDraft((prev) => ({ ...prev, ai: { ...prev.ai, ...patch } }))
  }

  const patchCapability = (patch: Partial<AppConfig['capability']>): void => {
    setDraft((prev) => ({ ...prev, capability: { ...prev.capability, ...patch } }))
  }

  /** 逐个工具的开关：写进 disabled 列表 */
  const toggleTool = (name: string, enabled: boolean): void => {
    setDraft((prev) => {
      const rest = prev.capability.disabled.filter((item) => item !== name)
      return {
        ...prev,
        capability: { ...prev.capability, disabled: enabled ? rest : [...rest, name] }
      }
    })
  }

  useEffect(() => {
    void window.api.capabilities().then(setCaps)
  }, [])

  /** 拉取模型列表和测试连接都要先落盘，因为主进程是从自己的配置里读的 */
  const persistAi = async (): Promise<void> => {
    const saved = await window.api.setConfig({
      ai: { ...draft.ai, extraHeaders: parseHeaders(headerText) },
      capability: draft.capability
    })
    setDraft(saved)
    setCaps(await window.api.capabilities())
  }

  const fetchModels = async (): Promise<void> => {
    setBusy(true)
    setStatus('正在拉取模型列表…')
    try {
      await persistAi()
      const result = await window.api.aiListModels()
      setModels(result.models)
      setStatus(result.ok ? `${result.detail}，可在上方选择` : result.detail)
    } finally {
      setBusy(false)
    }
  }

  const testConnection = async (): Promise<void> => {
    setBusy(true)
    setStatus('正在测试连接…')
    try {
      await persistAi()
      const result = await window.api.aiTest()
      setStatus(result.ok ? `${result.detail}（${result.latencyMs} ms）` : result.detail)
    } finally {
      setBusy(false)
    }
  }

  const save = async (): Promise<void> => {
    setBusy(true)
    try {
      const saved = await window.api.setConfig({
        ai: { ...draft.ai, extraHeaders: parseHeaders(headerText) },
        capability: draft.capability
      })
      applyConfig(saved)
      onClose()
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="overlay" onClick={onClose}>
      <div className="dialog glass" onClick={(e) => e.stopPropagation()}>
        <div className="dialog-head">
          <div>
            <h2>设置</h2>
            <div className="muted">AI 模型与工具能力，改完保存即可生效</div>
          </div>
          <button className="icon-btn" title="关闭" onClick={onClose}>
            ✕
          </button>
        </div>

        <div className="field">
          <label>中转站地址（OpenAI 兼容）</label>
          <input
            placeholder="https://relay.example.com  或  https://relay.example.com/v1"
            value={draft.ai.baseUrl}
            onChange={(e) => patchAi({ baseUrl: e.target.value })}
          />
          <div className="hint">只填域名也可以，会自动补 /v1；粘贴完整端点也能识别</div>
        </div>

        <div className="field">
          <label>API Key</label>
          <input
            type="password"
            placeholder="sk-..."
            value={draft.ai.apiKey}
            onChange={(e) => patchAi({ apiKey: e.target.value })}
          />
          <div className="hint">密钥只保存在主进程，渲染页面拿不到</div>
        </div>

        <div className="field">
          <label>模型</label>
          <div className="inline">
            {models.length > 0 ? (
              <select value={draft.ai.model} onChange={(e) => patchAi({ model: e.target.value })}>
                <option value="">请选择</option>
                {models.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            ) : (
              <input
                placeholder="先点右侧「拉取列表」，或直接填写模型名"
                value={draft.ai.model}
                onChange={(e) => patchAi({ model: e.target.value })}
              />
            )}
            <button className="ghost" disabled={busy} onClick={() => void fetchModels()}>
              拉取列表
            </button>
          </div>
        </div>

        <div className="field">
          <label>温度（0 - 2）</label>
          <input
            type="number"
            min={0}
            max={2}
            step={0.1}
            value={draft.ai.temperature}
            onChange={(e) => patchAi({ temperature: Number(e.target.value) })}
          />
        </div>

        <div className="field">
          <label>额外请求头（每行一条，Key: Value）</label>
          <textarea
            rows={2}
            placeholder="仅部分中转站需要，留空即可"
            value={headerText}
            onChange={(e) => setHeaderText(e.target.value)}
          />
        </div>

        <div className="field">
          <label>教学 System Prompt</label>
          <textarea
            rows={6}
            value={draft.ai.systemPrompt}
            onChange={(e) => patchAi({ systemPrompt: e.target.value })}
          />
        </div>

        <div className="section-title">工具能力</div>
        <div className="hint section-hint">
          决定 AI 能对文件做什么。这里只定「愿意放开到哪」，实际能不能用还要看本机探测结果。
        </div>

        <div className="field">
          <label>放开程度</label>
          <select
            value={draft.capability.mode}
            onChange={(e) => patchCapability({ mode: e.target.value as CapabilityMode })}
          >
            <option value="auto">自动 — 按本机探测（推荐）</option>
            <option value="conservative">保守 — 只放开文件读写，各机器表现一致</option>
            <option value="full">全开 — 忽略探测，本机不支持时工具会返回可读错误</option>
          </select>
        </div>

        {caps && (
          <div className="cap-status">
            <div className="cap-line">
              <span className="muted">本机</span> {caps.profile}
              {caps.overridden ? '（已被命令行参数覆盖，仅供测试）' : ''}
            </div>
            <div className="cap-line">
              <span className="muted">当前已保存设置下生效</span> {caps.effective.length} 个：
              {caps.effective.map((name) => caps.labels[name] || name).join('、')}
            </div>
            {caps.filtered.length > 0 && (
              <div className="cap-line muted">
                未启用：
                {caps.filtered
                  .map((item) => `${caps.labels[item.name] || item.name}（${item.reason}）`)
                  .join('；')}
              </div>
            )}
            <div className="cap-line muted">{caps.notes.join('；')}</div>
          </div>
        )}

        {caps && (
          <details className="advanced">
            <summary>高级：逐个工具开关</summary>
            <div className="toggles">
              {Object.keys(caps.labels).map((name) => (
                <label key={name} className="toggle">
                  <input
                    type="checkbox"
                    checked={!draft.capability.disabled.includes(name)}
                    onChange={(e) => toggleTool(name, e.target.checked)}
                  />
                  <span>{caps.labels[name]}</span>
                </label>
              ))}
            </div>
            <div className="hint">
              取消勾选后该工具不会出现在 AI 的工具表里 —— 模型看不到就不会去调。
            </div>
          </details>
        )}

        {status && <div className="status-line">{status}</div>}

        <div className="dialog-actions">
          <button className="ghost" disabled={busy} onClick={() => void testConnection()}>
            测试连接
          </button>
          <span className="spacer" />
          <button className="ghost" disabled={busy} onClick={onClose}>
            取消
          </button>
          <button className="primary" disabled={busy} onClick={() => void save()}>
            保存
          </button>
        </div>
      </div>
    </div>
  )
}
