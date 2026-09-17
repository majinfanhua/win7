import { useEffect, useRef, useState } from 'react'
import type {
  AppConfig,
  CapabilityInfo,
  CapabilityMode,
  McpServerStatus,
  SkillEntry,
  SystemDocState,
  UsageBucket,
  UsageByDay,
  UsageStats
} from '@shared/types'
import { PERMISSION_LABELS, USAGE_KEEP_DAYS } from '@shared/types'
import { AI_NAME_MAX, HABITS_MAX, USER_NAME_MAX } from '@shared/system-doc'
import { useAppStore } from '../store/useAppStore'
import Select from './ui/Select'

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
  { id: 'permission', label: '权限模式', hint: 'AI 能伸到哪儿' },
  { id: 'usage', label: '用量统计', hint: '花了多少 token' },
  { id: 'capability', label: '工具能力', hint: 'AI 能对文件做什么' },
  { id: 'skills', label: 'Skills', hint: '当前可用的工具能力' },
  { id: 'mcp', label: 'MCP', hint: '接入外部工具服务' },
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
  const [section, setSection] = useState<SectionId>('ai')

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
  /** 已发现的技能与其中一个的正文预览（null = 收起） */
  const [skills, setSkills] = useState<SkillEntry[]>([])
  const [skillPreview, setSkillPreview] = useState<string | null>(null)
  /** 各 MCP 服务器的运行状态 */
  const [mcpList, setMcpList] = useState<McpServerStatus[]>([])

  /* ---------------- 技能 ---------------- */

  const refreshSkills = async (): Promise<void> => {
    try {
      setSkills(await window.api.listSkills())
    } catch (err) {
      setStatus(`读取技能失败：${String(err)}`)
    }
  }

  const viewSkill = async (id: string): Promise<void> => {
    try {
      setSkillPreview(await window.api.readSkillText(id))
    } catch (err) {
      setStatus(`读取技能失败：${String(err)}`)
    }
  }

  const openSkills = async (): Promise<void> => {
    try {
      await window.api.openSkillsDir()
      setStatus('已打开技能目录')
    } catch (err) {
      setStatus(`打开失败：${String(err)}`)
    }
  }

  /* ---------------- MCP ---------------- */

  const refreshMcp = async (): Promise<void> => {
    try {
      setMcpList(await window.api.mcpStatus())
    } catch (err) {
      setStatus(`读取 MCP 状态失败：${String(err)}`)
    }
  }

  const reconnect = async (id: string): Promise<void> => {
    setBusy(true)
    setStatus(`正在连接 ${id}…`)
    try {
      setMcpList(await window.api.mcpReconnect(id))
      setStatus(`${id} 状态已更新`)
    } catch (err) {
      setStatus(`连接失败：${String(err)}`)
      await refreshMcp()
    } finally {
      setBusy(false)
    }
  }

  /**
   * 切到技能 / MCP 分栏时拉一次。
   *
   * 依赖 section 而不是挂载时拉一次：技能是用户**在文件系统里**加的，
   * MCP 状态也会变（服务器可能自己退出）。每次进这一栏都重新读，
   * 用户加完技能回来就能看到，不用重启应用。
   */
  useEffect(() => {
    if (section === 'skills') void refreshSkills()
    if (section === 'mcp') void refreshMcp()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [section])

  const patchAi = (patch: Partial<AppConfig['ai']>): void => {
    setDraft((prev) => ({ ...prev, ai: { ...prev.ai, ...patch } }))
  }

  const patchCapability = (patch: Partial<AppConfig['capability']>): void => {
    setDraft((prev) => ({ ...prev, capability: { ...prev.capability, ...patch } }))
  }

  const patchSkills = (enabled: boolean): void => {
    setDraft((prev) => ({ ...prev, skills: { enabled } }))
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
                      <Select
                        value={draft.ai.model}
                        options={[
                          { value: '', label: '请选择' },
                          ...models.map((m) => ({ value: m, label: m }))
                        ]}
                        onChange={(v) => patchAi({ model: v })}
                        ariaLabel="选择模型"
                        title="从拉取到的列表里选一个模型"
                        block
                      />
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
                  </div>
                </section>

                {/*
                  平台契约（只读）。
                  单独一张卡而不是混在上面：用户需要一眼看出
                  「这部分我改不了，也不该改」。做成可编辑输入框再提示
                  「改了不生效」是更差的做法 —— 那会诱使用户去改。
                */}
                <section className="card card-locked">
                  <div className="card-title">
                    <LockIcon />
                    平台契约（程序维护）
                  </div>
                  <div className="hint card-hint">
                    这一部分定义 AI 收到的工作约定：路径怎么解析、工具怎么用、
                    当前处于哪个权限模式、本机有哪些环境。
                    <b>它由程序维护，不能修改</b> —— 改错了软件就不按设计工作。
                    想看完整内容点下面的「查看全文」。
                  </div>

                  <div className="locked-summary">
                    <div className="locked-item">
                      <span className="locked-name">平台</span>
                      <span className="locked-desc">身份、路径语义（相对路径按工作目录解析、越界会先问你）</span>
                    </div>
                    <div className="locked-item">
                      <span className="locked-name">怎么用工具干活</span>
                      <span className="locked-desc">直接改文件而不是贴代码、先读后写、搜索优先用工具</span>
                    </div>
                    <div className="locked-item">
                      <span className="locked-name">工作纪律</span>
                      <span className="locked-desc">看命令退出码、不谎报完成、失败不空转</span>
                    </div>
                    <div className="locked-item">
                      <span className="locked-name">当前运行状态</span>
                      <span className="locked-desc">
                        权限模式：{PERMISSION_LABELS[draft.permission.mode]}
                      </span>
                    </div>
                    <div className="locked-item">
                      <span className="locked-name">本机环境</span>
                      <span className="locked-desc">操作系统、当前工作目录、探测到的运行时</span>
                    </div>
                  </div>

                  <div className="hint card-hint">
                    要调整 AI 的行为，请改上面的「身份」「称呼」「习惯」，
                    或到「权限模式」里换模式。契约里那几条是软件的硬约定，
                    例如「整篇覆盖前必须先读文件」—— 那是防止误覆盖的保护，
                    不是可以商量的偏好。
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

            {/*
              权限模式。
              与「工具能力」是两件事，所以单独一栏：
              工具能力决定 AI 手里有哪些工具，权限模式决定这些工具能伸到哪儿。
            */}
            {section === 'permission' && (
              <section className="card">
                <div className="card-title">权限模式</div>
                <div className="hint card-hint">
                  决定 AI 的文件操作能伸到哪儿。工具本身没有边界，边界由这里划。
                </div>

                {/*
                  这里**只显示、不提供切换**。
                  切换入口在 AI 输入框下方 —— 那是下指令的地方，
                  改完立刻生效，不用离开对话再跑回来。
                  设置页保留这一栏是当说明书用：三种模式的差别在这里写全，
                  而输入框那个下拉放不下这些说明。
                */}
                <div className="cap-status">
                  <div className="cap-line">
                    <span className="muted">当前模式</span>{' '}
                    <b>{PERMISSION_LABELS[draft.permission.mode]}</b>
                  </div>
                  <div className="cap-line muted">
                    切换请用 AI 输入框下方的模式选择 —— 在那里改完立即生效，
                    不用离开对话。
                  </div>
                </div>

                <div className="cap-status">
                  {draft.permission.mode === 'chat' && (
                    <>
                      <div className="cap-line">
                        <span className="muted">默认范围</span> 当前项目文件夹 +
                        临时工作区
                      </div>
                      <div className="cap-line muted">
                        超出这个范围的读写会弹一张授权卡片：
                        「只允许这一次 / 允许整个目录 / 拒绝」。允许过的目录本次运行内不再重复问。
                      </div>
                    </>
                  )}
                  {draft.permission.mode === 'plan' && (
                    <>
                      <div className="cap-line">
                        <span className="muted">现在能做</span> 只能查看文件，不能修改
                      </div>
                      <div className="cap-line muted">
                        AI 会先给出完整方案并问清必须确认的问题。你看过之后在对话里点
                        「开始执行」，它才会真的改文件。切换到别的会话需要重新批准。
                      </div>
                    </>
                  )}
                  {draft.permission.mode === 'full' && (
                    <>
                      <div className="cap-line">
                        <span className="muted">警告</span>{' '}
                        <span style={{ color: 'var(--danger)' }}>
                          不做任何边界检查，AI 可以读写磁盘上任何位置
                        </span>
                      </div>
                      <div className="cap-line muted">
                        只在你明确知道自己在做什么时使用（例如让 AI 批量重构多个项目）。
                        日常写代码请用对话模式。
                      </div>
                    </>
                  )}
                </div>

                <div className="hint card-hint">
                  切换模式会清空本次运行内已授予的越界许可 ——
                  否则从宽松模式切回严格模式时，之前放行的目录会继续免检。
                </div>
              </section>
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
                  <Select
                    value={draft.capability.mode}
                    options={[
                      { value: 'auto', label: '自动 — 按本机探测（推荐）' },
                      { value: 'conservative', label: '保守 — 只放开文件读写，各机器表现一致' },
                      { value: 'full', label: '全开 — 忽略探测，本机不支持时工具会返回可读错误' }
                    ]}
                    onChange={(v) => patchCapability({ mode: v as CapabilityMode })}
                    ariaLabel="放开程度"
                    title="决定 AI 能对文件做什么"
                    block
                  />
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

            {/*
              Skills 与 MCP 原先在左侧栏的三个动作键里（新对话 / Skills / MCP）。
              移进设置页的原因：这两项都是「填一次就不动」的配置，不是高频动作，
              占着侧栏最显眼的位置反而不划算 —— 侧栏该留给会话与文件树。
            */}
            {section === 'skills' && (
              <>
                <section className="card">
                  <div className="card-title">Skills（技能）</div>
                  <div className="hint card-hint">
                    技能是<strong>「怎么做某件事」的说明书</strong>，由你自己写成
                    Markdown 文件。AI 在做不熟悉的活之前会先看一眼有哪些技能，
                    需要时才读正文并照着做 —— 所以正文可以写得很具体，不必担心占上下文。
                  </div>

                  {/*
                    两个存放位置。列表里每条都会标明来源，
                    因为「同一个 id 项目级覆盖全局」这条规则如果不显示来源，
                    用户会疑惑「我改了全局那份怎么没生效」。
                  */}
                  <div className="cap-status">
                    <div className="cap-line">
                      <span className="muted">全局技能</span>
                      <code>skills/&lt;目录名&gt;/SKILL.md</code>（所有项目共用）
                    </div>
                    <div className="cap-line">
                      <span className="muted">项目技能</span>
                      <code>.hangke/skills/&lt;目录名&gt;/SKILL.md</code>
                      （跟着仓库走，同名时覆盖全局）
                    </div>
                  </div>

                  <div className="hint card-hint">
                    frontmatter 里写 <code>name</code> 和 <code>description</code>，
                    下面写正文。目录名就是技能 id。以 <code>_</code> 开头的目录会被跳过
                    （草稿可以先这样放着不让 AI 看到）。
                  </div>

                  <div className="field">
                    <label>已发现的技能（{skills.length}）</label>
                    {skills.length === 0 ? (
                      <div className="empty-line">
                        还没有技能。点下面的「打开技能目录」建一个，里面有示例可参考。
                      </div>
                    ) : (
                      <div className="skill-list">
                        {skills.map((sk) => (
                          <button
                            key={`${sk.source}-${sk.id}`}
                            className="skill-row"
                            title={`${sk.path}\n点击看正文`}
                            onClick={() => void viewSkill(sk.id)}
                          >
                            <span className="skill-name">{sk.name}</span>
                            <span className="skill-id">{sk.id}</span>
                            <span className={`skill-src is-${sk.source}`}>
                              {sk.source === 'project' ? '本项目' : '全局'}
                            </span>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>

                  {skillPreview !== null && (
                    <>
                      <div className="hint card-hint">技能正文（AI 读到的就是这些）：</div>
                      <textarea className="doc-preview" readOnly rows={12} value={skillPreview} />
                      <div className="card-foot">
                        <button className="ghost" onClick={() => setSkillPreview(null)}>
                          收起
                        </button>
                      </div>
                    </>
                  )}

                  <div className="field">
                    <label className="toggle">
                      <input
                        type="checkbox"
                        checked={draft.skills.enabled}
                        onChange={(e) => patchSkills(e.target.checked)}
                      />
                      <span>允许 AI 使用技能</span>
                    </label>
                    <div className="hint">
                      关掉后 listSkills / readSkill 不会出现在 AI 的工具表里 ——
                      它看不到就不会去调。技能正文相当于你写给 AI 的指令，
                      不确定内容是否合适时可以关掉。
                    </div>
                  </div>

                  <div className="card-foot">
                    <button className="ghost" disabled={busy} onClick={() => void openSkills()}>
                      打开技能目录
                    </button>
                    <button className="ghost" disabled={busy} onClick={() => void refreshSkills()}>
                      重新扫描
                    </button>
                  </div>
                </section>
              </>
            )}

            {section === 'mcp' && (
              <section className="card">
                <div className="card-title">MCP 服务器</div>
                <div className="hint card-hint">
                  MCP（Model Context Protocol）让你把<strong>外部工具服务</strong>接给 AI。
                  每个服务器是一个本地命令（如 <code>npx</code>），启动后用
                  JSON-RPC 通信；它提供的工具会自动出现在 AI 的工具表里，
                  名字带 <code>mcp__服务器__工具</code> 前缀。
                </div>

                {mcpList.length === 0 ? (
                  <div className="empty-line">
                    还没有配置服务器。MCP 服务器由「命令 + 参数」启动，
                    常见的是 <code>npx -y &lt;包名&gt;</code> 形式。
                  </div>
                ) : (
                  <div className="mcp-list">
                    {mcpList.map((sv) => (
                      <div key={sv.id} className="mcp-row">
                        <div className="mcp-main">
                          <div className="mcp-name">
                            {sv.name}
                            <span className={`mcp-dot is-${sv.status}`} />
                            <span className="mcp-status">{sv.detail}</span>
                          </div>
                          <div className="mcp-cmd" title={`${sv.command} ${sv.args.join(' ')}`}>
                            {sv.command} {sv.args.join(' ')}
                          </div>
                          {sv.tools.length > 0 && (
                            <div className="mcp-tools">工具：{sv.tools.join('、')}</div>
                          )}
                        </div>
                        <button
                          className="ghost btn-sm"
                          disabled={busy}
                          onClick={() => void reconnect(sv.id)}
                        >
                          {sv.status === 'ready' ? '重连' : '连接'}
                        </button>
                      </div>
                    ))}
                  </div>
                )}

                <div className="hint card-hint">
                  服务器进程在应用退出时会被一起关掉。配置存在 config.json 的
                  <code>mcp.servers</code> 里，也可以直接改那个文件后重连。
                </div>

                <div className="card-foot">
                  <button className="ghost" onClick={() => void refreshMcp()}>
                    刷新状态
                  </button>
                </div>
              </section>
            )}

            {section === 'about' && (
              <section className="card">
                <div className="card-title">关于</div>
                <div className="about-brand">
                  <img className="about-logo" src="./logo.png" alt="" />
                  <div>
                    <div className="about-name">hangkeIDE</div>
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
/** 锁：表示「这部分程序维护，你改不了」 */
function LockIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true" style={{ verticalAlign: '-2px' }}>
      <g fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round">
        <rect x="5" y="10.5" width="14" height="9.5" rx="2" />
        <path d="M8 10.5V7.8a4 4 0 0 1 8 0v2.7" strokeLinecap="round" />
      </g>
    </svg>
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
