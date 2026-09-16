import { forwardRef, memo, useEffect, useImperativeHandle, useRef, useState } from 'react'
import type { AiUsage, ChatContentBlock, ChatMessage } from '@shared/types'
import { compressImage, humanBytes, withImages } from '../image-input'
import { useAppStore } from '../store/useAppStore'
import {
  AtIcon,
  BulbIcon,
  CompassIcon,
  PaperclipIcon,
  SendIcon,
  WrenchIcon
} from './icons'

type Role = 'user' | 'assistant' | 'system' | 'error'

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

/** 单个引用文件最多附这么多字符，防止一个 400KB 的日志把上下文挤爆 */
const REF_CHAR_LIMIT = 8000

/**
 * 流式文本的合并间隔（毫秒）。
 *
 * 约等于两帧。低于 16ms 就接近「每帧都刷」，省不下多少；
 * 高于 50ms 就会看出「一个字一个字蹦」变成「一段一段跳」。
 */
const STREAM_FLUSH_MS = 30

/** 引用胶囊上只显示文件名，完整路径放 title */
function baseName(target: string): string {
  const parts = target.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] || target
}

/**
 * 把引用文件读成「文件路径 + 正文」拼到提问后面。
 *
 * 逐个 try/catch：某个文件读不了（二进制、被占用、超过 4MB）
 * 不应该让整条消息发不出去，只在那一块写一行说明，
 * 既告诉学生「这个没读到」，也让 AI 知道缺失的原因。
 */
async function buildReferenceBlock(files: string[]): Promise<string> {
  if (!files.length) return ''
  const parts: string[] = []
  for (const file of files) {
    try {
      const loaded = await window.api.readFile(file)
      const body =
        loaded.content.length > REF_CHAR_LIMIT
          ? `${loaded.content.slice(0, REF_CHAR_LIMIT)}\n…（已截断，原文共 ${loaded.content.length} 字符）`
          : loaded.content
      parts.push(`--- 文件：${file} ---\n\`\`\`${loaded.language || ''}\n${body}\n\`\`\``)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      parts.push(`--- 文件：${file} ---\n（读取失败：${msg}）`)
    }
  }
  return `以下是引用的文件内容：\n\n${parts.join('\n\n')}`
}

/**
 * 欢迎页的三个入口。
 *
 * 每个都带图标 + 颜色，与截图一致：
 * 学生看到的是三个「能直接点的事」，而不是三句话 —— 空态最怕的是不知道能干什么。
 * prompt 才是真正发出去的内容；label 只是给人看的短标签。
 */
const QUICK_STARTS = [
  {
    key: 'explain',
    label: '解读项目',
    tone: 'blue',
    icon: 'compass',
    prompt: '请帮我解读当前项目的结构，说明每个主要目录和文件的作用。'
  },
  {
    key: 'fix',
    label: '修复问题',
    tone: 'amber',
    icon: 'wrench',
    prompt: '我的代码有问题，请帮我找出原因并给出可以直接运行的改法。'
  },
  {
    key: 'brainstorm',
    label: '头脑风暴',
    tone: 'green',
    icon: 'bulb',
    prompt: '我想做一个练习项目，帮我出几个适合入门的点子。'
  }
] as const

/**
 * 算一个入口按钮的悬停说明。
 *
 * 返回 null 表示现在就能点。否则返回「为什么现在点不了、点了之后会怎样」——
 * 只写「不可用」是不够的，学生需要知道下一步该干什么。
 */
function gatingLabel(workspace: string, configured: boolean): string | null {
  if (!workspace) return '还没有打开项目。点击先选一个文件夹'
  if (!configured) return '还没配置模型。点击去设置里填地址与密钥'
  return null
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

const AiPanel = forwardRef<AiPanelHandle, { onOpenSettings: () => void }>(function AiPanel(
  { onOpenSettings },
  ref
): JSX.Element {
  const config = useAppStore((s) => s.config)
  const openFile = useAppStore((s) => s.openFile)
  const sessionId = useAppStore((s) => s.sessionId)
  const sessionLoading = useAppStore((s) => s.sessionLoading)
  const workspace = useAppStore((s) => s.workspace)
  const openWorkspace = useAppStore((s) => s.openWorkspace)
  const [items, setItems] = useState<ChatItem[]>([])
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
    setItems(
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
      if (requestRef.current) void window.api.aiAbort(requestRef.current)
      requestRef.current = ''
      // 缓冲区与定时器必须一起清：留着定时器的话，它稍后会拿旧 requestId
      // 往一个已经不存在的气泡里写文本（那次 map 找不到目标，但白跑一遍）
      if (deltaTimerRef.current !== null) {
        window.clearTimeout(deltaTimerRef.current)
        deltaTimerRef.current = null
      }
      deltaBufRef.current = ''
      setItems([])
      setInput('')
      setRefs([])
      setBusy(false)
      // 消息本体由 store.startNewSession 清（它负责落盘旧会话），
      // 这里只清展示态，两边不重复清同一份数据
    }
  }))

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
    deltaBufRef.current = ''
    if (!buffered) return ''
    setItems((prev) =>
      prev.map((it) =>
        it.id === requestRef.current ? { ...it, text: it.text + buffered } : it
      )
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
        deltaBufRef.current += chunk.text || ''
        if (deltaTimerRef.current === null) {
          deltaTimerRef.current = window.setTimeout(() => {
            deltaTimerRef.current = null
            const buffered = deltaBufRef.current
            deltaBufRef.current = ''
            if (!buffered) return
            setItems((prev) =>
              prev.map((it) =>
                it.id === chunk.requestId ? { ...it, text: it.text + buffered } : it
              )
            )
          }, STREAM_FLUSH_MS)
        }
      } else if (chunk.kind === 'tool') {
        // 工具步骤要和已生成的内容保持时间顺序，先把攒着的文本落下去
        flushDelta()
        const step = chunk.tool
        if (!step) return
        setItems((prev) =>
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
      } else if (chunk.kind === 'error') {
        // 报错也要先把攒着的文本落下去，否则学生看到的是「回答到一半就没了」
        flushDelta()
        setItems((prev) =>
          prev.map((it) =>
            it.id === chunk.requestId
              ? { ...it, role: 'error', text: `${it.text}${chunk.message || ''}` }
              : it
          )
        )
        setBusy(false)
      } else {
        // 流正常结束：最后一段文本必须先落地，那是回答的收尾
        flushDelta()
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
      .filter((it) => it.role === 'user' || it.role === 'assistant')
      .map((it) => ({ role: it.role as 'user' | 'assistant', text: it.text, at }))
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
   * 为什么用函数式 setItems 的返回值算 payload，而不是直接读 items：
   * items 是 React state，从上层闭包里读到的那份可能是旧的。
   * 这里借用 setItems 的 updater 同步拿到「合并了溢出文本之后」的权威列表，
   * 算完再把同一个列表写回去。比另开一个 ref 镜像 items 更难写错。
   *
   * @param pending 还没进 items 的流式尾段（合并节流攒下来的），必须先并进去
   */
  const syncStore = (pending = ''): void => {
    const at = new Date().toISOString()
    let authoritative: ChatItem[] = []
    setItems((prev) => {
      authoritative = pending
        ? prev.map((it) =>
            it.id === requestRef.current ? { ...it, text: it.text + pending } : it
          )
        : prev
      return authoritative
    })
    const payload = authoritative
      .filter((it) => it.role === 'user' || it.role === 'assistant')
      .map((it) => ({ role: it.role as 'user' | 'assistant', text: it.text, at }))
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
      window.alert('当前模型没有开启图片支持。\n\n如果这个模型确实能看图，请到「设置 → AI 模型」里勾选「支持图片输入」。')
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

  const send = async (raw?: string): Promise<void> => {
    const typed = (raw ?? input).trim()
    // 只挂了引用文件 / 只贴了图、一句话没写，也应该能发 ——
    // 学生的意图就是「看看这个文件」或「看看这张图」
    if ((!typed && refs.length === 0 && images.length === 0) || busy || imageBusy) return
    // 正在读历史会话时就别发了：读回来的结果会把刚发出去的这条冲掉
    if (sessionLoading) return

    const requestId = `req-${Date.now()}`
    requestRef.current = requestId

    // 引用文件的正文附在提问末尾。
    // 不放进 system prompt：system 是所有轮次共用的，塞进去会让缓存立刻失效，
    // 而引用是「这一轮」的事。
    const attached = await buildReferenceBlock(refs)
    const text = (typed || '请看这几个文件')
    const fullText = attached ? `${text}\n\n${attached}` : text

    // 图片随这一轮发出去。文本里加一行占位说明，
    // 否则回看历史时只有「请看这张图」而看不到图，会以为消息发丢了
    const sentImages = images
    const withImageNote = sentImages.length
      ? `${fullText}\n\n（附 ${sentImages.length} 张图片）`
      : fullText

    const userItem: ChatItem = { id: `u-${Date.now()}`, role: 'user', text: withImageNote }
    const aiItem: ChatItem = { id: requestId, role: 'assistant', text: '' }

    const history = [...items, userItem].filter((it) => it.role === 'user' || it.role === 'assistant')
    setItems((prev) => [...prev, userItem, aiItem])
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
        role: it.role as 'user' | 'assistant',
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
     */
    const historyMessages: ChatMessage[] = history.map((it) => ({
      role: it.role as 'user' | 'assistant',
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
     */
    const messages: ChatMessage[] = [{ role: 'system', content: '' }, ...historyMessages]

    /*
     * 带上会话 id。
     *
     * 主进程用它判断「是不是一次新会话」—— 新会话才重新校验
     * userData/系统.md（覆盖手改、让设置改动生效），同一会话内复用快照
     * 以保证前后一致。上面的 recordSession 已经跑过，所以这里必然有值。
     */
    await window.api.aiChat(requestId, messages, useAppStore.getState().sessionId)
    setBusy(false)
    // 回答结束，把带完整回答的 items 一次性写回 store。
    // 带上还在缓冲区里的尾段：那有可能是整段回答的最后一句
    syncStore(flushDelta())
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
    setItems((prev) => {
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
    setItems((prev) => {
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

    setItems((prev) => {
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
      window.alert('请先在右侧文件树里点选一个文件，再点这里引用。\n也可以直接在文件上右键「插入引用」。')
      return
    }
    useAppStore.getState().insertReference(selected)
    inputRef.current?.focus()
  }

  return (
    <section className="chat">
      <div className="chat-scroll" ref={scrollRef}>
        <div className="chat-inner">
          {items.length === 0 ? (
            <div className="welcome">
              {/* 用真 logo 而不是手绘的火箭 svg —— 界面上只该有一种火箭 */}
              <img className="welcome-badge" src="./logo.png" alt="" />
              <h1>{greeting()}，今天想从哪里开始？</h1>

              {/*
                三个入口无论是否配置模型都显示。
                这三张卡本身就是「这个软件能干什么」的说明书，
                没配置时恰好是最需要它的时候。点击时的拦截顺序见下面注释。
              */}
              <div className="quick-starts">
                {QUICK_STARTS.map((q) => (
                  <button
                    key={q.key}
                    className="quick-start"
                    title={gatingLabel(workspace, configured) ?? q.label}
                    onClick={() => {
                      // 按顺序拦两件事，每一件都是「现在发出去没意义」的情况：
                      //   1. 没打开工作区 → 「解读项目」会发给一个看不到任何文件的 AI，
                      //      它只能瞎猜目录结构。先去选文件夹。
                      //   2. 没配模型 → 发出去必然失败，引导到设置页
                      // 少了第 1 条时，学生点「解读项目」得到的是编造的答案，
                      // 这比直接报错更坏 —— 他不知道那是假的。
                      if (!workspace) void openWorkspace()
                      else if (!configured) onOpenSettings()
                      else void send(q.prompt)
                    }}
                  >
                    <span className={`quick-icon tone-${q.tone}`} aria-hidden="true">
                      {q.icon === 'compass' ? <CompassIcon /> : null}
                      {q.icon === 'wrench' ? <WrenchIcon /> : null}
                      {q.icon === 'bulb' ? <BulbIcon /> : null}
                    </span>
                    <span className="quick-label">{q.label}</span>
                  </button>
                ))}
              </div>

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
              : '输入消息，@ 引用文件，/ 引用 Skills，提示词可队列发送…'
          }
          value={input}
          onPaste={onPaste}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
              e.preventDefault()
              void send()
            }
          }}
        />

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
  const [showTools, setShowTools] = useState(running)
  // 从「正在跑」变成「跑完了」时自动收起，把屏幕让给答案
  useEffect(() => {
    if (!running) setShowTools(false)
  }, [running])

  const toolCount = item.tools?.length ?? 0
  const failed = item.tools?.some((step) => step.phase === 'done' && step.ok === false) ?? false
  const canAct = item.role === 'user' || item.role === 'assistant'

  return (
    <div className={`msg-row ${item.role}`}>
      <div className="msg-col">
        {toolCount > 0 && (
          <div className="tool-trace">
            <button
              className="tool-toggle"
              aria-expanded={showTools}
              onClick={() => setShowTools((v) => !v)}
            >
              <span className={`tool-caret${showTools ? ' is-open' : ''}`} aria-hidden="true">
                ▸
              </span>
              <span>
                {running ? `正在执行 ${toolCount} 步…` : `执行了 ${toolCount} 步`}
              </span>
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
        <div className="bubble">
          {item.text ? (
            item.text
          ) : toolCount > 0 ? (
            <span className="muted">正在处理…</span>
          ) : (
            <span className="dots">
              <i />
              <i />
              <i />
            </span>
          )}
        </div>
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

