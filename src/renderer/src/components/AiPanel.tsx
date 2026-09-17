import { forwardRef, memo, useEffect, useImperativeHandle, useRef, useState } from 'react'
import type {
  AiUsage,
  ApprovalRequest,
  ChatContentBlock,
  ChatMessage,
  CompactionNotice,
  PermissionMode
} from '@shared/types'
import { SUMMARY_MARKER } from '@shared/types'
import { splitReasoning, splitReasoningStreaming } from '@shared/think-blocks'
import { normalizeChatText } from '@shared/chat-text'
import { compressImage, humanBytes, withImages } from '../image-input'
import { askConfirm } from '../store/confirm'
import { useAppStore } from '../store/useAppStore'
import {
  matchSlashCommands,
  parseSlashCommand,
  parseSlashQuery,
  slashCommandHelp,
  type SlashCommand
} from '../slash-commands'
import Select from './ui/Select'
import ConfirmDialog from './ConfirmDialog'
import { AtIcon, PaperclipIcon, SendIcon } from './icons'

type Role = 'user' | 'assistant' | 'system' | 'error' | 'notice'

/**
 * 哪些角色算「真正的对话内容」，要落盘、也要发给模型。
 *
 * ## 为什么需要这个判定（别在两处各写一遍）
 *
 * 以前这里是硬编码的 `role === 'user' || role === 'assistant'`，
 * 出现在发送、落盘两个地方。压缩功能加进来之后**摘要必须是 system**，
 * 而那两处过滤会把摘要**静默丢掉** —— 表现是：
 * 「压缩完看着省了，下一轮又变回完整历史」，因为摘要根本没进过 wire。
 *
 * 所以收成一个判定：
 *   - `user` / `assistant`：正常对话
 *   - `system`：**压缩摘要**（要发、也要存 —— 不然重开会话就丢上下文）
 *   - `error` / `notice`：纯本地提示（如 `/help` 的输出、网络错误），
 *     既不发也不存。存下来的话，下次打开会看到一堆「连接超时」。
 */
function isConversationRole(role: Role): boolean {
  return role === 'user' || role === 'assistant' || role === 'system'
}

/** 父组件能调进来的动作，目前只有「清空聊天区」 */
export interface AiPanelHandle {
  reset: () => void
}

interface ToolStep {
  id: string
  name: string
  summary: string
  phase: 'start' | 'done'
  /** 只有 done 阶段才有意义 */
  ok?: boolean
}

interface ChatItem {
  id: string
  role: Role
  text: string
  /** 本轮用量的统计，流结束时才有 */
  usage?: AiUsage
  /** AI 对文件做过什么，按发生顺序排 */
  tools?: ToolStep[]
  /**
   * 模型的思考过程（思维链）。
   *
   * 与 text 分开存：正文进气泡，思考过程折叠在「思考过程」里。
   * 上游有两条来源（独立字段 / 正文里的 think 标签），
   * 都在渲染前归一化到这里，见 shared/think-blocks.ts。
   */
  reasoning?: string
  /**
   * 这条消息是否**正在**接收流式内容。
   *
   * ⚠️ 必须有这个显式标记，不能靠「text 为空」来判断在加载 ——
   * 那是「停止后一直转圈」的根因：
   * 用户点了停止，主进程不再发内容，text 保持为空，
   * 于是气泡里的三个点永远转下去，看起来像没停下来。
   * 判定「在加载」要看**请求是否还活着**，而不是看它有没有内容。
   */
  streaming?: boolean
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

/** 引用胶囊上只显示文件名，完整路径放 title */
function baseName(target: string): string {
  const parts = target.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] || target
}

/**
 * 三种权限模式的选项。
 *
 * 放在对话输入框这一侧（而不是编辑器那边）：它决定「AI 现在能不能动手」，
 * 是**下指令前**要确认的东西 —— 和「我这句话怎么说」在同一个动作里。
 * 放到编辑器工具栏就跑到写代码那一侧去了，视线与动作都断开。
 */
const MODE_OPTIONS: ReadonlyArray<{ value: PermissionMode; label: string; hint: string }> = [
  {
    value: 'chat',
    label: '对话模式',
    hint: '当前项目内自由读写；要动项目外的文件会先弹卡片问你'
  },
  {
    value: 'plan',
    label: '计划模式',
    hint: 'AI 只能查看，先给方案；你点「开始执行」它才会改文件'
  },
  {
    value: 'full',
    label: '完全允许',
    hint: '不做任何范围检查，AI 可读写磁盘上任何位置'
  }
]

/**
 * 流式文本的合并间隔（毫秒）。
 *
 * 约等于两帧。低于 16ms 就接近「每帧都刷」，省不下多少；
 * 高于 50ms 就会看出「一个字一个字蹦」变成「一段一段跳」。
 */
const STREAM_FLUSH_MS = 30

/**
 * 把引用文件转成**路径清单**附到提问后面。
 *
 * ⚠️ 这里只给路径，**不读正文**，这一点改过一次设计：
 *
 * 原来是把每个文件的正文读出来、整段拼进消息。问题是：
 *   1. 输入框与气泡里会显示一大坨代码，把真正想说的话淹没
 *   2. 引用 3 个文件就塞进几万字符，token 白烧；
 *      历史消息还会一轮轮重复带上，上下文很快就被挤爆
 *   3. AI 手上本来就有 readFile / grep 工具，**按需读**比一次全塞更准
 *      （它只读真正相关的那几段）
 *
 * 现在只告诉它「用户指名了这几个文件」，读不读、读多少由它自己决定。
 * 相对路径能直接用：工具层按当前工作区解析（见 main/paths.ts）。
 */
function buildReferenceBlock(files: string[]): string {
  if (!files.length) return ''
  const list = files.map((f) => `- ${f}`).join('\n')
  return `（用户引用了以下文件，需要时请用 readFile 查看：\n${list}\n）`
}



/** 按当前时间给一句问候，比固定的「你好」更像在用真东西 */
function greeting(): string {
  const h = new Date().getHours()
  if (h < 6) return '夜深了'
  if (h < 12) return '早上好'
  if (h < 14) return '中午好'
  if (h < 18) return '下午好'
  return '晚上好'
}

const AiPanel = forwardRef<
  AiPanelHandle,
  { onOpenSettings: () => void; onNewSession: () => void }
>(function AiPanel({ onOpenSettings, onNewSession }, ref): JSX.Element {
  const config = useAppStore((s) => s.config)
  /** 只用来显示当前会话标题（历史列表已移到顶栏，见 SessionHistory.tsx） */
  const sessions = useAppStore((s) => s.sessions)
  const openFile = useAppStore((s) => s.openFile)
  const sessionId = useAppStore((s) => s.sessionId)
  const sessionLoading = useAppStore((s) => s.sessionLoading)
  const workspace = useAppStore((s) => s.workspace)
  const openWorkspace = useAppStore((s) => s.openWorkspace)
  /**
   * 「最近会话」浮层。
   *
   * 会话列表原先在左侧栏。移到聊天面板顶部的原因：换一段讨论是「对话」这件事
   * 的一部分 —— 聊到一半想切，眼睛不必从右栏跑到左栏。
   * 做成按钮 + 浮层而不是常驻列表：常驻会把消息区挤矮，而切会话是间歇动作。
   */

  /**
   * 越界访问的授权请求。
   *
   * 由主进程发起（它才是要动文件的那一方），这里只负责显示与回话。
   * 用数组而不是单个：模型一轮可能并发发几个工具调用，每个越界路径
   * 都会来问一次 —— 只留最后一个会把前面的请求永远挂在那儿
   * （主进程侧要等 60 秒才超时拒绝，期间那一轮工具全卡住）。
   */
  const [approvals, setApprovals] = useState<ApprovalRequest[]>([])
  useEffect(() => {
    return window.api.onApprovalRequest((req) => {
      setApprovals((prev) => [...prev, req])
    })
  }, [])

  const answerApproval = async (req: ApprovalRequest, choice: 'once' | 'dir' | 'deny'): Promise<void> => {
    setApprovals((prev) => prev.filter((item) => item.id !== req.id))
    await window.api.resolveApproval(req.id, choice)
  }

  /** 权限模式。计划模式下要额外显示「开始执行」 */
  const permissionMode = config?.permission.mode || 'chat'

  /**
   * 「模型是否配齐」。
   *
   * 声明位置提前到用它的地方之前：下面的 loadModels / 发送键都要读它。
   * 原来在文件靠后处，现在这两处用到，放后面会报「used before declaration」。
   */
  const configured = Boolean(config?.ai.baseUrl && config?.ai.apiKey && config?.ai.model)

  const [executing, setExecuting] = useState(false)
  /**
   * 待用户二次确认的目标模式。
   *
   * 只有「完全允许」会走到这里 —— 它没有任何边界检查，误点一下
   * AI 就能读写磁盘上任意位置，而这是**不可逆**的（对话已经发生）。
   * 其余两档要么受工作区限制、要么只能读，误点的代价很小，
   * 弹确认反而会让用户养成「无脑点确定」的习惯，削弱这道确认的意义。
   */
  const [pendingMode, setPendingMode] = useState<PermissionMode | null>(null)

  /**
   * 模型选择（输入框工具条里）。
   *
   * 能拉到列表就用下拉；拉不到（中转站不开放 / 还没配好）就退化成
   * 只读的当前模型名，点它去设置页手填 —— 换模型有两条路，
   * 比「只有下拉、拉不到就空白」可靠。
   */
  const [models, setModels] = useState<string[]>([])
  const [modelBusy, setModelBusy] = useState(false)
  const [modelError, setModelError] = useState('')

  const loadModels = async (): Promise<void> => {
    if (!configured) return
    setModelBusy(true)
    try {
      const result = await window.api.aiListModels()
      setModels(result.models)
      setModelError(result.ok ? '' : result.detail)
    } catch (err) {
      setModels([])
      setModelError(err instanceof Error ? err.message : String(err))
    } finally {
      setModelBusy(false)
    }
  }

  /**
   * 自动拉一次模型列表。
   *
   * 依赖 configured：用户刚在设置里填完模型、切回来就能看到列表，
   * 不用手动点。拉不到也不打扰 —— 原因写在按钮 title 里。
   */
  useEffect(() => {
    if (configured) void loadModels()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [configured])

  const chooseModel = async (model: string): Promise<void> => {
    if (!model || model === config?.ai.model) return
    try {
      const saved = await window.api.setConfig({ ai: { ...config!.ai, model } })
      useAppStore.getState().applyConfig(saved)
    } catch (err) {
      useAppStore.getState().pushLog({
        time: '',
        level: 'warn',
        scope: 'ai',
        text: `切换模型失败：${err instanceof Error ? err.message : String(err)}`
      })
    }
  }

  /**
   * 切权限模式。
   *
   * 主进程返回**整份配置**，直接写回 store —— store、设置页、以及下一次
   * 对话要用的 system prompt（模式会进「当前运行状态」段）全部立刻同步。
   * 切走计划模式时要清掉「已批准执行」的界面状态：主进程在模式变化时
   * 也会清，两边必须一致，否则界面显示「已批准」而实际写入仍被拦。
   */
  const chooseMode = async (mode: PermissionMode): Promise<void> => {
    if (mode === permissionMode) return
    /*
     * 「完全允许」要二次确认，其余两档直接切。
     *
     * 判据是**代价不对称**：完全允许没有边界检查，一次误点就让 AI
     * 能读写磁盘上任何位置，而已经发生的读写收不回来；而对话/计划模式
     * 要么受工作区限制、要么只能读，误点最多再点回去。
     *
     * 不给所有模式都加确认，是因为「每步都问」会让人形成
     * 无条件点确定的肌肉记忆 —— 那道确认就白设了。
     */
    if (mode === 'full') {
      setPendingMode(mode)
      return
    }
    await applyMode(mode)
  }

  /** 真正落盘切换。从 chooseMode 与确认弹层两处调用 */
  const applyMode = async (mode: PermissionMode): Promise<void> => {
    try {
      const saved = await window.api.setPermissionMode(mode)
      useAppStore.getState().applyConfig(saved)
      setExecuting(false)
    } catch (err) {
      useAppStore.getState().pushLog({
        time: '',
        level: 'warn',
        scope: 'ai',
        text: `切换权限模式失败：${err instanceof Error ? err.message : String(err)}`
      })
    }
  }
  /** 切会话/切模式后要重置「已批准执行」的显示状态 */
  useEffect(() => {
    setExecuting(false)
  }, [sessionId, permissionMode])

  /**
   * `@` 引用文件的候选列表。
   *
   * 文件清单在**第一次敲 @ 时**才拉（不是挂载时就拉）：没打开项目时
   * 这个列表是空的，而挂载时就发一次 IPC 等于每次开新会话都白跑一趟
   * 递归遍历。拉回来之后按当前工作区缓存，切项目时清掉重拉。
   */
  const [fileList, setFileList] = useState<string[]>([])
  const [atOpen, setAtOpen] = useState(false)
  /** `@` 后面已经敲进去的过滤词 */
  const [atQuery, setAtQuery] = useState('')
  /** 输入框里那个 `@` 的下标，选中后要从这里把它连同过滤词一起删掉 */
  const [atStart, setAtStart] = useState(-1)
  /** 高亮的候选下标（↑↓ 移动，回车选中） */
  const [atIndex, setAtIndex] = useState(0)

  /**
   * `/` 命令的候选列表状态。
   *
   * 与 `@` 分开存而不是共用一个浮层：两者的触发规则、过滤方式、
   * 「选中后往输入框里填什么」都不一样（@ 填路径、/ 直接执行），
   * 合在一起会得到一堆 if。两边同时打开也不可能 —— 光标前只能是其一。
   */
  const [slashOpen, setSlashOpen] = useState(false)
  const [slashQuery, setSlashQuery] = useState('')
  const [slashStart, setSlashStart] = useState(-1)
  const [slashIndex, setSlashIndex] = useState(0)
  /**
   * 正在压缩上下文。
   *
   * 与 busy 分开：busy 表示「有回答在流」，压缩期间并不在流式输出，
   * 但同样不该让人连点两次 `/compact`（每次都要花一次模型调用）。
   */
  const [compacting, setCompacting] = useState(false)

  const loadFiles = async (): Promise<void> => {
    try {
      setFileList(await window.api.listFiles())
    } catch {
      setFileList([])
    }
  }

  // 换工作区后候选列表必须重拉：否则会拿上个项目的文件去补全
  useEffect(() => {
    setFileList([])
    setAtOpen(false)
  }, [workspace])

  const [items, setItems] = useState<ChatItem[]>([])
  /**
   * items 的镜像。
   *
   * 为什么需要它：`syncStore` 原来靠「调 setItems 的 updater 同步把权威值
   * 写进局部变量」来拿到最新列表。那个写法依赖 React 的一个内部行为 ——
   * **只有当队列里没有其它待处理更新时，updater 才会被同步求值**。
   * 它确实常常成立，但一旦不成立（同一 tick 里前面已有别的 setItems，
   * 比如 flushDelta 有缓冲时必然发生），`authoritative` 会停在初始的 `[]`，
   * 于是 `setSessionMessages([])` 把整轮对话**清空**；而
   * session-slice 见到空数组又直接 return，连磁盘都不写。
   *
   * 这类 bug 不报错、只是数据没了，极难排查。改成显式镜像：
   * 所有改 items 的地方同步更新这个 ref，读的时候读 ref ——
   * 不依赖任何 React 内部行为。
   */
  const itemsRef = useRef<ChatItem[]>([])

  /**
   * 统一的 items 更新入口：同时维护 ref 镜像。
   *
   * 直接把 setItems 换掉而不是在每个调用点手动同步 —— 后者一定会漏。
   * 支持函数式更新（与 React 的 setState 同签名）。
   */
  const updateItems = (next: ChatItem[] | ((prev: ChatItem[]) => ChatItem[])): void => {
    const value = typeof next === 'function' ? (next as (p: ChatItem[]) => ChatItem[])(itemsRef.current) : next
    itemsRef.current = value
    setItems(value)
  }
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  /** 待插入输入框的引用文件（来自文件树右键「插入引用」） */
  const [refs, setRefs] = useState<string[]>([])
  /**
   * 待发送的图片（已压缩）。
   *
   * 只存压缩后的 dataUrl，不存原始 File —— 原图可能几 MB，
   * 留在内存里既没必要（发出去的是压缩版）也容易 OOM。
   */
  const [images, setImages] = useState<Array<{ dataUrl: string; bytes: number; name: string }>>([])
  /** 压缩中：压缩是异步的，期间要禁用发送，否则会发出一条没有图的空消息 */
  const [imageBusy, setImageBusy] = useState(false)
  /** 输入框是否展开（单行 ↔ 6 行）。写长提示词时用 */
  const [expanded, setExpanded] = useState(false)
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const requestRef = useRef('')
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const inputRef = useRef<HTMLTextAreaElement | null>(null)
  /** 攒着还没写进 items 的流式片段（合并节流用，见 onAiStream） */
  const deltaBufRef = useRef('')
  /**
   * 思考过程的缓冲。
   *
   * 与 deltaBufRef 分开：两者是**同一轮里交替到达的两条流**，
   * 共用一个缓冲会把它们按到达顺序粘成一串，正文里就会混进思维链。
   */
  const reasoningBufRef = useRef('')
  /** 待执行的合并定时器。null 表示当前没有排队的刷新 */
  const deltaTimerRef = useRef<number | null>(null)

  /**
   * 从 store 的 messages 重建展示用 items。
   *
   * 分工：items 是渲染态（带 usage / tools 这些只在本轮有意义的字段），
   * messages 是持久化态（只有 role / text / at）。
   * 历史上存下来的消息重建时没有 usage，这是对的 —— 那些数字是上一轮的，
   * 显示在旧气泡上反而让人以为是当前的。
   */
  const rebuildFromStore = (): void => {
    const stored = useAppStore.getState().messages
    updateItems(
      stored.map((m, i) => ({
        id: `h-${i}`,
        role: m.role,
        text: m.text
      }))
    )
  }

  /**
   * 会话切换（点左侧列表）或新会话后，把聊天区换成对应的内容。
   *
   * 监听 sessionId 而不是 messages：messages 在流式回答期间每来一个 token 都变，
   * 监听它会把正在生成的回答用磁盘上的旧版本覆盖掉。
   */
  useEffect(() => {
    if (requestRef.current) return
    rebuildFromStore()
  }, [sessionId])

  /**
   * 切换会话时中断在飞的请求。
   *
   * 为什么必须中断：上面那个 effect 在有请求在飞时**故意跳过重建**，
   * 但 sessionId 已经变了 —— 这一轮结束后 `syncStore()` 会把 items
   * 写进 store 的 messages，而那时 messages 已经属于**新的**会话。
   * 学生答到一半点了另一条会话，回答的尾段就落进了另一条记录里。
   *
   * 放一个独立 effect 而不是并进上面那条：上面那条依赖 requestRef 的非响应式
   * 读取，把中断逻辑混进去会让「为什么这次没重建」更难读。
   */
  const sessionSwitchAt = useAppStore((s) => s.sessionSwitchAt)
  useEffect(() => {
    if (!sessionSwitchAt) return
    const id = requestRef.current
    if (!id) return
    void window.api.aiAbort(id)
    requestRef.current = ''
    if (deltaTimerRef.current !== null) {
      window.clearTimeout(deltaTimerRef.current)
      deltaTimerRef.current = null
    }
    deltaBufRef.current = ''
    reasoningBufRef.current = ''
    setBusy(false)
  }, [sessionSwitchAt])

  /**
   * 「新对话」：清空消息与输入，并中断正在跑的请求。
   *
   * 必须中断 —— 否则上一轮的回答会继续往新会话里写 token，
   * 学生看到的是「明明点了新对话，答案还在自己往外冒」。
   */
  useImperativeHandle(ref, () => ({
    reset() {
      resetPanel()
    }
  }))

  /**
   * 「新对话」：清空消息与输入，并中断正在跑的请求。
   *
   * 必须中断 —— 否则上一轮的回答会继续往新会话里写 token，
   * 学生看到的是「明明点了新对话，答案还在自己往外冒」。
   *
   * 单独抽出来是因为 `/new` 命令与顶栏按钮都要用它：
   * 两处各写一份的话，以后改了中断逻辑只改一处，另一处就会留一个
   * 「清了界面但请求还在跑」的缺口。
   */
  function resetPanel(): void {
    if (requestRef.current) void window.api.aiAbort(requestRef.current)
    requestRef.current = ''
    // 缓冲区与定时器必须一起清：留着定时器的话，它稍后会拿旧 requestId
    // 往一个已经不存在的气泡里写文本（那次 map 找不到目标，但白跑一遍）
    if (deltaTimerRef.current !== null) {
      window.clearTimeout(deltaTimerRef.current)
      deltaTimerRef.current = null
    }
    deltaBufRef.current = ''
    updateItems([])
    setInput('')
    setRefs([])
    setBusy(false)
    // 消息本体由 store.startNewSession 清（它负责落盘旧会话），
    // 这里只清展示态，两边不重复清同一份数据
  }

  // 面板卸载时清掉待执行的定时器，避免在卸载后 setState
  useEffect(() => {
    return () => {
      if (deltaTimerRef.current !== null) {
        window.clearTimeout(deltaTimerRef.current)
        deltaTimerRef.current = null
      }
    }
  }, [])

  // 文件树点了「插入引用」：把文件挂到输入框上方，而不是直接拼进文本里。
  // 拼进文本的话，学生想删掉一个引用得手动选中一大段路径，很难操作。
  const pendingRefs = useAppStore((s) => s.pendingRefs)
  useEffect(() => {
    if (!pendingRefs.length) return
    const pending = useAppStore.getState().consumeRefs()
    setRefs((prev) => [...prev, ...pending.filter((p) => !prev.includes(p))])
    inputRef.current?.focus()
  }, [pendingRefs])

  /**
   * 把攒着的流式片段立刻写进 items，并返回合并后的文本。
   *
   * **流结束前必须调一次**，否则最后 30ms 的内容会丢 ——
   * 而丢的正好是回答的最后一句，学生最需要的那句。
   * 同时它把最新文本返回出来，因为 setState 是异步的，
   * 紧接着读 items 还是旧值（落盘时要用）。
   */
  const flushDelta = (): string => {
    if (deltaTimerRef.current !== null) {
      window.clearTimeout(deltaTimerRef.current)
      deltaTimerRef.current = null
    }
    const buffered = deltaBufRef.current
    const bufferedReasoning = reasoningBufRef.current
    deltaBufRef.current = ''
    reasoningBufRef.current = ''
    if (!buffered && !bufferedReasoning) return ''
    updateItems((prev) =>
      prev.map((it) => {
        if (it.id !== requestRef.current) return it
        return {
          ...it,
          text: it.text + buffered,
          ...(bufferedReasoning ? { reasoning: (it.reasoning || '') + bufferedReasoning } : {})
        }
      })
    )
    return buffered
  }

  useEffect(() => {
    return window.api.onAiStream((chunk) => {
      if (chunk.requestId !== requestRef.current) return
      if (chunk.kind === 'delta') {
        /*
         * 流式文本做合并节流，不每个 token 都 setItems。
         *
         * 模型每秒能推几十个 token，直接 setItems 就是每秒几十次重渲染，
         * 而且每次都要 map 一遍全部历史消息。老机器上生成长回答时会明显发涩。
         * 把这段时间内到达的片段攒起来一次写入，React 只渲染一次。
         * 30ms 约等于两帧，肉眼看不出延迟，但渲染次数能降一个量级。
         */
        /*
         * 思考过程与正文分两条缓冲。
         *
         * 上游会在同一轮里交替送这两类内容（先想一段、再答一段、
         * 调工具后再想一段）。合用一个缓冲会按到达顺序粘成一条，
         * 于是思维链混进正文 —— 而那正是要避免的。
         */
        if (chunk.reasoning) reasoningBufRef.current += chunk.text || ''
        else deltaBufRef.current += chunk.text || ''

        if (deltaTimerRef.current === null) {
          deltaTimerRef.current = window.setTimeout(() => {
            deltaTimerRef.current = null
            const buffered = deltaBufRef.current
            const bufferedReasoning = reasoningBufRef.current
            deltaBufRef.current = ''
            reasoningBufRef.current = ''
            if (!buffered && !bufferedReasoning) return
            updateItems((prev) =>
              prev.map((it) => {
                if (it.id !== chunk.requestId) return it
                return {
                  ...it,
                  text: it.text + buffered,
                  ...(bufferedReasoning
                    ? { reasoning: (it.reasoning || '') + bufferedReasoning }
                    : {})
                }
              })
            )
          }, STREAM_FLUSH_MS)
        }
      } else if (chunk.kind === 'tool') {
        // 工具步骤要和已生成的内容保持时间顺序，先把攒着的文本落下去
        flushDelta()
        const step = chunk.tool
        if (!step) return
        updateItems((prev) =>
          prev.map((it) => {
            if (it.id !== chunk.requestId) return it
            const tools = [...(it.tools || [])]
            if (step.phase === 'start') {
              tools.push({
                id: `${tools.length}-${step.name}`,
                name: step.name,
                summary: step.summary,
                phase: 'start'
              })
            } else {
              // 从后往前找最近一个同名的未完成步骤，收尾
              for (let i = tools.length - 1; i >= 0; i--) {
                if (tools[i].name === step.name && tools[i].phase === 'start') {
                  tools[i] = {
                    ...tools[i],
                    phase: 'done',
                    summary: step.summary || tools[i].summary,
                    ok: step.ok
                  }
                  break
                }
              }
            }
            return { ...it, tools }
          })
        )
      } else if (chunk.kind === 'compacted') {
        /*
         * 主进程刚把上下文压掉了，要同步改本地的历史。
         *
         * 为什么必须在**流还没结束**时就处理：这一轮结束后 syncStore
         * 会拿 itemsRef 整份回写 store。若等到那时再合并压缩结果，
         * 竞争关系就说不清了（谁先谁后都可能），而漏掉的表现正是
         * 「压缩看着生效了，下一轮又变回完整历史」。
         *
         * 这里先落，则后面的 syncStore 天然带上「摘要 + 保留的几轮」。
         */
        if (chunk.compaction) applyCompaction(chunk.compaction)
      } else if (chunk.kind === 'error') {
        // 报错也要先把攒着的文本落下去，否则学生看到的是「回答到一半就没了」
        flushDelta()
        updateItems((prev) =>
          prev.map((it) =>
            it.id === chunk.requestId
              ? {
                  ...it,
                  role: 'error',
                  text: `${it.text}${chunk.message || ''}`,
                  streaming: false
                }
              : it
          )
        )
        setBusy(false)
      } else {
        /*
         * 流结束（正常跑完、或被用户停止 —— 主进程两种情况都会发 done，
         * 见 ipc/ai.ts 里 abort 分支的注释）。
         * streaming 必须在这里清掉：它是「还在加载」的唯一依据，
         * 不清的话气泡会一直转圈。
         */
        flushDelta()
        setBusy(false)
        updateItems((prev) =>
          prev.map((it) => {
            if (it.id !== chunk.requestId) return it
            return { ...it, streaming: false, ...(chunk.usage ? { usage: chunk.usage } : {}) }
          })
        )
      }
    })
  }, [])

  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [items])

  /**
   * 把任意一份 items 写回 store。
   *
   * 与 syncStore 的区别：那个是「把流式结果补进来」，依赖 requestRef 找气泡；
   * 这个是「消息被增删改之后同步」,按传入的列表整份写。
   * 两者都做「items → messages」的转换，但触发时机与数据来源不同，
   * 合成一个会得到一堆 if。
   */
  const syncFromItems = (list: ChatItem[]): void => {
    const at = new Date().toISOString()
    const payload = list
      .filter((it) => isConversationRole(it.role))
      .map((it) => ({ role: it.role as 'user' | 'assistant' | 'system', text: it.text, at }))
    useAppStore.getState().setSessionMessages(payload)
  }

  /**
   * 把当前 items 写回 store 的 messages（进而落盘）。
   *
   * 只在「一轮回答结束」和「用户主动停止」这两个时刻调，不在流式过程中调 ——
   * 流式期间每来一个 token 就整份写盘的话，一轮回答要写几百次文件。
   * error 角色的气泡不入库：那是网络层的失败提示，不是对话内容，
   * 存下来下次打开会看到一堆「连接超时」。
   *
   * 数据来源是 itemsRef（items 的同步镜像），不是 React state ——
   * 闭包里的 items 可能是旧的，而 ref 永远是最新的一份。
   *
   * @param pending 还没进 items 的流式尾段（合并节流攒下来的），必须先并进去
   */
  const syncStore = (pending = ''): void => {
    const at = new Date().toISOString()
    /*
     * 从 ref 读权威列表（而不是靠 updater 的同步求值，见 itemsRef 的说明）。
     * 有 pending 时先把尾段并进正在流的那条，再落库 —— 否则停止时最后几个字会丢。
     */
    const authoritative = pending
      ? itemsRef.current.map((it) =>
          it.id === requestRef.current ? { ...it, text: it.text + pending } : it
        )
      : itemsRef.current
    if (pending) updateItems(authoritative)
    const payload = authoritative
      .filter((it) => isConversationRole(it.role))
      .map((it) => ({ role: it.role as 'user' | 'assistant' | 'system', text: it.text, at }))
    useAppStore.getState().setSessionMessages(payload)
  }

  /** 当前模型是否支持图片。不支持时图片入口整体置灰 */
  const visionOn = Boolean(config?.ai.supportsVision)

  /**
   * 把一批图片文件压缩后挂进待发队列。
   *
   * 逐张 try/catch：某一张损坏（或格式不支持）不该让整批都失败 ——
   * 学生一次选了三张，一张坏了另外两张仍然应该能发出去。
   */
  const attachImages = async (files: File[]): Promise<void> => {
    const picked = files.filter((file) => file.type.startsWith('image/'))
    if (picked.length === 0) return
    if (!visionOn) {
      /*
       * 不用 window.alert：它会阻塞渲染进程（详见 store/confirm.ts）。
       * 这只是「告诉你为什么没反应」的通知，不是要用户做决定，
       * 所以走日志通道 —— 与 App.tsx 里 openInBrowser 失败的处理一致。
       */
      useAppStore.getState().pushLog({
        time: '',
        level: 'warn',
        scope: 'ai',
        text: '当前模型没有开启图片支持。如果这个模型确实能看图，请到「设置 → AI 模型」里勾选「支持图片输入」。'
      })
      return
    }
    setImageBusy(true)
    const added: Array<{ dataUrl: string; bytes: number; name: string }> = []
    const failed: string[] = []
    for (const file of picked) {
      try {
        const out = await compressImage(file)
        added.push({
          dataUrl: out.dataUrl,
          bytes: out.bytes,
          name: file.name || `粘贴的图片（${out.width}×${out.height}）`
        })
      } catch (err) {
        failed.push(`${file.name || '图片'}：${err instanceof Error ? err.message : String(err)}`)
      }
    }
    if (added.length) setImages((prev) => [...prev, ...added])
    if (failed.length) {
      useAppStore.getState().pushLog({
        time: '',
        level: 'warn',
        scope: 'ai',
        text: `有 ${failed.length} 张图片没能加入：${failed.join('；')}`
      })
    }
    setImageBusy(false)
  }

  /**
   * 粘贴图片。
   *
   * 这是图片输入的主路径：学生用 Win+Shift+S / QQ / 微信截完图，
   * 直接 Ctrl+V 贴进来 —— 他们本来就这么发消息，不用学新操作。
   * 不做内置截屏正是因为这个习惯已经覆盖了绝大多数场景。
   *
   * 只在剪贴板里真的有图片时才拦截：粘贴普通文本必须放过去，
   * 否则「复制一段代码贴进输入框」这个高频操作就坏了。
   */
  const onPaste = (e: React.ClipboardEvent): void => {
    const files = Array.from(e.clipboardData?.files || []).filter((f) =>
      f.type.startsWith('image/')
    )
    if (files.length === 0) return
    e.preventDefault()
    void attachImages(files)
  }

  /**
   * 执行一条 `/` 命令。
   *
   * 命令由**渲染层直接执行**，不发请求、不花 token —— 这是它与 Skills
   * 最本质的区别（Skills 是给模型读的，见 slash-commands.ts 的头注释）。
   *
   * 统一的收尾：清输入框、关浮层。放这里而不是各分支里，是因为
   * 漏掉一处的表现是「打完命令它还在输入框里留着」，看着像没执行。
   */
  const runSlashCommand = async (command: SlashCommand): Promise<void> => {
    setInput('')
    setSlashOpen(false)
    setSlashStart(-1)
    setSlashQuery('')
    setAtIndex(0)

    switch (command.id) {
      case 'compact': {
        await compactNow()
        return
      }
      case 'new': {
        /*
         * 走父组件给的 onNewSession，而不是自己调 startNewSession()。
         *
         * 那个回调还负责「切回对话视图」等导航动作 —— 自己调 store
         * 的话，在设置页里打 /new 就会「会话换了但人还在设置页」。
         */
        onNewSession()
        return
      }
      case 'clear': {
        const choice = await askConfirm({
          title: '清空当前对话？',
          lines: ['这会删掉当前对话里的全部消息（只影响这一条会话，不影响其他会话）。'],
          actions: [
            { id: 'no', label: '取消', kind: 'ghost' },
            { id: 'yes', label: '清空', kind: 'danger' }
          ],
          tone: 'danger'
        })
        if (choice !== 'yes') return
        /*
         * 只清渲染层与 store 的消息，**不调 startNewSession**：
         * 学生说的是「清空试试别的」，不是「开一条新会话」。
         * 保留 sessionId 的话，落盘会覆盖掉同一条记录 —— 这正是预期。
         */
        updateItems([])
        useAppStore.getState().setSessionMessages([])
        return
      }
      case 'help': {
        // 当成一条本地消息显示，不走模型
        appendLocalNotice(slashCommandHelp())
        return
      }
      default:
        return
    }
  }

  /**
   * 压缩上下文（`/compact`）。
   *
   * 与自动压缩的区别：用户说了就压、不等阈值，并且**当场给出结论**。
   * 之所以要把结果写回 items 与 store，是同一个理由 ——
   * 渲染层才是历史的持有者，不回写的话下一轮又会把完整历史发出去。
   */
  const compactNow = async (): Promise<void> => {
    /*
     * 带上已有的 system（上一次压缩的摘要）一起发。
     *
     * 不带的话，主进程看到的是「没有摘要的历史」，会**再总结一次**
     * 已经总结过的内容 —— 既重复花钱，又可能把上一版摘要里
     * 独有的信息（更早的对话）彻底丢掉。
     */
    const history = itemsRef.current.filter((it) => isConversationRole(it.role))
    if (history.length === 0) {
      appendLocalNotice('当前对话还是空的，没什么可压缩的。')
      return
    }
    if (busy) {
      appendLocalNotice('正在生成回答，等这一轮结束再压缩。')
      return
    }

    /*
     * 把历史整份发过去（含可能已存在的摘要那条 system）。
     *
     * 不再固定插一条空的 system 占位：历史里可能已经有摘要了，
     * 再插一条会变成「两个 system」，而 splitForCompaction 只把
     * 第一个当 system —— 另一条会被当成普通内容参与总结，很乱。
     * 主进程那边本来就会按需补/覆盖 system prompt。
     */
    const payload: ChatMessage[] = history.map((it) => ({
      role: it.role as 'user' | 'assistant' | 'system',
      content: it.text
    }))

    setCompacting(true)
    try {
      const result = await window.api.aiCompact(payload, useAppStore.getState().sessionId)
      if (!result.ok || !result.notice) {
        appendLocalNotice(result.message || '压缩失败。')
        return
      }
      applyCompaction(result.notice)
      appendLocalNotice(result.message)
    } catch (err) {
      appendLocalNotice(`压缩失败：${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setCompacting(false)
    }
  }

  /**
   * 把主进程给出的压缩结果落到本地历史。
   *
   * 两处都要改，少一处就会「下一轮又变回完整历史」：
   *   1. `items`（界面与发送来源）
   *   2. `store.messages`（落盘与会话恢复）
   *
   * `keptCount` 用主进程给的值而不是自己再数一遍「最近几轮」：
   * 两处各写一份判定迟早跑偏，而跑偏要么浪费、要么把模型
   * 正在用的那几轮也丢掉。详见 CompactionNotice 的注释。
   */
  const applyCompaction = (notice: CompactionNotice): void => {
    const list = itemsRef.current
    // 从末尾取主进程保留的那些（它们与主进程手里的那一份逐条对应）
    const kept = list.slice(Math.max(0, list.length - notice.keptCount))
    const summaryItem: ChatItem = {
      id: `sum-${Date.now()}`,
      role: 'system',
      text: `${SUMMARY_MARKER}\n${notice.summary}`
    }
    const next = [summaryItem, ...kept]
    updateItems(next)
    syncFromItems(next)
  }

  /** 往对话里插一条纯本地的提示（不发给模型、不落盘成对话内容） */
  const appendLocalNotice = (text: string): void => {
    updateItems((prev) => [
      ...prev,
      {
        // role 用 notice 而不是 system：system 现在被压缩摘要占用，
        // 而摘要是要落盘、要发给模型的；本地提示两样都不能做。
        // 混用会让「/help 的输出」被当成历史发给模型，还会写进会话文件。
        id: `sys-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        role: 'notice',
        text
      }
    ])
  }

  const send = async (raw?: string): Promise<void> => {
    const typed = (raw ?? input).trim()

    /*
     * `/` 命令拦截。
     *
     * 放在最前面（早于 busy 与空内容判定）：`/help`、`/clear` 这类
     * 命令不依赖「能发消息」，而且 `/clear` 恰恰要在有内容时用。
     *
     * 判定是严格的（见 parseSlashCommand）：`/compact 帮我看看` 里的
     * 斜杠只是普通字符，那种情况要当成正常消息发出去。
     */
    const slash = parseSlashCommand(typed)
    if (slash) {
      if (slash.command.disabledWhileBusy && (busy || compacting)) {
        appendLocalNotice('正在忙，等这一轮结束再执行命令。')
        return
      }
      await runSlashCommand(slash.command)
      return
    }

    // 只挂了引用文件 / 只贴了图、一句话没写，也应该能发 ——
    // 学生的意图就是「看看这个文件」或「看看这张图」
    if ((!typed && refs.length === 0 && images.length === 0) || busy || imageBusy) return
    // 正在读历史会话时就别发了：读回来的结果会把刚发出去的这条冲掉
    if (sessionLoading) return

    const requestId = `req-${Date.now()}`
    requestRef.current = requestId

    // 引用只附**路径清单**（不读正文，见 buildReferenceBlock 的注释）
    const attached = buildReferenceBlock(refs)
    const text = typed || '请看这几个文件'
    const fullText = attached ? `${text}\n\n${attached}` : text

    // 图片随这一轮发出去。文本里加一行占位说明，
    // 否则回看历史时只有「请看这张图」而看不到图，会以为消息发丢了
    const sentImages = images
    const withImageNote = sentImages.length
      ? `${fullText}\n\n（附 ${sentImages.length} 张图片）`
      : fullText

    const userItem: ChatItem = { id: `u-${Date.now()}`, role: 'user', text: withImageNote }
    const aiItem: ChatItem = { id: requestId, role: 'assistant', text: '', streaming: true }

    /*
     * 发出去的历史要**带上压缩摘要**（role === 'system'）。
     *
     * 这正是压缩能持续生效的关键：主进程压完之后，摘要进了 items；
     * 这里若把它过滤掉，下一轮发出去的又变回完整历史 ——
     * 于是每轮都重新总结一次，白花钱且永远压不下去。
     * 判定收在 isConversationRole，别在这里再写一遍。
     */
    const history = [...items, userItem].filter((it) => isConversationRole(it.role))
    updateItems((prev) => [...prev, userItem, aiItem])
    setInput('')
    setRefs([])
    setImages([])
    setBusy(true)

    // 记一条会话索引。放在发送时而不是流结束时：
    // 学生中途点「停止」也是一个有效会话，不该从列表里消失
    const store = useAppStore.getState()
    void store.recordSession(text, history.length)
    // 同步落盘。aiItem 此时是空串，但回答结束后会通过 syncStore 补上
    store.setSessionMessages(
      history.map((it) => ({
        role: it.role as 'user' | 'assistant' | 'system',
        text: it.text,
        at: new Date().toISOString()
      }))
    )

    /*
     * 历史上的消息只发文本，**只有最后这一轮带图**。
     *
     * 图片的 base64 有几 MB，每轮都重发的话：token 消耗爆炸（同一张图
     * 被计费十几次），而且实测部分中转站会因为请求体过大直接 413。
     * 需要模型回看之前的图时，让学生重新贴一次 —— 这比每轮烧几 MB 划算。
     *
     * `system` 也原样带上：那是压缩摘要（如果有）。主进程会把它
     * 当作历史的一部分，只覆盖**第一条** system 为真正的系统提示词。
     */
    const historyMessages: ChatMessage[] = history.map((it) => ({
      role: it.role as 'user' | 'assistant' | 'system',
      content: it.text
    }))
    if (sentImages.length > 0 && historyMessages.length > 0) {
      // 最后一条就是刚加进去的 userItem，把它换成多模态内容块
      historyMessages[historyMessages.length - 1] = {
        role: 'user',
        content: withImages(withImageNote, sentImages) as ChatContentBlock[]
      }
    }
    /*
     * 这里的 system 消息只是一个**占位**，内容由主进程覆盖。
     *
     * 真正的 system prompt 是 userData/系统.md —— 由主进程按当前设置组装
     * （身份 + 默认提示词 + 习惯 + 本机环境探测结果）。渲染层拿不到环境
     * 探测结果，也不该知道 系统.md 的存在，所以这里发一个空壳，
     * 让主进程有个位置可放。
     *
     * 不再是 config.ai.systemPrompt：那只是 系统.md 里的一段，
     * 发过来只会被丢掉，留着反而容易让人误以为「这里改了就生效」。
     *
     * ⚠️ 占位 system 只在**历史里还没有摘要**时插。
     * 历史里已经有压缩摘要（也是 system）时再插一条，就会出现
     * **两个 system**：主进程只覆盖第一个，摘要反而落在后面 ——
     * 位置不对，模型会把它当成「正在进行的系统指令」，语义就错了。
     */
    const messages: ChatMessage[] = historyMessages.some((m) => m.role === 'system')
      ? historyMessages
      : [{ role: 'system', content: '' }, ...historyMessages]

    /*
     * 带上会话 id。
     *
     * 主进程用它判断「是不是一次新会话」—— 新会话才重新校验
     * userData/系统.md（覆盖手改、让设置改动生效），同一会话内复用快照
     * 以保证前后一致。上面的 recordSession 已经跑过，所以这里必然有值。
     */
    /*
     * ⚠️ 必须 try/finally 收尾。
     *
     * 主进程 handler 若抛出（比如准备阶段的某一步异常），这里的 await 会 reject；
     * 没有 finally 的话 setBusy(false) 不执行 —— 发送键**永久停在「停止生成」**，
     * 既发不出新消息、也停不下来，只能刷新页面。
     *
     * 正常结束与出错都要做同一件事：清 busy、把已经拿到的内容落库。
     * 所以放 finally，而不是在两个分支里各写一遍。
     */
    try {
      await window.api.aiChat(requestId, messages, useAppStore.getState().sessionId)
    } catch (err) {
      /*
       * 记一条可读日志。正常情况下主进程会把错误作为 error 事件发过来
       * （那条路已在流处理里显示），走到这里说明是主进程自己在更早的阶段挂了。
       */
      useAppStore.getState().pushLog({
        time: '',
        level: 'error',
        scope: 'ai',
        text: `本次请求异常结束：${err instanceof Error ? err.message : String(err)}`
      })
    } finally {
      setBusy(false)
      // 回答结束（或异常结束），把带已生成内容的 items 一次性写回 store。
      // 带上还在缓冲区里的尾段：那有可能是整段回答的最后一句
      syncStore(flushDelta())
      /*
       * ⚠️ 必须清掉 requestRef，否则「删除当前会话」不会清空气泡。
       *
       * 下面那个 `[sessionId]` 的 effect 是靠 requestRef 判断
       * 「有没有在飞的请求」的：有就直接 return（避免把正在生成的回答
       * 用磁盘上的旧版本覆盖掉）。而这一轮结束后如果不清，
       * requestRef 会一直留着上次的 id —— 于是那个 effect **永远早退**，
       * 切会话/删会话都不会重建 items。
       *
       * 用户报的「在历史里删除当前会话，内容没清空」就是这个：
       * store 里 messages 已经清了，但界面上那堆气泡还在。
       */
      requestRef.current = ''
    }
  }

  /**
   * 删除一条消息。
   *
   * 删的是**展示态与持久化态两份**（items 与 store.messages）——
   * 只删 items 的话，下次切会话回来它又出现了（因为 messages 里还在）。
   *
   * 不做二次确认：消息删错了重新问一次就行，而 confirm 弹窗
   * 在「连续清几条」时会变得很烦。这和删文件的性质不同 ——
   * 那个是不可逆的，这个只是聊天记录。
   */
  const deleteMessage = (target: ChatItem): void => {
    updateItems((prev) => {
      const next = prev.filter((it) => it.id !== target.id)
      syncFromItems(next)
      return next
    })
  }

  /**
   * 修改一条提问。
   *
   * 把原文放回输入框并**删掉这条及其之后的所有消息** ——
   * 因为后续回答都是基于原来那句话的，留着它们会前后矛盾。
   * 这也是主流对话产品的做法（改了就分叉，不保留旧分支）。
   */
  const editMessage = (target: ChatItem): void => {
    if (busy) return
    updateItems((prev) => {
      const idx = prev.findIndex((it) => it.id === target.id)
      if (idx < 0) return prev
      const next = prev.slice(0, idx)
      syncFromItems(next)
      return next
    })
    setInput(target.text)
    inputRef.current?.focus()
  }

  /**
   * 重试一条回答。
   *
   * 同样要**删掉这条及其之后的**，再拿它前面那条用户提问重发。
   * 只重发不删的话，同一轮会出现两个回答，而模型下一轮会看到
   * 「自己说过两遍」，上下文就脏了。
   */
  const retryMessage = (target: ChatItem): void => {
    if (busy) return
    const list = items
    const idx = list.findIndex((it) => it.id === target.id)
    if (idx < 0) return
    // 往前找最近的一条用户提问
    let askIndex = -1
    for (let i = idx - 1; i >= 0; i--) {
      if (list[i].role === 'user') {
        askIndex = i
        break
      }
    }
    if (askIndex < 0) return
    const question = list[askIndex].text

    updateItems((prev) => {
      const next = prev.slice(0, askIndex)
      syncFromItems(next)
      return next
    })
    // 下一帧再发：setItems 是异步的，立刻 send 会读到旧的 items
    window.setTimeout(() => void send(question), 0)
  }

  const stop = async (): Promise<void> => {
    if (requestRef.current) await window.api.aiAbort(requestRef.current)
    setBusy(false)
    /*
     * 立刻把气泡的 streaming 清掉。
     *
     * 主进程在中断时**会**发一个 done（见 ipc/ai.ts），正常路径下
     * 这一句是冗余的；但不能只依赖它：网络异常、主进程卡住、
     * 或 abort 期间进程正好退出时，done 可能永远到不了，
     * 那时界面就会一直转圈 —— 而这个兜底是本地同步生效的，
     * 用户按了停止就一定看得到停下来。
     */
    updateItems((prev) => prev.map((it) => (it.streaming ? { ...it, streaming: false } : it)))
    // 主动停止时也要存一次：学生按停止往往正是因为回答已经够用了。
    // 同样要把缓冲区的尾段带上，否则停止时最后几个字会丢
    syncStore(flushDelta())
  }

  /**
   * 引用胶囊的三个动作。
   *
   * 提出来是因为引用行要在**两个位置**渲染（输入框上方与工具条下方），
   * 原先两处的 JSX 是逐字复制的一份 —— 改一处忘另一处，
   * 就会出现「上面的胶囊能删、下面的删不掉」这种诡异现象。
   * 现在两处共用同一个 <RefRow> 组件。
   */
  const removeRef = (file: string): void => setRefs((prev) => prev.filter((f) => f !== file))
  const clearRefs = (): void => setRefs([])

  /**
   * 从文件树挂一个引用进输入框。
   *
   * 本质上就是让 store 把路径放进 pendingRefs，剩下的由下面的 useEffect 接管 ——
   * 和右键「插入引用」走的是同一条路，不另开一套逻辑。
   */
  const pickReference = async (): Promise<void> => {
    const selected = useAppStore.getState().selectedPath
    if (!selected) {
      // 文件树里没选中任何东西。这里不弹文件选择框 ——
      // 主进程的 openWorkspace 是给「选文件夹」用的，选单个文件得另开一个通道，
      // 而右侧文件树本来就能完成这件事，引导学生去那里点更省事。
      // 同上：通知类信息走日志，不用会阻塞渲染进程的原生弹窗
      useAppStore.getState().pushLog({
        time: '',
        level: 'info',
        scope: 'ai',
        text: '请先在右侧文件树里点选一个文件，再点这里引用。也可以直接在文件上右键「插入引用」。'
      })
      return
    }
    useAppStore.getState().insertReference(selected)
    inputRef.current?.focus()
  }

  /**
   * 候选文件的过滤结果。
   *
   * 打分排序而不是简单 includes：输入 `app` 时，`app.tsx` 应当排在
   * `src/components/apply-helpers.tsx` 前面 —— 否则最常见的那种
   * 「想引用根目录同名文件」会被一长串深层路径淹掉。
   * 规则（越靠前越优先）：文件名完全相等 > 文件名以它开头 > 文件名包含它 >
   * 路径包含它。同档内按路径长度升序（短路径通常更可能是目标）。
   */
  const atMatches = (() => {
    if (!atOpen) return []
    const q = atQuery.trim().toLowerCase()
    if (!q) return fileList.slice(0, 30)
    const scored: Array<{ path: string; score: number }> = []
    for (const path of fileList) {
      const lower = path.toLowerCase()
      const name = (lower.split('/').pop() || lower).replace(/\.[^.]+$/, '')
      let score = -1
      if (name === q) score = 0
      else if (name.startsWith(q)) score = 1
      else if (name.includes(q)) score = 2
      else if (lower.includes(q)) score = 3
      if (score >= 0) scored.push({ path, score })
    }
    scored.sort((a, b) => a.score - b.score || a.path.length - b.path.length)
    return scored.slice(0, 30).map((s) => s.path)
  })()

  /** 当前该显示哪些命令（按已输入的前缀过滤） */
  const slashMatches = slashOpen ? matchSlashCommands(slashQuery) : []

  /**
   * 输入框内容变化时维护 `@` 的状态。
   *
   * 判定「光标前最近一个 @」而不是「整段里有没有 @」：一句话里可能先写
   * 邮箱地址再引用文件，用后者会把邮箱里的 @ 也当成触发点。
   * 触发条件还要求 @ 前面是行首或空白 —— `foo@bar` 这种不该弹列表。
   */
  const onInputChange = (value: string, caret: number): void => {
    setInput(value)
    maintainSlash(value, caret)
    const before = value.slice(0, caret)
    const at = before.lastIndexOf('@')
    if (at < 0 || (at > 0 && !/\s/.test(before[at - 1]))) {
      setAtOpen(false)
      setAtStart(-1)
      return
    }
    const query = before.slice(at + 1)
    // 过滤词里不该有空白或换行：出现就说明这个 @ 已经写完了（比如「@a.txt 帮我看看」）
    if (/[\s\n]/.test(query)) {
      setAtOpen(false)
      setAtStart(-1)
      return
    }
    /*
     * `/` 与 `@` 互斥。
     *
     * 光标前同时有 `/` 和 `@` 时（比如 `/compact @a.txt`），
     * 该弹的是**后敲的那个**。这里以「谁的下标更靠后」为准。
     */
    if (atOpen && slashStart > at) return
    setAtStart(at)
    setAtQuery(query)
    setAtIndex(0)
    setAtOpen(true)
    // 第一次触发时才拉清单，见 fileList 的注释
    if (fileList.length === 0) void loadFiles()
  }

  /** 维护 `/` 命令浮层的开合（与 onInputChange 里的 @ 判定同一套思路） */
  const maintainSlash = (value: string, caret: number): void => {
    const parsed = parseSlashQuery(value, caret)
    if (!parsed) {
      setSlashOpen(false)
      setSlashStart(-1)
      return
    }
    // 与 @ 互斥：@ 更靠后时归 @
    const before = value.slice(0, caret)
    const at = before.lastIndexOf('@')
    if (at > parsed.start && (at === 0 || /\s/.test(before[at - 1]))) {
      setSlashOpen(false)
      setSlashStart(-1)
      return
    }
    setSlashStart(parsed.start)
    setSlashQuery(parsed.query)
    setSlashIndex(0)
    setSlashOpen(true)
  }

  /**
   * 选中一个候选：把输入框里的 `@过滤词` 换成 `@相对路径` 并挂成引用胶囊。
   *
   * 挂胶囊而不是把路径留在文本里：路径留在正文里学生想删掉得手动选中
   * 一大段，而胶囊点一下 × 就没了 —— 与文件树右键「插入引用」是同一套体验。
   * 文本里补一个 `@路径` 只是让输入框读起来完整（也是学生自己敲的东西）。
   */
  const chooseAtFile = (relPath: string): void => {
    const absolute = workspace ? `${workspace}/${relPath}`.replace(/\\/g, '/') : relPath
    if (atStart >= 0) {
      const caret = inputRef.current?.selectionStart ?? input.length
      const next = `${input.slice(0, atStart)}@${relPath} ${input.slice(caret)}`
      setInput(next)
    }
    useAppStore.getState().insertReference(absolute)
    setAtOpen(false)
    setAtStart(-1)
    setAtQuery('')
    inputRef.current?.focus()
  }

  return (
    <>
    <section className="chat">
      {/*
        面板抬头：左侧「新对话」按钮，中间当前会话标题。

        会话历史（那个带条数的下拉）**已移到顶栏**：
        它和「打开文件夹」一样是「换一个地方干活」，属于全局导航；
        而「新对话」是紧贴当前这轮对话的动作，留在对话区更顺手。
      */}
      <div className="chat-head">
        <button
          className="chat-head-btn"
          aria-label="新对话"
          title="开始一段新对话（Ctrl+N）"
          onClick={onNewSession}
        >
          <PlusIcon />
          <span>新对话</span>
        </button>

        <span className="chat-head-title" title={workspace || '未打开项目'}>
          {sessions.find((s) => s.id === sessionId)?.title || '新对话'}
        </span>

      </div>

      <div className="chat-scroll" ref={scrollRef}>
        <div className="chat-inner">
          {/*
            越界授权卡片。
            放在消息流最前面（顶部）而不是底部：它要求用户做决定，
            应该显眼；而且在底部会被输入框与工具条压住。
          */}
          {approvals.map((req) => (
            <div key={req.id} className="approval-card">
              <div className="approval-head">
                <ShieldIcon />
                <span>AI 想访问当前项目之外的位置</span>
              </div>
              <div className="approval-action">{req.action}</div>
              <div className="approval-path" title={req.target}>
                {req.target}
              </div>
              <div className="approval-actions">
                <button className="primary" onClick={() => void answerApproval(req, 'once')}>
                  只允许这一次
                </button>
                <button className="ghost" onClick={() => void answerApproval(req, 'dir')}>
                  允许此目录
                </button>
                <button className="ghost danger" onClick={() => void answerApproval(req, 'deny')}>
                  拒绝
                </button>
              </div>
              <div className="hint">
                「允许此目录」之后本次运行为止都不再问这个目录。
                拒绝后 AI 会收到说明，它不会重试同一个路径。
              </div>
            </div>
          ))}

          {/*
            计划模式的「开始执行」。
            只在计划模式、且已有对话内容时出现 —— 空会话里没什么可执行的。
          */}
          {permissionMode === 'plan' && items.length > 0 && (
            <div className={`plan-bar${executing ? ' is-executing' : ''}`}>
              <div className="plan-bar-text">
                {executing
                  ? '已批准执行：AI 现在可以修改文件了'
                  : '计划模式：AI 只能查看。看过它的方案后，点右边开始执行。'}
              </div>
              {!executing && (
                <button
                  className="primary"
                  onClick={() => {
                    setExecuting(true)
                    void window.api.startExecuting(sessionId)
                  }}
                >
                  开始执行
                </button>
              )}
            </div>
          )}

          {items.length === 0 ? (
            <div className="welcome">
              {/* 用真 logo 而不是手绘的火箭 svg —— 界面上只该有一种火箭 */}
              <img className="welcome-badge" src="./logo.png" alt="" />
              <h1>{greeting()}，今天想从哪里开始？</h1>

              {(!workspace || !configured) && (
                <div className="welcome-actions">
                  <p className="welcome-lead">
                    把代码或报错贴进来。我先说它在做什么，再指出问题，最后给出能直接运行的改法。
                  </p>
                  {!workspace ? (
                    <button className="primary" onClick={() => void openWorkspace()}>
                      先选择一个项目文件夹
                    </button>
                  ) : (
                    <button className="primary" onClick={onOpenSettings}>
                      先去设置里配置模型
                    </button>
                  )}
                </div>
              )}
            </div>
          ) : (
            items.map((it) => (
              <MessageBubble
                key={it.id}
                item={it}
                onRetry={retryMessage}
                onEdit={editMessage}
                onDelete={deleteMessage}
              />
            ))
          )}
        </div>
      </div>

      <div className="composer glass">
        {images.length > 0 && (
          <div className="ref-row img-row">
            {images.map((img, index) => (
              <span key={index} className="img-chip" title={`${img.name}（${humanBytes(img.bytes)}）`}>
                <img src={img.dataUrl} alt={img.name} />
                <button
                  className="ref-chip-x"
                  aria-label={`移除图片 ${img.name}`}
                  onClick={() => setImages((prev) => prev.filter((_, i) => i !== index))}
                >
                  ×
                </button>
              </span>
            ))}
            <span className="img-note muted">
              共 {humanBytes(images.reduce((sum, img) => sum + img.bytes, 0))}
            </span>
            <button className="ref-clear" onClick={() => setImages([])}>
              清空图片
            </button>
          </div>
        )}
        <RefRow refs={refs} onOpen={(file) => void openFile(file)} onRemove={removeRef} onClear={clearRefs} />
        <textarea
          ref={inputRef}
          /*
           * 展开态 6 行、常态 1 行。
           * 用 rows 而不是 CSS 高度：textarea 的滚动与自动增高都由 rows 决定，
           * 用 CSS 改高度会让它在内容超过时出现双重滚动条。
           */
          rows={expanded ? 6 : 1}
          placeholder={
            visionOn
              ? '输入消息，可直接粘贴截图（Ctrl+V）…'
              : '输入消息，@ 引用文件，/ 命令，提示词可队列发送…'
          }
          value={input}
          onPaste={onPaste}
          onChange={(e) => onInputChange(e.target.value, e.target.selectionStart ?? e.target.value.length)}
          onKeyDown={(e) => {
            /*
             * `/` 命令浮层优先于 @ —— 两者互斥（见 maintainSlash），
             * 同时打开只可能是状态没清干净，那时以命令为准更安全：
             * 命令是「执行动作」，误选一个文件只是插个路径，误执行命令
             * 可能把对话清掉。
             *
             * Esc 的判定单独放在最前面，理由与 @ 那段注释完全一样：
             * 一个都不匹配时（比如 /zzz）列表仍开着但为空，
             * 那时恰恰最需要 Esc 关掉它。
             */
            if (slashOpen && e.key === 'Escape') {
              e.preventDefault()
              setSlashOpen(false)
              return
            }
            if (slashOpen && slashMatches.length > 0) {
              if (e.key === 'ArrowDown') {
                e.preventDefault()
                setSlashIndex((i) => (i + 1) % slashMatches.length)
                return
              }
              if (e.key === 'ArrowUp') {
                e.preventDefault()
                setSlashIndex((i) => (i - 1 + slashMatches.length) % slashMatches.length)
                return
              }
              if (e.key === 'Enter' && !e.ctrlKey && !e.metaKey) {
                e.preventDefault()
                void runSlashCommand(slashMatches[Math.min(slashIndex, slashMatches.length - 1)])
                return
              }
            }
            /*
             * @ 候选列表打开时，↑↓ / 回车 / Esc 归它用 ——
             * 尤其是回车：平时回车是换行，这里必须是「选中这个文件」，
             * 否则学生敲完过滤词一按回车，选中的却是换行。
             *
             * ⚠️ Esc 的判定**不能**和 ↑↓/回车 挤在同一个
             * `atMatches.length > 0` 分支里：一个过滤词谁都不匹配时
             * （比如 @zzz），列表仍开着但为空，那时恰恰最需要 Esc 关掉它。
             * 这条是自检抓出来的 —— 原来的写法会让空列表关不掉，
             * 浮层一直挡着输入框。
             */
            if (atOpen && e.key === 'Escape') {
              e.preventDefault()
              setAtOpen(false)
              return
            }
            if (atOpen && atMatches.length > 0) {
              if (e.key === 'ArrowDown') {
                e.preventDefault()
                setAtIndex((i) => (i + 1) % atMatches.length)
                return
              }
              if (e.key === 'ArrowUp') {
                e.preventDefault()
                setAtIndex((i) => (i - 1 + atMatches.length) % atMatches.length)
                return
              }
              if (e.key === 'Enter' && !e.ctrlKey && !e.metaKey) {
                e.preventDefault()
                chooseAtFile(atMatches[Math.min(atIndex, atMatches.length - 1)])
                return
              }
            }
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
              e.preventDefault()
              void send()
            }
          }}
        />

        {/*
          `/` 命令浮层。
          与 @ 浮层同一套交互（下方弹出、onMouseDown 防失焦），
          但选中即**执行**，不像 @ 那样往输入框里填内容。
        */}
        {slashOpen && (
          <div className="slash-pop">
            {slashMatches.length === 0 ? (
              <div className="at-empty">没有匹配 /{slashQuery} 的命令</div>
            ) : (
              slashMatches.map((cmd, i) => {
                const unavailable =
                  (cmd.disabledWhileBusy && (busy || compacting)) ||
                  (cmd.needsHistory && items.length === 0)
                return (
                  <button
                    key={cmd.id}
                    className={`slash-item${i === slashIndex ? ' active' : ''}${unavailable ? ' is-disabled' : ''}`}
                    disabled={unavailable}
                    title={unavailable ? '当前还用不了' : cmd.detail}
                    onMouseDown={(e) => {
                      e.preventDefault()
                      void runSlashCommand(cmd)
                    }}
                    onMouseEnter={() => setSlashIndex(i)}
                  >
                    <span className="slash-name">/{cmd.name}</span>
                    <span className="slash-detail">{cmd.detail}</span>
                  </button>
                )
              })
            )}
          </div>
        )}

        {/*
          @ 候选浮层。放在输入框**下方**：输入框贴底，上方空间要留给消息。
          用 onMouseDown + preventDefault 而不是 onClick —— 后者会先让
          textarea 失焦，而我们需要 caret 位置来替换掉刚敲的过滤词。
        */}
        {atOpen && (
          <div className="at-pop">
            {atMatches.length === 0 ? (
              <div className="at-empty">
                {fileList.length === 0
                  ? workspace
                    ? '正在读取文件列表…'
                    : '还没有打开项目，先打开一个文件夹'
                  : `没有匹配 @${atQuery} 的文件`}
              </div>
            ) : (
              atMatches.map((path, i) => (
                <button
                  key={path}
                  className={`at-item${i === atIndex ? ' active' : ''}`}
                  title={path}
                  onMouseDown={(e) => {
                    e.preventDefault()
                    chooseAtFile(path)
                  }}
                  onMouseEnter={() => setAtIndex(i)}
                >
                  <span className="at-name">{path.split('/').pop()}</span>
                  <span className="at-dir">{path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : ''}</span>
                </button>
              ))
            )}
          </div>
        )}

        {/*
          底部工具条。左边是几种「贴东西进来」的入口，右边是发送。
          图片 / 文件 / 截图 / 配色 / Git 这几个在截图里都有，
          但当前版本只有「引用文件」是真的通的，其余置灰并给出说明 ——
          点了没反应比明确告诉学生「还没做」更让人困惑。
        */}
        {/*
          隐藏的文件选择器。用 input[type=file] 而不是 Electron 的
          系统对话框：前者在渲染层直接拿到 File 对象（能立刻 canvas 压缩），
          后者要经主进程传路径再读回来，多一次 IPC 与一次全量读盘。
        */}
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          multiple
          style={{ display: 'none' }}
          onChange={(e) => {
            const files = Array.from(e.target.files || [])
            // 清空 value：不清的话连续选同一张图不会再触发 change
            e.target.value = ''
            void attachImages(files)
          }}
        />

        {/*
          底部工具条。
          **只留真的能用的入口** —— 以前这里有「截图 / 配色 / Git 仓库」三个
          永远置灰的图标，占着位置却只能告诉学生「还没做」。
          一排灰按钮不会让人觉得「以后会有」，只会让人觉得这软件没做完。
        */}
        <div className="composer-bar">
          <ComposerTool
            label="引用文件"
            hint="从左侧文件树右键「插入引用」，或点这里选一个文件"
            onClick={() => void pickReference()}
          >
            <PaperclipIcon />
          </ComposerTool>
          <ComposerTool
            label="图片"
            hint={
              visionOn
                ? '选一张图片，或直接在输入框里 Ctrl+V 粘贴截图'
                : '当前模型未开启图片支持（设置 → AI 模型里可打开）'
            }
            onClick={visionOn ? () => fileInputRef.current?.click() : undefined}
          >
            <AtIcon />
          </ComposerTool>

          {/* 展开输入框：写长提示词时用，点击在单行与 5 行间切换 */}
          <ComposerTool
            label={expanded ? '收起输入框' : '展开输入框'}
            hint={expanded ? '收起输入框' : '展开输入框（写长提示词时用）'}
            onClick={() => setExpanded((v) => !v)}
          >
            <ExpandIcon expanded={expanded} />
          </ComposerTool>

          <span className="spacer" />

          {imageBusy && <span className="muted img-note">正在压缩图片…</span>}

          {/*
            权限模式 + 模型选择，放在**输入框的工具条**里。
            这两个都决定「AI 接下来会怎么干活」，属于下指令前会看一眼的东西，
            所以贴着输入框最顺手 —— 放到编辑器那一侧会让动作和视线都断开。

            顺序：模式在前。它决定 AI 能不能动手，比换哪个模型更要紧，
            而且颜色会变（计划=蓝、完全允许=红），靠左更容易被注意到。
          */}
          <Select
            value={permissionMode}
            options={MODE_OPTIONS}
            onChange={(v) => void chooseMode(v)}
            ariaLabel="权限模式"
            className={`mode-picker mode-${permissionMode}`}
          />

          {models.length > 0 ? (
            <Select
              value={config?.ai.model || ''}
              options={[
                // 当前模型不在列表里（手填的）也要列出来，否则下拉会显示空
                ...(config?.ai.model && !models.includes(config.ai.model)
                  ? [{ value: config.ai.model, label: config.ai.model, hint: '当前使用的模型' }]
                  : []),
                ...models.map((m) => ({ value: m, label: m, hint: '点击切换到该模型' }))
              ]}
              onChange={(v) => void chooseModel(v)}
              ariaLabel="选择模型"
              title="切换当前对话使用的模型"
              className="model-picker"
            />
          ) : (
            <button
              type="button"
              className="ui-select model-picker is-static"
              aria-label="选择模型"
              title={
                !configured
                  ? '还没配置模型 —— 点击去设置里填写'
                  : modelError
                    ? `拉取模型列表失败：${modelError}（去设置 → AI 模型 里手填）`
                    : modelBusy
                      ? '正在读取模型列表…'
                      : '点这里从服务端拉取模型列表'
              }
              /*
               * 没配模型时**点它直接去设置页**。
               *
               * 原来这里是 `undefined`（什么都不做）—— 那是最差的处理：
               * 用户看到「未配置模型」点下去毫无反应，只会以为是坏的。
               * 按钮上已经写着「未配置模型」，点它的意图必然是「去配」，
               * 直接把人送过去比让他自己找设置入口好。
               */
              onClick={() => (configured ? void loadModels() : onOpenSettings())}
            >
              <span className="ui-select-label">
                {modelBusy ? '读取中…' : config?.ai.model || '未配置模型'}
              </span>
            </button>
          )}

          {/*
            发送键与停止键是**同一个按钮**，靠图标切换。
            以前是两个并排的按钮，问题在于「停止」只在生成时出现 ——
            它一出现就把发送键挤走，而学生这时候眼睛盯着输入框，
            很容易点错。合成一个之后位置永远不变，图标状态即语义。
          */}
          <button
            className={`send-btn${busy ? ' is-stop' : ''}`}
            aria-label={busy ? '停止生成' : '发送'}
            title={busy ? '停止生成' : '发送（Ctrl + Enter）'}
            disabled={
              busy
                ? false
                : !configured ||
                  imageBusy ||
                  (!input.trim() && refs.length === 0 && images.length === 0)
            }
            onClick={() => (busy ? void stop() : void send())}
          >
            {busy ? <StopIcon /> : <SendIcon />}
          </button>
        </div>
      </div>
    </section>

    {/*
      「完全允许」的二次确认。
      放在这里（而不是塞进 .chat 内部）是因为它是覆盖层：
      .overlay 是 position:fixed，与 .chat 的 flex 布局无关。
      已确认过祖先里没有 transform / filter / backdrop-filter ——
      那类属性会创建新的包含块，让 fixed 变成相对它定位、弹层就跑偏了。
    */}
    {pendingMode === 'full' && (
      <ConfirmDialog
        title="确认切换到「完全允许」？"
        confirmText="我明白，完全放开"
        danger
        onCancel={() => setPendingMode(null)}
        onConfirm={() => {
          const target = pendingMode
          setPendingMode(null)
          if (target) void applyMode(target)
        }}
      >
        <p>
          <strong>这个模式下 AI 不再有任何范围限制</strong>
          ，可以读取和修改磁盘上任意位置的文件 ——
          不只是当前项目，也包括你的桌面、文档、甚至系统目录。
        </p>
        <p>
          它不会每次操作都问你，所以一次误操作就可能改坏项目之外的文件，
          而那些改动<strong>无法通过「撤销这次修改」找回</strong>
          （撤销只覆盖工作区内的文件）。
        </p>
        <p>
          日常写代码请用<strong>对话模式</strong>：在当前项目内自由读写，
          需要碰项目外的文件时会单独弹卡片问你。只在明确知道自己在做什么时
          （比如让 AI 批量重构多个项目）才用完全允许。
        </p>
      </ConfirmDialog>
    )}
    </>
  )
})

export default AiPanel

/**
 * 单条消息气泡。
 *
 * 用 memo 包起来是流式性能的关键一环：
 * 生成回答时 items 会高频变化（合并节流后仍有每秒十几次），
 * 如果不 memo，每次都要重新渲染列表里的**全部历史消息**。
 * 一次对话攒到 20 条，就是每秒几百次无用渲染 ——
 * 而这正是老机器上「AI 一边回答一边界面发涩」的来源。
 *
 * memo 的浅比较在这里够用：只有 text/usage/tools 真的变了的那一条会被重渲。
 */
const MessageBubble = memo(function MessageBubble({
  item,
  onRetry,
  onEdit,
  onDelete
}: {
  item: ChatItem
  onRetry: (item: ChatItem) => void
  onEdit: (item: ChatItem) => void
  onDelete: (item: ChatItem) => void
}): JSX.Element {
  /**
   * 工具调用过程默认**折叠**。
   *
   * 一次回答可能调七八个工具（读文件、搜内容、改文件…），
   * 展开时占掉大半屏，把真正的答案挤到看不见的地方。
   * 学生要的是结论，过程只在「它到底干了什么」时才需要看。
   *
   * 但**正在跑的时候不折叠** —— 那时候过程就是全部内容
   * （还没有答案），折起来会让人以为卡死了。
   */
  const running = item.tools?.some((step) => step.phase === 'start') ?? false
  const [showTools, setShowTools] = useState(false)
  // 从「正在跑」变成「跑完了」时自动收起，把屏幕让给答案
  useEffect(() => {
    if (!running) setShowTools(false)
  }, [running])

  /*
   * 思考过程。
   *
   * 两个来源都归一到这里：
   *   - item.reasoning：上游用独立字段送的（reasoning_content）
   *   - item.text 里带 `thinking` / 孤立 `</think>` 标签的（中转站拼进正文的）
   * 流式期间正文的标签可能还没闭合，splitReasoningStreaming 会把
   * 「末尾半截标签」先扣着不渲染，避免 `</thi` 一闪而过。
   */
  const streamedReasoning = item.reasoning || ''
  const split = item.streaming
    ? splitReasoningStreaming(item.text)
    : { segments: splitReasoning(item.text), pending: '' }
  const inlineReasoning = split.segments
    .filter((seg) => seg.kind === 'reasoning')
    .map((seg) => seg.content)
    .join('')
  const visibleText =
    split.segments
      .filter((seg) => seg.kind === 'text')
      .map((seg) => seg.content)
      .join('') + split.pending
  /*
   * 气泡正文的最后一道清理：去掉无意义的换行。
   *
   * 一次回答由好几轮拼成，每轮正文前后模型都会带换行 ——
   * 于是「每执行一次工具，气泡就多一片空白」，正文被推得越来越远。
   * 规则与理由见 shared/chat-text.ts（只压连续空行，不动行首缩进）。
   *
   * 放在**渲染这一层**而不是写入 items 的那一层：历史消息、流式分片、
   * 重试回填全都经过这里，一处收口就全覆盖了。
   */
  const bubbleText = normalizeChatText(visibleText)
  const reasoningText = streamedReasoning + inlineReasoning
  const [showReasoning, setShowReasoning] = useState(false)

  const toolCount = item.tools?.length ?? 0
  const failed = item.tools?.some((step) => step.phase === 'done' && step.ok === false) ?? false
  const canAct = item.role === 'user' || item.role === 'assistant'

  /*
   * 工具过程的**一行**摘要。
   *
   * 工具调用不该占气泡的地方：一次回答常调七八个工具，
   * 每个占一行会把消息撑得很长，把真正的答案挤出视野。
   * 所以这里永远只显示一行 —— 正在跑时显示「当前这一步在干什么」，
   * 跑完了显示「执行了 N 步」。要看细节自己点开。
   */
  const lastStep = item.tools?.[toolCount - 1]
  const toolSummary = running
    ? lastStep?.summary || `正在执行第 ${toolCount} 步…`
    : `执行了 ${toolCount} 步`

  return (
    <div className={`msg-row ${item.role}`}>
      <div className="msg-col">
        {reasoningText && (
          <div className="think-block">
            <button
              className="think-toggle"
              aria-expanded={showReasoning}
              title={showReasoning ? '收起思考过程' : '展开模型的思考过程'}
              onClick={() => setShowReasoning((v) => !v)}
            >
              <span className={`tool-caret${showReasoning ? ' is-open' : ''}`} aria-hidden="true">
                ▸
              </span>
              <span>{item.streaming && !item.text ? '思考中…' : '思考过程'}</span>
            </button>
            {showReasoning && <div className="think-body">{reasoningText}</div>}
          </div>
        )}
        {toolCount > 0 && (
          <div className="tool-trace">
            <button
              className={`tool-toggle${running ? ' is-running' : ''}`}
              aria-expanded={showTools}
              title={showTools ? '收起执行细节' : '展开执行细节'}
              onClick={() => setShowTools((v) => !v)}
            >
              <span className={`tool-caret${showTools ? ' is-open' : ''}`} aria-hidden="true">
                ▸
              </span>
              {/* 单行摘要：不随工具个数变高 */}
              <span className="tool-summary">{toolSummary}</span>
              {failed && <span className="tool-flag">有失败</span>}
            </button>
            {showTools && (
              <div className="tool-steps">
                {item.tools?.map((step) => (
                  <div
                    key={step.id}
                    className={[
                      'tool-step',
                      step.phase === 'start' ? 'running' : step.ok === false ? 'failed' : 'ok'
                    ].join(' ')}
                  >
                    <span className="tool-mark" />
                    <span className="tool-text">{step.summary}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/*
          气泡只承载**正文**。
          思考过程与工具过程都在上面的折叠块里 —— 它们不该把气泡撑大，
          也不该和答案混在一起（学生要的是结论）。
          正文为空时干脆不渲染气泡，避免留一个空气泡占位。

          判定用 bubbleText（清理过的）而不是 visibleText：
          只吐了几个换行就去调工具的那一轮，清理后是空串 ——
          它不该撑出一片空白。
        */}
        {(bubbleText || (!toolCount && !reasoningText)) && (
          <div className="bubble">
            {bubbleText ? (
              bubbleText
            ) : item.streaming ? (
              // 还在流里但一个字没来：三种点的等待动画
              <span className="dots">
                <i />
                <i />
                <i />
              </span>
            ) : (
              /*
               * 已经不在流里、又没有正文 —— 只可能是用户中途停了、
               * 而这一轮还没吐出任何文字。明确写出来，不要留一个空气泡
               * 或一直转的省略号：那会让人以为还在加载。
               */
              <span className="muted">已停止</span>
            )}
          </div>
        )}
        {item.usage && <div className="usage">{formatUsage(item.usage)}</div>}

        {/*
          消息操作。**悬停才出现** —— 三条按钮常驻会让每条消息都拖着
          一截工具栏，长对话里非常吵。触屏没有 hover，所以用 focus-within
          兜底（键盘 Tab 也能到）。
        */}
        {canAct && (
          <div className="msg-actions">
            {item.role === 'user' && (
              <button className="msg-act" title="修改这条提问后重发" onClick={() => onEdit(item)}>
                修改
              </button>
            )}
            {item.role === 'assistant' && (
              <button className="msg-act" title="用同一个问题重新回答" onClick={() => onRetry(item)}>
                重试
              </button>
            )}
            <button className="msg-act is-danger" title="删除这条消息" onClick={() => onDelete(item)}>
              删除
            </button>
          </div>
        )}
      </div>
    </div>
  )
})

/**
 * 已挂上的引用文件，横排成一行胶囊。
 *
 * 为什么是「输入框上方 + 工具条下方」两个位置都渲染同一个组件：
 * 输入框上面那份在长对话里会被滚出视野，而工具条下面那份始终可见。
 * 两边的内容与行为必须完全一致 —— 所以是同一个组件，不是两份 JSX。
 *
 * 点名字在编辑器里打开、点 × 移除。用 title 放完整路径：
 * 胶囊上只显示文件名（路径太长会把整行挤爆）。
 */
function RefRow({
  refs,
  onOpen,
  onRemove,
  onClear
}: {
  refs: string[]
  onOpen: (file: string) => void
  onRemove: (file: string) => void
  onClear: () => void
}): JSX.Element | null {
  if (refs.length === 0) return null
  return (
    <div className="ref-row">
      {refs.map((file) => (
        <span key={file} className="ref-chip" title={file}>
          <button className="ref-chip-name" title={`在编辑器里打开 ${file}`} onClick={() => onOpen(file)}>
            {baseName(file)}
          </button>
          <button className="ref-chip-x" aria-label={`移除引用 ${file}`} onClick={() => onRemove(file)}>
            ×
          </button>
        </span>
      ))}
      <button className="ref-clear" onClick={onClear}>
        清空引用
      </button>
    </div>
  )
}

/** 加号：新对话 */
function PlusIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true">
      <path
        d="M12 5v14M5 12h14"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  )
}

/** 越界授权：一面盾牌，表示「这里需要你确认」 */
function ShieldIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
      <g fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round">
        <path d="M12 3.2 19.5 6v6c0 4.2-3 7.4-7.5 8.8C7.5 19.4 4.5 16.2 4.5 12V6L12 3.2Z" />
        <path d="M12 8.5v3.2M12 14.6v.1" strokeLinecap="round" />
      </g>
    </svg>
  )
}


/** 展开/收起输入框：双向箭头 */
function ExpandIcon({ expanded }: { expanded: boolean }): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true">
      <g fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
        {expanded ? (
          <>
            <path d="M9 4.5v4.5H4.5M15 19.5V15h4.5" />
            <path d="m4.5 9 5-4.5M19.5 15l-5 4.5" opacity=".55" />
          </>
        ) : (
          <>
            <path d="M4.5 9V4.5H9M19.5 15v4.5H15" />
            <path d="m9 4.5-4.5 5M15 19.5l4.5-5" opacity=".55" />
          </>
        )}
      </g>
    </svg>
  )
}

/** 停止：一个方块。与「发送」的纸飞机形状差得远，一眼能分辨 */
function StopIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true">
      <rect x="7" y="7" width="10" height="10" rx="2" fill="currentColor" />
    </svg>
  )
}

/**
 * 工具条上的一个小按钮。
 *
 * 用原生 title 做提示而不是自己画浮层：这几个按钮的说明都很短，
 * 原生 tooltip 的延迟与位置由系统决定，比自绘的更稳。
 */
function ComposerTool({
  label,
  hint,
  onClick,
  children
}: {
  label: string
  hint: string
  onClick?: () => void
  children: React.ReactNode
}): JSX.Element {
  return (
    <button
      className="composer-tool"
      aria-label={label}
      title={hint}
      disabled={!onClick}
      onClick={onClick}
    >
      {children}
    </button>
  )
}

