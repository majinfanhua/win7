import { useEffect, useRef, useState } from 'react'
import type { AppConfig, CapabilityInfo, CapabilityMode } from '@shared/types'
import { useAppStore } from '../store/useAppStore'

/** 把「Key: Value」多行文本解析成请求头对象 */
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

/** 只取「可编辑」的部分做快照，用来判断有没有未保存的改动 */
function snapshot(config: AppConfig): string {
  return JSON.stringify({
    ai: { ...config.ai, extraHeaders: config.ai.extraHeaders || {} },
    capability: config.capability
  })
}

/**
 * 设置的分栏。
 *
 * 一开始想全部铺在一页里滚，但两组配置的查阅方式完全不同：
 * AI 模型是“填一次就不动”，工具能力是“要对照着本机探测结果反复调”。
 * 挤在一页里，改完上面得滚下去看下面，两边对不上号。
 *
 * 所以拆成分栏：左边选组，右边只看当前这组。
 * 新增一组只需往 SECTIONS 里加一条 + 加一段渲染。
 */
const SECTIONS = [
  { id: 'ai', label: 'AI 模型', hint: '中转站、密钥与模型' },
  { id: 'capability', label: '工具能力', hint: 'AI 能对文件做什么' }
] as const

type SectionId = (typeof SECTIONS)[number]['id']

/**
 * 设置页。
 *
 * 原来是弹窗，现在是独立页面。与弹窗相比的三处语义变化：
 *   1. 保存后**留在本页**并给一句「已保存」，不再自动关闭
 *   2. 「返回」时若有未保存改动，先问一句，不静默丢弃
 *   3. 根节点保留 .settings-page，自检靠它判断路由到底切过去没有
 */
export default function SettingsPage({
  initial,
  onBack
}: {
  initial: AppConfig
  onBack: () => void
}): JSX.Element {
  const applyConfig = useAppStore((s) => s.applyConfig)
  const [section, setSection] = useState<SectionId>('ai')
  const [draft, setDraft] = useState<AppConfig>(initial)
  const [headerText, setHeaderText] = useState(formatHeaders(initial.ai.extraHeaders || {}))
  const [models, setModels] = useState<string[]>([])
  const [status, setStatus] = useState('')
  const [busy, setBusy] = useState(false)
  /** 能力信息反映的是「已保存」的状态，不是正在编辑的草稿 */
  const [caps, setCaps] = useState<CapabilityInfo | null>(null)
  /** 上次落盘的内容。和它不一致就是有未保存的改动 */
  const [base, setBase] = useState(() => snapshot(initial))
  /** 「返回」时发现未保存，先问一句 */
  const [confirmLeave, setConfirmLeave] = useState(false)
  const scrollRef = useRef<HTMLDivElement | null>(null)

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

  // 切组时回到顶部，否则从长的那组切到短的那组会停在半空
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = 0
  }, [section])

  const dirty =
    snapshot({ ...draft, ai: { ...draft.ai, extraHeaders: parseHeaders(headerText) } }) !== base

  /**
   * 落盘。
   * 拉取模型列表和测试连接也要先走这一步 —— 主进程是从自己的配置里读地址 / 密钥的，
   * 不先存下去，那两件事测的就是旧配置。
   */
  const persist = async (): Promise<AppConfig> => {
    const saved = await window.api.setConfig({
      ai: { ...draft.ai, extraHeaders: parseHeaders(headerText) },
      capability: draft.capability
    })
    setDraft(saved)
    setHeaderText(formatHeaders(saved.ai.extraHeaders || {}))
    setBase(snapshot(saved))
    setCaps(await window.api.capabilities())
    // 顶栏 / 对话面板都从 store 读配置，这里同步一下，免得两边不一致
    applyConfig(saved)
    return saved
  }

  const save = async (): Promise<void> => {
    setBusy(true)
    try {
      await persist()
      setStatus('已保存，立即生效')
    } catch (err) {
      setStatus(`保存失败：${String(err)}`)
    } finally {
      setBusy(false)
    }
  }

  const fetchModels = async (): Promise<void> => {
    setBusy(true)
    setStatus('正在拉取模型列表…')
    try {
      await persist()
      const result = await window.api.aiListModels()
      setModels(result.models)
      setStatus(result.ok ? `${result.detail}，可在上方选择` : result.detail)
    } catch (err) {
      setStatus(`拉取失败：${String(err)}`)
    } finally {
      setBusy(false)
    }
  }

  const testConnection = async (): Promise<void> => {
    setBusy(true)
    setStatus('正在测试连接…')
    try {
      await persist()
      const result = await window.api.aiTest()
      setStatus(result.ok ? `${result.detail}（${result.latencyMs} ms）` : result.detail)
    } catch (err) {
      setStatus(`测试失败：${String(err)}`)
    } finally {
      setBusy(false)
    }
  }

  const handleBack = (): void => {
    if (dirty) {
      setConfirmLeave(true)
      return
    }
    onBack()
  }

  // Esc 返回，和原来弹窗时的手感保持一致
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      if (confirmLeave) setConfirmLeave(false)
      else if (dirty) setConfirmLeave(true)
      else onBack()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [confirmLeave, dirty, onBack])

  return (
    <section className="settings-page">
      <div className="page-head glass">
        <div className="page-head-row">
          <button
            className="icon-btn"
            aria-label="返回"
            title="返回对话（Esc）"
            onClick={handleBack}
          >
            <BackIcon />
            <span>返回</span>
          </button>
          <div className="page-title">
            <h1>设置</h1>
            <div className="muted">{SECTIONS.find((s) => s.id === section)?.hint}</div>
          </div>
          <span className="spacer" />
          {dirty && <span className="chip">未保存</span>}
          <button className="primary" disabled={busy || !dirty} onClick={() => void save()}>
            {busy ? '处理中…' : '保存'}
          </button>
        </div>
        {status && <div className="page-status">{status}</div>}
      </div>

      {confirmLeave && (
        <div className="leave-bar">
          <span>有未保存的改动，返回后会丢失。</span>
          <span className="spacer" />
          <button className="ghost" onClick={() => setConfirmLeave(false)}>
            继续编辑
          </button>
          <button className="ghost danger" onClick={onBack}>
            放弃改动并返回
          </button>
        </div>
      )}

      <div className="settings-body">
        <nav className="settings-nav">
          {SECTIONS.map((item) => (
            <button
              key={item.id}
              className={`nav-item${section === item.id ? ' active' : ''}`}
              aria-current={section === item.id ? 'true' : undefined}
              onClick={() => setSection(item.id)}
            >
              <span className="nav-label">{item.label}</span>
              <span className="nav-hint">{item.hint}</span>
            </button>
          ))}
        </nav>

        <div className="page-scroll" ref={scrollRef}>
          <div className="page-body">
            {section === 'ai' && (
              <section className="card">
                <div className="card-title">AI 模型</div>
                <div className="hint card-hint">
                  走 OpenAI 兼容协议的中转站。密钥只保存在主进程，渲染页面拿不到。
                </div>

                <div className="field">
                  <label>中转站地址</label>
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
                </div>

                <div className="field">
                  <label>模型</label>
                  <div className="inline">
                    {models.length > 0 ? (
                      <select
                        value={draft.ai.model}
                        onChange={(e) => patchAi({ model: e.target.value })}
                      >
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

                <div className="card-foot">
                  <button className="ghost" disabled={busy} onClick={() => void testConnection()}>
                    测试连接
                  </button>
                  <span className="muted">用最小请求验证地址 / 密钥 / 模型三者是否可用</span>
                </div>
              </section>
            )}

            {section === 'capability' && (
              <section className="card">
                <div className="card-title">工具能力</div>
                <div className="hint card-hint">
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

                <div className="hint card-hint">
                  命令类工具（执行命令 / 后台任务）目前尚未实现，列在「未启用」里但不会生效。
                </div>
              </section>
            )}
          </div>
        </div>
      </div>
    </section>
  )
}

function BackIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
      <path
        d="M14.5 5.5 8 12l6.5 6.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}
