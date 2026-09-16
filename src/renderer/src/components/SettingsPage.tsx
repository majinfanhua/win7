import { useEffect, useRef, useState } from 'react'
import type {
  AppConfig,
  CapabilityInfo,
  CapabilityMode,
  SystemDocState,
  UsageBucket,
  UsageByDay,
  UsageStats
} from '@shared/types'
import { DEFAULT_SYSTEM_PROMPT, USAGE_KEEP_DAYS } from '@shared/types'
import { AI_NAME_MAX, HABITS_MAX, USER_NAME_MAX } from '@shared/system-doc'
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
  { id: 'persona', label: 'AI 设定', hint: '它叫什么、怎么称呼你' },
  { id: 'usage', label: '用量统计', hint: '花了多少 token' },
  { id: 'capability', label: '工具能力', hint: 'AI 能对文件做什么' },
  { id: 'history', label: '修改历史', hint: '撤销 AI 的改动' },
  { id: 'about', label: '关于', hint: '快捷键与使用说明' }
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
  const snapshots = useAppStore((s) => s.snapshots)
  const refreshSnapshots = useAppStore((s) => s.refreshSnapshots)
  const undoLast = useAppStore((s) => s.undoLast)
  const [section, setSection] = useState<SectionId>('ai')

  /** 设置页打开与切到「修改历史」时都拉一次最新记录 */
  useEffect(() => {
    void refreshSnapshots()
  }, [refreshSnapshots, section])

  /**
   * 切到「用量统计」时拉一次。
   *
   * 依赖 section 而不是只在挂载时拉：用量会随着对话增长，
   * 用户开设置页 → 聊两句 → 再回来看，应该看到新的数字。
   */
  useEffect(() => {
    if (section === 'usage') void refreshUsage()
    // refreshUsage 每次渲染都是新函数，放进依赖会无限循环，所以只依赖 section
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [section])

  /**
   * 退回某次修改。
   *
   * 撤完由 store 重新拉列表 —— 撤销会把那条记录消费掉，不刷新的话
   * 界面上还显示着刚撤掉的那一条，学生再点一次只会得到「没有可撤销的修改」。
   */
  const undo = async (path: string): Promise<void> => {
    const result = await undoLast(path)
    setStatus(result.message)
  }
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

  /** `系统.md` 的状态与预览。预览为 null 表示收起 */
  const [docState, setDocState] = useState<SystemDocState | null>(null)
  const [docPreview, setDocPreview] = useState<string | null>(null)
  /** token 用量统计 */
  const [usage, setUsage] = useState<UsageStats | null>(null)

  const patchAi = (patch: Partial<AppConfig['ai']>): void => {
    setDraft((prev) => ({ ...prev, ai: { ...prev.ai, ...patch } }))
  }

  const patchCapability = (patch: Partial<AppConfig['capability']>): void => {
    setDraft((prev) => ({ ...prev, capability: { ...prev.capability, ...patch } }))
  }

  /* ---------------- 「AI 设定」相关的三个动作 ---------------- */

  /**
   * 看 `系统.md` 全文。
   *
   * 先 `persist()` 再 `regenerateSystemDoc()`（而不是 getSystemDoc）。
   * 用 regenerate 的理由：它**保证**文件是刚按当前设置生成的，
   * 而 getSystemDoc 只是「读现在是什么」—— 如果主进程那边的生成
   * 还没落盘（或者用户手改过），读到的就不是用户刚改的那份，
   * 表现出来就是「我改了名字，点查看全文，看到的还是旧的」。
   *
   * 这也让「查看全文」顺带变成一个「修一下」的动作，符合它的直觉。
   */
  const viewSystemDoc = async (): Promise<void> => {
    setBusy(true)
    try {
      await persist()
      const state = await window.api.regenerateSystemDoc()
      setDocState(state)
      setDocPreview(state.content)
      setStatus('已按当前设置刷新系统.md')
    } catch (err) {
      setStatus(`读取失败：${String(err)}`)
    } finally {
      setBusy(false)
    }
  }

  /** 重新生成。与「查看全文」同一件事，按钮语不同、给用户的预期不同 */
  const regenerateDoc = async (): Promise<void> => {
    await viewSystemDoc()
  }

  const openDocFile = async (): Promise<void> => {
    setBusy(true)
    try {
      // 同样先落盘：用户点「打开文件」的意图是「我要看现在这份」
      await persist()
      await window.api.openSystemDoc()
      setStatus('已用系统默认程序打开')
    } catch (err) {
      setStatus(`打开失败：${String(err)}`)
    } finally {
      setBusy(false)
    }
  }

  /* ---------------- 用量统计 ---------------- */

  const refreshUsage = async (): Promise<void> => {
    try {
      setUsage(await window.api.getUsageStats())
    } catch (err) {
      setStatus(`读取用量失败：${String(err)}`)
    }
  }

  const clearUsage = async (): Promise<void> => {
    try {
      setUsage(await window.api.resetUsageStats())
      setStatus('用量统计已清空')
    } catch (err) {
      setStatus(`清空失败：${String(err)}`)
    }
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

                {/*
                  图片支持是独立开关，不做自动探测。
                  「这个模型能不能看图」中转站的 /models 接口不会告诉你，
                  只能从模型名猜 —— 而模型名千奇百怪，猜错的代价不对称：
                  勾了但不支持 → 整个请求被拒，学生一脸茫然；
                  不勾但支持 → 只是用不上图片，别的功能都在。
                  所以默认关闭，由人确认一次。
                */}
                <div className="field">
                  <label className="toggle">
                    <input
                      type="checkbox"
                      checked={draft.ai.supportsVision}
                      onChange={(e) => patchAi({ supportsVision: e.target.checked })}
                    />
                    <span>这个模型支持图片输入（多模态）</span>
                  </label>
                  <div className="hint">
                    勾上之后输入框可以粘贴截图（Ctrl+V）或点工具条的「图片」选图。
                    不确定就先别勾 —— 勾错了会让每次带图的消息都发送失败。
                    图片在发送前会压到长边 1568px 的 JPEG，一张截图通常 100~200 KB。
                  </div>
                </div>

                {/*
                  上下文窗口：内置表按模型名猜，猜不到就用保守值。
                  留 0 表示交给内置表 —— 绝大多数人不需要动这里。
                  填了就以填的为准，给「内置表过时了」留一个自救口子。
                */}
                <div className="field">
                  <label>上下文窗口（token，可留空）</label>
                  <input
                    type="number"
                    min={0}
                    step={1024}
                    placeholder="留空 = 按模型名自动判断"
                    value={draft.ai.contextWindow || ''}
                    onChange={(e) => patchAi({ contextWindow: Number(e.target.value) || 0 })}
                  />
                  <div className="hint">
                    一次提问里，之前的所有对话都会发给模型。这个值决定「聊到多长就该开新对话」。
                    留空时按模型名自动判断（内置表覆盖了常见的 GPT / Claude / Gemini / DeepSeek 等）。
                    <strong>如果被误判成很小的窗口</strong>（表现为很短的对话就提示超预算），
                    在这里填上模型的真实窗口大小即可。
                  </div>
                </div>

                <div className="field">
                  <label>单次回答上限（token，可留空）</label>
                  <input
                    type="number"
                    min={0}
                    step={256}
                    placeholder="留空 = 按模型名自动判断"
                    value={draft.ai.maxOutputTokens || ''}
                    onChange={(e) => patchAi({ maxOutputTokens: Number(e.target.value) || 0 })}
                  />
                  <div className="hint">
                    留给模型这一轮回答的空间。它越大，触发「该开新对话了」的阈值就越早。
                    不确定就留空。
                  </div>
                </div>

                <div className="card-foot">
                  <button className="ghost" disabled={busy} onClick={() => void testConnection()}>
                    测试连接
                  </button>
                  <span className="muted">用最小请求验证地址 / 密钥 / 模型三者是否可用</span>
                </div>
              </section>
            )}

            {section === 'persona' && (
              <>
                <section className="card">
                  <div className="card-title">AI 设定</div>
                  <div className="hint card-hint">
                    这些内容会拼成一份 <code>系统.md</code>，作为发给 AI 的 system prompt。
                    可以随时点下面的「查看全文」确认它到底收到了什么。
                  </div>

                  <div className="field">
                    <label>AI 命名（最多 {AI_NAME_MAX} 字）</label>
                    <input
                      maxLength={AI_NAME_MAX}
                      placeholder="例如：小助"
                      value={draft.ai.aiName}
                      onChange={(e) => patchAi({ aiName: e.target.value })}
                    />
                    <div className="hint">
                      给它一个名字，长对话里它就不会搞混「你」是在说它还是说别人。留空则不做要求。
                    </div>
                  </div>

                  <div className="field">
                    <label>你希望 AI 称呼你什么（最多 {USER_NAME_MAX} 字）</label>
                    <input
                      maxLength={USER_NAME_MAX}
                      placeholder="例如：同学"
                      value={draft.ai.userName}
                      onChange={(e) => patchAi({ userName: e.target.value })}
                    />
                    <div className="hint">留空则它不会特意称呼你。</div>
                  </div>

                  <div className="field">
                    <label>默认提示词（告诉 AI 它是什么）</label>
                    <textarea
                      rows={7}
                      value={draft.ai.systemPrompt}
                      onChange={(e) => patchAi({ systemPrompt: e.target.value })}
                    />
                    <div className="hint">
                      这一段决定它的身份与回答风格。改坏了可以点右下角「恢复默认」。
                    </div>
                  </div>

                  <div className="field">
                    <label>习惯</label>
                    <textarea
                      rows={4}
                      maxLength={HABITS_MAX}
                      placeholder={'例如：\n- 我只用 Windows，命令请按 cmd 写\n- 解释尽量短，先给能跑的代码\n- 不要用我没学过的语法'}
                      value={draft.ai.habits}
                      onChange={(e) => patchAi({ habits: e.target.value })}
                    />
                    <div className="hint">
                      你的固定偏好，会作为补充要求附在提示词后面。一行一条最清楚。
                    </div>
                  </div>

                  <div className="card-foot">
                    <button className="ghost" disabled={busy} onClick={() => void viewSystemDoc()}>
                      查看全文
                    </button>
                    <button className="ghost" disabled={busy} onClick={() => void regenerateDoc()}>
                      重新生成
                    </button>
                    <button className="ghost" disabled={busy} onClick={() => void openDocFile()}>
                      打开文件
                    </button>
                    <button
                      className="ghost"
                      disabled={busy}
                      onClick={() => patchAi({ systemPrompt: DEFAULT_SYSTEM_PROMPT })}
                    >
                        恢复默认提示词
                    </button>
                  </div>
                </section>

                {/* 「系统.md」的全文预览。默认收起，需要时才看 */}
                {docPreview !== null && (
                  <section className="card">
                    <div className="card-title">
                      系统.md 全文
                      <span className="muted"> {docState?.inSync ? '（与设置一致）' : '（下次对话前会被设置覆盖）'}</span>
                    </div>
                    <div className="hint card-hint">
                      这就是每次对话真正发出去的 system prompt 原文。放在文件里的好处是能直接看、直接确认。
                    </div>
                    <textarea className="doc-preview" readOnly rows={18} value={docPreview} />
                    <div className="card-foot">
                      <button className="ghost" onClick={() => setDocPreview(null)}>
                        收起
                      </button>
                      <span className="muted">{docState?.path || ''}</span>
                    </div>
                  </section>
                )}
              </>
            )}

            {section === 'usage' && (
              <section className="card">
                <div className="card-title">用量统计</div>
                <div className="hint card-hint">
                  按天统计每次请求的 token。缓存命中的部分通常只按原价的几分之一计费，
                  所以「命中率」比总量更值得盯 —— 它掉下来往往意味着每次对话都换了 system prompt。
                </div>

                {usage ? (
                  <>
                    <div className="usage-grid">
                      <UsageCell label="今天" bucket={usage.today} />
                      <UsageCell label="最近 7 天" bucket={usage.week} />
                      <UsageCell label="全部" bucket={usage.total} />
                    </div>

                    {usage.days.length > 0 && (
                      <>
                        <div className="usage-sub">最近 7 天</div>
                        <div className="usage-bars">
                          {usage.days.map((day) => (
                            <UsageBar key={day.day} day={day} max={maxDailyTokens(usage.days)} />
                          ))}
                        </div>
                      </>
                    )}

                    {usage.models.length > 0 && (
                      <>
                        <div className="usage-sub">按模型（全部历史）</div>
                        <div className="usage-list">
                          {usage.models.map((item) => (
                            <div key={item.model} className="usage-row">
                              <span className="usage-model">{item.model}</span>
                              <span className="muted">
                                {item.requests} 次 · 输入 {formatTokens(item.promptTokens)} · 输出{' '}
                                {formatTokens(item.completionTokens)} · 命中{' '}
                                {hitRate(item.promptTokens, item.cachedTokens)}
                              </span>
                            </div>
                          ))}
                        </div>
                      </>
                    )}

                    <div className="hint card-hint">
                      {usage.total.estimatedRequests > 0
                        ? `注意：其中 ${usage.total.estimatedRequests} 次请求的 token 是按字数估算的（中转站没有返回用量），这部分数字只能看量级。`
                        : '全部数字都来自接口返回的用量。'}
                      {usage.since ? ` 记录始于 ${usage.since}。` : ''}
                      逐日明细保留最近 {USAGE_KEEP_DAYS} 天。
                    </div>
                  </>
                ) : (
                  <div className="hint">正在读取…</div>
                )}

                <div className="card-foot">
                  <button className="ghost" disabled={busy} onClick={() => void refreshUsage()}>
                    刷新
                  </button>
                  <button className="ghost" disabled={busy} onClick={() => void clearUsage()}>
                    清空统计
                  </button>
                  <span className="muted">清空只删统计，不影响对话记录与设置</span>
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
                  命令类工具（执行命令 / 后台任务）需要 PowerShell：Windows 10 / 11 上一般可用，
                  Windows 7 与未探测到 powershell.exe 的机器上不会启用。
                </div>
              </section>
            )}

            {section === 'history' && (
              <section className="card">
                <div className="card-title">修改历史</div>
                <div className="hint card-hint">
                  AI 每改一次文件都会先存一份原文。这里可以退回任意一次 ——
                  撤销后会删掉这条记录，所以「撤销的撤销」需要重新让 AI 改一次。
                </div>

                {snapshots.length === 0 ? (
                  <div className="empty-line">当前项目还没有可撤销的修改</div>
                ) : (
                  <div className="snap-list">
                    {snapshots.map((item) => (
                      <div key={item.id} className="snap-row">
                        <div className="snap-main">
                          <div className="snap-path" title={item.path}>
                            {item.path.split(/[\\/]/).pop()}
                          </div>
                          <div className="snap-meta">
                            {formatWhen(item.time)} · {sourceLabel(item.source)} ·{' '}
                            {item.lineDelta > 0 ? `+${item.lineDelta} 行` : `${item.lineDelta} 行`}
                          </div>
                        </div>
                        <button className="ghost btn-sm" onClick={() => void undo(item.path)}>
                          退回这次
                        </button>
                      </div>
                    ))}
                  </div>
                )}

                <div className="hint card-hint">
                  只列出当前项目里的修改。其他项目的记录不会动到。
                </div>
              </section>
            )}

            {section === 'about' && (
              <section className="card">
                <div className="card-title">关于</div>
                <div className="about-brand">
                  <img className="about-logo" src="./logo.png" alt="" />
                  <div>
                    <div className="about-name">航科教育 · AI 代码编辑器</div>
                    <div className="hint">带 AI 助手的代码编辑器，支持 Windows 7 SP1 及以上系统</div>
                  </div>
                </div>

                <div className="about-block">
                  <div className="about-title">快捷键</div>
                  <ul className="about-list">
                    <li><kbd>Ctrl</kbd> + <kbd>Enter</kbd>：发送提问</li>
                    <li><kbd>Ctrl</kbd> + <kbd>S</kbd>：保存当前文件</li>
                    <li><kbd>Ctrl</kbd> + <kbd>N</kbd>：新建对话</li>
                    <li><kbd>Ctrl</kbd> + <kbd>O</kbd>：打开文件夹</li>
                    <li><kbd>Ctrl</kbd> + <kbd>Z</kbd>：撤销 AI 上一次修改</li>
                    <li><kbd>Ctrl</kbd> + <kbd>,</kbd>：打开设置</li>
                    <li><kbd>Esc</kbd>：从设置页返回对话</li>
                  </ul>
                </div>

                <div className="about-block">
                  <div className="about-title">三个常用动作</div>
                  <ul className="about-list">
                    <li>在文件上右键能看到「预览文件」「复制路径」「插入引用」等</li>
                    <li>「插入引用」会把文件内容随提问一起发给 AI，不用手动粘贴</li>
                    <li>对话区与编辑器之间的横条可以拖动，双击回到默认高度</li>
                  </ul>
                </div>

                <div className="about-block">
                  <div className="about-title">遇到启动问题</div>
                  <div className="hint">
                    菜单「帮助 → 运行环境体检」会检查系统版本、运行库与渲染模式，
                    把结果截图发给老师就可以定位问题。
                  </div>
                </div>
              </section>
            )}
          </div>
        </div>
      </div>
    </section>
  )
}

/** 把 ISO 时间转成「几分钟前」式的中文短描述 */
function formatWhen(iso: string): string {
  const at = new Date(iso).getTime()
  if (!Number.isFinite(at)) return ''
  const diff = Date.now() - at
  if (diff < 60_000) return '刚刚'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`
  return new Date(at).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' })
}

/** 快照来源的中文标签 */
function sourceLabel(source: string): string {
  if (source === 'manual') return '手动保存'
  if (source === 'writeFile') return 'AI 覆写'
  if (source === 'editFile') return 'AI 替换'
  if (source === 'multiEdit') return 'AI 多处替换'
  return source
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

/* ------------------------------------------------------------------ *
 * 用量统计的展示组件
 * ------------------------------------------------------------------ */

/**
 * token 数的中文可读写法。
 *
 * 用「万」而不是「k」：使用者是中文用户，12000 写成「1.2 万」
 * 比「12.0k」更快理解，也不容易把 12k 和 12 万看混。
 * 分级到亿就够 —— 个人使用的额度不会到那个量级。
 */
function formatTokens(value: number): string {
  if (value >= 100_000_000) return `${(value / 100_000_000).toFixed(2)} 亿`
  if (value >= 10_000) return `${(value / 10_000).toFixed(2)} 万`
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)} 千`
  return String(value)
}

/** 缓存命中率。分母为 0 时不要显示 0%（那会让人以为命中率是 0） */
function hitRate(promptTokens: number, cachedTokens: number): string {
  if (promptTokens <= 0) return '—'
  return `${Math.round((cachedTokens / promptTokens) * 100)}%`
}

/** 一格统计 */
function UsageCell({ label, bucket }: { label: string; bucket: UsageBucket }): JSX.Element {
  return (
    <div className="usage-cell">
      <div className="usage-cell-label">{label}</div>
      <div className="usage-cell-value">{formatTokens(bucket.promptTokens + bucket.completionTokens)}</div>
      <div className="usage-cell-note">
        输入 {formatTokens(bucket.promptTokens)} · 输出 {formatTokens(bucket.completionTokens)}
      </div>
      <div className="usage-cell-note">
        {bucket.requests} 次 · 命中 {hitRate(bucket.promptTokens, bucket.cachedTokens)}
      </div>
    </div>
  )
}

/** 柱状图里的最大值，用来算每根柱子的相对高度。全是 0 时返回 1 避免除零 */
function maxDailyTokens(days: UsageByDay[]): number {
  return Math.max(1, ...days.map((day) => day.promptTokens + day.completionTokens))
}

/**
 * 一天一根柱子。
 *
 * 用 CSS 高度百分比而不是引一个图表库：
 * 这个图只有 7 根柱子、一个维度，引库要多几百 KB（还要考虑 Win7 下的兼容），
 * 而手写这几行的可读性并不差。
 */
function UsageBar({ day, max }: { day: UsageByDay; max: number }): JSX.Element {
  const total = day.promptTokens + day.completionTokens
  const height = Math.round((total / max) * 100)
  return (
    <div className="usage-bar-wrap" title={`${day.day}：${formatTokens(total)} token`}>
      <div className="usage-bar-track">
        <div className="usage-bar-fill" style={{ height: `${Math.max(total > 0 ? 4 : 0, height)}%` }} />
      </div>
      <div className="usage-bar-label">{day.day.slice(5)}</div>
      <div className="usage-bar-value">{total > 0 ? formatTokens(total) : ''}</div>
    </div>
  )
}
