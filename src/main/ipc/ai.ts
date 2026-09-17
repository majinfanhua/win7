import { StringDecoder } from 'node:string_decoder'
import { ipcMain, net } from 'electron'
import {
  IPC,
  textOf,
  SUMMARY_MARKER,
  type AiStreamChunk,
  type AiTestResult,
  type AiUsage,
  type ChatContent,
  type ChatMessage,
  type ManualCompactionResult,
  type ModelListResult
} from '../../shared/types'
import { chatEndpoint, describeHttpError, modelsEndpoint } from '../../shared/ai-endpoint'
import { getConfig } from '../config'
import {
  isModelKnown,
  KEEP_RECENT_USER_TURNS,
  MIN_COMPACTION_INTERVAL_MS,
  MIN_COMPACTION_USER_MESSAGES,
  PRUNE_MINIMUM_TOKENS,
  resolveBudgetForModel,
  resolveThreshold
} from '../compaction-policy'
import {
  noteCompacted,
  pressureOf,
  splitForCompaction,
  summarizeForCompaction,
  summaryContent
} from '../compaction'
import { getCapabilityInfo } from '../capabilities'
import { sessionSystemPrompt } from '../system-doc'
import { buildHeaders, configError } from '../llm'
import { describeNetworkError } from '../tls'
import { recordUsage } from '../usage'
import { executeTool, summarizeCall, toolSchemasForModel } from '../tools'
import { collectMcpTools, ensureMcpStarted } from '../mcp/manager'
import {
  describeTruncatedCall,
  ToolArgumentTracker,
  type TruncationReport
} from '../tools/argument-guard'
import { logger } from '../logger'
import {
  stallTimeoutMessage,
  STREAM_ROUND_MAX_MS,
  STREAM_STALL_TIMEOUT_MS
} from '../stream-watchdog'

/** 正在进行的流式请求，用于中断 */
const active = new Map<string, Electron.ClientRequest>()

/**
 * 被用户点了「停止」的请求。
 * 光 abort 掉当前那条 HTTP 请求不够 —— 工具循环可能正在执行工具，
 * 执行完还会再发一轮请求，所以循环里每轮都要看一眼这个标记。
 */
const aborted = new Set<string>()

/**
 * 「连接自检 / 拉模型列表」这类短请求的超时。
 *
 * ⚠️ 它**不是**对话请求的超时。对话那边原来是同名的 `CHAT_TIMEOUT_MS = 120_000`，
 * 含义是「一次 HTTP 往返的总时长上限」—— 于是模型连续输出超过 2 分钟必然被砍，
 * 要调 editFile 的那一轮也可能在参数吐完前被掐断
 * （用户报的「AI 明明在输出却因 120s 结束」与「改代码时被超时中断」都是它）。
 * 现在对话改走停顿看门狗，规则见 stream-watchdog.ts。
 */
const SHORT_TIMEOUT_MS = 30_000

export function abortAi(requestId: string): boolean {
  aborted.add(requestId)
  const req = active.get(requestId)
  if (!req) {
    // 当前没有在飞的请求，但工具循环可能还在跑，标记已经打上了
    logger.info('ai', `已标记中断 ${requestId}（当前无在飞的请求）`)
    return true
  }
  active.delete(requestId)
  try {
    req.abort()
  } catch {
    /* 已结束的请求 abort 会抛错，忽略 */
  }
  logger.info('ai', `已中断请求 ${requestId}`)
  return true
}

/** 读干响应体，用于错误分支和短请求 */
function readBody(stream: Electron.IncomingMessage, done: (body: string) => void): void {
  let raw = ''
  /*
   * ⚠️ 必须用 StringDecoder。
   *
   * 响应体是一段段到达的，TCP 会在**任意字节位置**切开 ——
   * 包括切在一个 UTF-8 多字节字符中间（汉字 3 字节）。
   * 对每块直接 toString('utf8') 的话，被切断的两半各自解出 U+FFFD（�），
   * 中文错误信息与中文回答都会出现乱码。
   * 实测：按 100 字节切一段中文回答，直接 toString 出现 15 处乱码。
   */
  const decoder = new StringDecoder('utf8')
  stream.on('data', (chunk) => {
    raw += decoder.write(chunk)
  })
  stream.on('end', () => done(raw + decoder.end()))
  stream.on('error', () => done(raw + decoder.end()))
}

/* ------------------------------------------------------------------ *
 * 缓存命中
 * ------------------------------------------------------------------ */

/** 上一次请求的 prompt 文本，用于本地估算缓存命中 */
let lastPromptText = ''

/** 把 messages 拍平成一段文本，方便比较前后两次请求的公共前缀 */
/**
 * 拍平用的最小形状。
 * 不用 ChatMessage 是因为工具循环里的 assistant / tool 消息 content 可能是 null。
 */
interface PromptLike {
  role: string
  content: ChatContent | null
}

function flattenPrompt(messages: PromptLike[]): string {
  /*
   * 只拍文本部分，图片的 base64 不参与。
   *
   * 两个理由：base64 每张都不同，放进去会让「与上一次请求的公共前缀」
   * 永远算成 0（缓存命中率永远是 0%，而实际上前缀是命中的）；
   * 而且那串东西几 MB，每次请求都拼一遍纯属浪费 CPU。
   */
  return messages.map((m) => `${m.role}\u0000${m.content ? textOf(m.content) : ''}`).join('\u0001')
}

function commonPrefixLength(a: string, b: string): number {
  const max = Math.min(a.length, b.length)
  let i = 0
  while (i < max && a.charCodeAt(i) === b.charCodeAt(i)) i++
  return i
}

/** 粗略 token 换算：中文约 1 字 1 个，英文约 4 字符 1 个，折中按 2 字符 1 个 */
function roughTokens(text: string): number {
  return Math.max(1, Math.round(text.length / 2))
}

/**
 * 本地估算缓存命中。
 *
 * prompt 缓存是按“前缀”命中的，所以同一会话里的后续几轮通常能命中大部分前缀。
 * 这里拿与上一次请求的公共前缀占比做估算 —— 只给量级，不是精确值：
 * 真实缓存还有最小块大小与 TTL，估算结果一般会偏高。
 */
function estimateUsage(messages: PromptLike[], completion: string): AiUsage {
  const prompt = flattenPrompt(messages)
  const promptTokens = roughTokens(prompt)
  const hitRatio = commonPrefixLength(prompt, lastPromptText) / Math.max(1, prompt.length)
  const cachedTokens = Math.round(promptTokens * hitRatio)
  return {
    promptTokens,
    completionTokens: roughTokens(completion),
    cachedTokens,
    cacheHitRate: cachedTokens / promptTokens,
    source: 'estimate'
  }
}

/** 各家中转站报的 usage 字段名不一样，这里只声明可能出现的那几个 */
interface RawUsage {
  prompt_tokens?: number
  completion_tokens?: number
  prompt_cache_hit_tokens?: number
  prompt_tokens_details?: { cached_tokens?: number }
  cache_read_input_tokens?: number
}

/**
 * 抠出缓存命中数。按常见程度依次尝试：
 *   - DeepSeek：prompt_cache_hit_tokens
 *   - OpenAI：prompt_tokens_details.cached_tokens
 *   - Anthropic 风格（部分中转站转发时会保留）：cache_read_input_tokens
 * 都没给就返回 null —— 说明这家不报缓存，只能走估算。
 */
function cachedTokensFrom(raw: RawUsage): number | null {
  if (typeof raw.prompt_cache_hit_tokens === 'number') return raw.prompt_cache_hit_tokens
  const details = raw.prompt_tokens_details
  if (details && typeof details.cached_tokens === 'number') return details.cached_tokens
  if (typeof raw.cache_read_input_tokens === 'number') return raw.cache_read_input_tokens
  return null
}

/** token 数尽量用真实值，缓存命中率拿不到就用估算，并用 source 标明来源 */
function buildUsage(raw: RawUsage | null, messages: PromptLike[], completion: string): AiUsage {
  const estimate = estimateUsage(messages, completion)
  if (!raw) return estimate

  const promptTokens = raw.prompt_tokens ?? estimate.promptTokens
  const completionTokens = raw.completion_tokens ?? estimate.completionTokens
  const cached = cachedTokensFrom(raw)
  // 报了用量但不报缓存，那就只把 token 数换成真实值
  if (cached === null) return { ...estimate, promptTokens, completionTokens }

  return {
    promptTokens,
    completionTokens,
    cachedTokens: cached,
    cacheHitRate: promptTokens > 0 ? cached / promptTokens : 0,
    source: 'api'
  }
}

/* ------------------------------------------------------------------ *
 * 工具调用
 * ------------------------------------------------------------------ */

interface WireToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

/**
 * 发给中转站的消息。
 * 比 ChatMessage 多出 tool 角色，只在本文件内部用，不污染渲染层的契约。
 */
interface WireMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: ChatContent | null
  tool_calls?: WireToolCall[]
  tool_call_id?: string
}

/** 一次提问最多几轮工具往返。防止模型来回读文件停不下来，把 token 烧光。 */
const MAX_TOOL_ROUNDS = 8

interface RoundOptions {
  includeUsage: boolean
  useTools: boolean
}

type RoundResult =
  | { kind: 'final'; usage: AiUsage }
  /** text 是模型这一轮先说出口的话（可能为空），要跟着 tool_calls 一起回灌 */
  | { kind: 'tools'; calls: WireToolCall[]; usage: AiUsage; text: string; truncated: TruncationReport }
  | { kind: 'error'; message: string }
  /** 中转站不认某个参数，去掉后重试。不计入工具轮数。 */
  | { kind: 'retry'; reason: 'stream-options' | 'tools' }
/** 模型给的工具调用增量分片 */
interface RawToolCallDelta {
  index?: number
  id?: string
  function?: { name?: string; arguments?: string }
}

/**
 * 单轮请求（一次 HTTP 往返）。
 *
 * 三种收尾：模型直接答完（final）、模型要调工具（tools）、出错。
 * 中转站拒绝可选参数时返回 retry，由上层降级后重来。
 */
function streamRound(
  requestId: string,
  messages: WireMessage[],
  emit: (chunk: AiStreamChunk) => void,
  opts: RoundOptions
): Promise<RoundResult> {
  const cfg = getConfig().ai
  const toolSchemas = opts.useTools ? toolSchemasForModel() : []

  const body = JSON.stringify({
    model: cfg.model,
    messages,
    temperature: cfg.temperature,
    stream: true,
    // 只有带上它，OpenAI / DeepSeek 才会在流末尾补一块 usage
    ...(opts.includeUsage ? { stream_options: { include_usage: true } } : {}),
    ...(toolSchemas.length > 0 ? { tools: toolSchemas } : {})
  })

  return new Promise((resolve) => {
    let settled = false
    let rawUsage: RawUsage | null = null
    let completionText = ''
    const calls = new Map<number, WireToolCall>()
    // 记录参数分片原文，用于识别「参数没传完」的截断调用。
    // 必须在这里顺手记：拼好的 arguments 已经丢掉了分片边界，
    // 事后再看无法区分真截断和「累计快照流」。
    const argTracker = new ToolArgumentTracker()

    /*
     * 停顿看门狗。
     *
     * 规则见 stream-watchdog.ts：计时器在**每一片到达的数据**上重置，
     * 而不是「一轮只给 120 秒」。这是「AI 明明在输出却被超时结束」的修复点。
     *
     * 两个计时器各管一件事：
     *   - stall：多久没有收到任何数据（每片重置）→ 防上游半死不活
     *   - ceiling：这一轮总共跑了多久（不重置）→ 防「连接活着但永远不答」
     *
     * 两个都不覆盖工具执行时间：模型给出 tool_calls 时这一轮就结束了，
     * settle() 会停表；工具跑完开下一轮才重新起表。
     */
    let stallTimer: NodeJS.Timeout | null = null
    let ceilingTimer: NodeJS.Timeout | null = null

    const stopWatchdog = (): void => {
      if (stallTimer !== null) {
        clearTimeout(stallTimer)
        stallTimer = null
      }
      if (ceilingTimer !== null) {
        clearTimeout(ceilingTimer)
        ceilingTimer = null
      }
    }

    /** 判定超时：掐断连接并报错。两个计时器共用 */
    const timeOut = (kind: 'stall' | 'ceiling', limit: number): void => {
      try {
        request.abort()
      } catch {
        /* ignore */
      }
      logger.warn(
        'ai',
        `请求 ${requestId} 判定超时（${kind}，${Math.round(limit / 1000)}s），已中断`
      )
      settle({ kind: 'error', message: stallTimeoutMessage(kind, limit) })
    }

    /** 有进展（收到任意一片数据）就重新计时 */
    const progress = (): void => {
      if (stallTimer !== null) clearTimeout(stallTimer)
      stallTimer = setTimeout(() => timeOut('stall', STREAM_STALL_TIMEOUT_MS), STREAM_STALL_TIMEOUT_MS)
    }

    const settle = (result: RoundResult): void => {
      if (settled) return
      settled = true
      active.delete(requestId)
      stopWatchdog()
      resolve(result)
    }

    /** 一轮结束时统一判定：有 tool_calls 就是要求调工具，否则算答完 */
    const finish = (): void => {
      const usage = buildUsage(rawUsage, messages, completionText)
      const list = [...calls.entries()].sort((a, b) => a[0] - b[0]).map(([, value]) => value)
      if (list.length > 0) {
        settle({ kind: 'tools', calls: list, usage, text: completionText, truncated: argTracker.report(list) })
      } else settle({ kind: 'final', usage })
    }

    /**
     * 累加分片。
     * 名字有两种发法：拆成几片（read + File），或者每片都带完整名字。
     * 两种都要吃下，所以相同就不重复拼。
     */
    const absorb = (delta: RawToolCallDelta): void => {
      const index = typeof delta.index === 'number' ? delta.index : 0
      const acc = calls.get(index) || {
        id: '',
        type: 'function' as const,
        function: { name: '', arguments: '' }
      }
      if (delta.id && !acc.id) acc.id = delta.id
      const name = delta.function?.name
      if (name && name !== acc.function.name) acc.function.name += name
      const args = delta.function?.arguments
      if (args) acc.function.arguments += args
      calls.set(index, acc)
      // 原文分片单独记一份，供截断判定使用
      argTracker.noteDelta(index, args || '')
    }

    let request: Electron.ClientRequest
    try {
      request = net.request({ method: 'POST', url: chatEndpoint(cfg.baseUrl), redirect: 'follow' })
    } catch (err) {
      settle({ kind: 'error', message: `请求创建失败: ${String(err)}` })
      return
    }

    active.set(requestId, request)

    /*
     * 两个计时器一起起。
     *
     * 起表点在这里（请求发出前）而不是收到响应头之后：
     * 上游「连上了但一个字不回」同样需要兜住，而那时还没有任何分片能重置停顿计时器。
     *
     * 停顿计时器第一段给的是 STREAM_STALL_TIMEOUT_MS，不是更短的值 ——
     * HTTP 响应头通常要等模型吐出第一个 token 才发，
     * 所以「建连阶段」和「等首字」在时间上分不开（详见 stream-watchdog.ts）。
     */
    progress()
    ceilingTimer = setTimeout(() => timeOut('ceiling', STREAM_ROUND_MAX_MS), STREAM_ROUND_MAX_MS)

    for (const [key, value] of Object.entries(buildHeaders('text/event-stream'))) request.setHeader(key, value)

    request.on('response', (response) => {
      const status = response.statusCode || 0
      if (status !== 200) {
        readBody(response, (raw) => {
          // 400/422 基本都是「这个参数我不认识」，逐个降级再试，别把功能整个打挂。
          // 先去掉 stream_options（只影响用量统计），再去掉 tools（退化成普通对话）。
          if ((status === 400 || status === 422) && opts.includeUsage) {
            logger.warn('ai', `中转站拒绝了 stream_options（HTTP ${status}），去掉该参数重试`)
            settle({ kind: 'retry', reason: 'stream-options' })
            return
          }
          if ((status === 400 || status === 422) && toolSchemas.length > 0) {
            logger.warn('ai', `中转站拒绝了 tools（HTTP ${status}），降级为无工具对话`)
            settle({ kind: 'retry', reason: 'tools' })
            return
          }
          settle({ kind: 'error', message: describeHttpError(status, raw) })
        })
        return
      }

      let buffer = ''
      /*
       * 同上：SSE 也是按块到达的，必须用 StringDecoder，
       * 否则 AI 的中文回答会随机出现乱码，而且会**存进对话记录**。
       */
      const decoder = new StringDecoder('utf8')
      response.on('data', (chunk) => {
        /*
         * 收到了数据 —— 先重置停顿计时器，再解析。
         *
         * 放在解析之前是刻意的：判断「上游还活着吗」只看**有没有字节到达**，
         * 不看这些字节解析出了什么。中转站的保活注释（`: keep-alive`）、
         * 空 choices、usage 块，全都算「活着」的证据。
         * 放到解析之后就要求「必须解析出正文分片」才算进展，
         * 那会把「上游在正常发心跳」误判成卡死。
         */
        progress()
        buffer += decoder.write(chunk)
        const lines = buffer.split('\n')
        buffer = lines.pop() || ''
        for (const rawLine of lines) {
          const line = rawLine.trim()
          if (!line || line.startsWith(':') || !line.startsWith('data:')) continue
          const payload = line.slice(5).trim()
          if (payload === '[DONE]') {
            finish()
            return
          }
          try {
            const json = JSON.parse(payload) as {
              choices?: Array<{
                delta?: {
                  content?: string
                  /** DeepSeek 等把思维链放在这个**独立字段**里，与 content 同级 */
                  reasoning_content?: string
                  /** 部分中转站用这个别名 */
                  reasoning?: string
                  tool_calls?: RawToolCallDelta[]
                }
              }>
              usage?: RawUsage
            }
            // usage 是单独一块送来的，那时 choices 是空数组
            if (json.usage) rawUsage = json.usage
            const delta = json.choices && json.choices[0] && json.choices[0].delta
            if (!delta) continue

            /*
             * 思维链归一化。
             *
             * 两条来源都要认：
             *   1. 独立字段 reasoning_content / reasoning（DeepSeek 官方的形态）
             *   2. content 里带  thinking… 标签（中转站把两者拼在一起的形态）
             *
             * 这里只处理第 1 种并打上 reasoning 标记；第 2 种交给渲染层
             * 用同一套解析器切（因为标签可能被分片切断，在主进程切会更麻烦，
             * 而渲染层本来就要处理流式拼接）。
             *
             * 思维链**不进 completionText**：它不是最终回答，
             * 混进去会让「落盘的对话正文」变成一大段自言自语。
             */
            const reasoningText = delta.reasoning_content || delta.reasoning
            if (reasoningText) {
              emit({ requestId, kind: 'delta', text: reasoningText, reasoning: true })
            }

            if (delta.content) {
              completionText += delta.content
              emit({ requestId, kind: 'delta', text: delta.content })
            }
            if (delta.tool_calls) for (const item of delta.tool_calls) absorb(item)
          } catch {
            /* 分片不完整，等下一个 chunk */
          }
        }
      })
      response.on('end', () => finish())
      response.on('error', (err: Error) => settle({ kind: 'error', message: `响应中断: ${err.message}` }))
    })

    // 走统一出口：证书类错误会被翻译成「去哪里关校验」的可照做提示
    request.on('error', (err: Error) => settle({ kind: 'error', message: describeNetworkError(err.message) }))
    request.write(body)
    request.end()
  })
}

/**
 * 流式对话（含工具循环）。
 *
 * 一轮 = 一次 HTTP 往返。模型要调工具时，把工具结果作为 tool 消息回灌，
 * 再发下一轮，直到模型给出最终回答或到达轮数上限。
 */
async function runStream(
  requestId: string,
  messages: ChatMessage[],
  emit: (chunk: AiStreamChunk) => void,
  sessionId = ''
): Promise<void> {
  const invalid = configError()
  if (invalid) {
    emit({ requestId, kind: 'error', message: invalid })
    return
  }

  aborted.delete(requestId)

  /*
   * system prompt 由主进程组装，**不用渲染层发过来的那份**。
   *
   * 渲描层发过来的 `system` 消息里只有设置里的「默认提示词」一段，
   * 而实际要发出去的还有身份（叫什么、怎么称呼用户）、习惯，
   * 以及自动探测出来的本机环境。这些拼在一起才是完整的 system prompt，
   * 全文写在 userData/系统.md 里（用户可以打开看）。
   *
   * 为什么组装放在主进程而不是渲染层：
   *   1. 环境探测（detectRuntimes）在主进程，结果本来就在这里
   *   2. 渲染层拼的话，「用户手改了 系统.md」这件事它不知道，
   *      而覆盖手改是明确要求的
   *   组装规则见 shared/system-doc.ts。
   */
  const wire: WireMessage[] = messages.map((m) => ({ role: m.role, content: m.content }))
  const systemText = await sessionSystemPrompt(sessionId)
  if (systemText) {
    injectSystemPrompt(wire, systemText)
  } else if (wire.every((m) => m.role !== 'system')) {
    // 组装失败（极端情况）时退回渲染层发来的那份，而不是发一个没有 system 的请求
    logger.warn('ai', '系统提示词组装失败，本次对话不带 system prompt')
  }

  /*
   * 自动压缩：到模型窗口的 80% 就把**较早的**对话总结成一段。
   *
   * 放在预算检查**之前**：压缩是解决超预算的手段，先拦下来报错
   * 就等于这个功能不存在。压完还超才会走到下面的拒绝分支。
   *
   * 失败不阻断 —— 那只是回到「带着完整历史发出去」，与没有这个功能时一样。
   */
  await compactIfNeeded(wire, sessionId, requestId, emit)

  // 压完再算一次。撑爆窗口就在这里拦住并说清原因，
  // 别让用户对着中转站那句 "context length exceeded" 发懵
  const overBudget = checkContextBudget(wire)
  if (overBudget) {
    logger.warn('ai', `上下文超出预算，已拒绝本次请求: 约 ${roughTokens(flattenPrompt(wire))} token`)
    emit({ requestId, kind: 'error', message: overBudget })
    return
  }

  /*
   * 记下本次**真正要发出去**的 prompt，估算缓存命中要拿它当下一轮基准。
   *
   * ⚠️ 必须在压缩**之后**取：压缩会把历史换成「摘要 + 最近几轮」，
   * 那才是发出去的东西。在压缩前取的话，下一轮估算缓存命中时
   * 比的是一份**根本没发出去过**的文本 —— 命中率会算成很低，
   * 用量统计凭白变得难看，而真实请求其实是命中缓存的。
   */
  const promptText = flattenPrompt(wire)

  /*
   * 先把 MCP 服务器拉起来再接工具表。
   *
   * 必须在 toolSchemasForModel() **之前**：没就绪的服务器不提供工具，
   * 先取表就会漏掉它们（表现为「配了 MCP 但 AI 看不到工具」）。
   *
   * await 的代价：只在第一次真正 spawn 时才有（几秒），
   * 之后每次都是「已就绪」直接返回。冷启动这几十毫秒到几秒
   * 换来的是「第一次对话就能用上外部工具」，值得。
   */
  if (getConfig().mcp.servers.some((s) => s.enabled)) {
    await ensureMcpStarted()
  }

  let includeUsage = true
  let useTools = toolSchemasForModel().length > 0
  if (useTools) {
    const caps = getCapabilityInfo()
    logger.info('ai', `本次对话启用 ${caps.effective.length} 个工具: ${caps.effective.join(', ')}`)
  } else {
    logger.info('ai', '本次对话未启用工具（当前环境/设置下无可用工具）')
  }
  // MCP 工具数单独记一条：出问题时能立刻分清「内置没生效」还是「外部没接上」
  const mcpCount = collectMcpTools().length
  if (mcpCount > 0) logger.info('ai', `其中 MCP 外部工具 ${mcpCount} 个`)

  // 多轮之间用量累加：一次提问可能包含好几次 HTTP 往返，看到的应该是总数
  const total = { promptTokens: 0, completionTokens: 0, cachedTokens: 0, fromApi: false }
  const addUsage = (usage: AiUsage): void => {
    total.promptTokens += usage.promptTokens
    total.completionTokens += usage.completionTokens
    total.cachedTokens += usage.cachedTokens
    if (usage.source === 'api') total.fromApi = true
    /*
     * 顺手记进统计。
     *
     * 在这里而不是在 HTTP 层：一轮工具循环有好几次往返，
     * 而用户关心的「这次提问花了多少」是它们的总和 ——
     * 但统计页要的是「每一次往返算一次请求」（缓存命中率按单次算才有意义）。
     * 两者口径不同，所以这里逐次记，界面上的总数由 usage.ts 累加得出。
     */
    recordUsage({
      model: getConfig().ai.model,
      promptTokens: usage.promptTokens,
      completionTokens: usage.completionTokens,
      cachedTokens: usage.cachedTokens,
      estimated: usage.source === 'estimate'
    })
  }
  const finalUsage = (): AiUsage => ({
    promptTokens: total.promptTokens,
    completionTokens: total.completionTokens,
    cachedTokens: total.cachedTokens,
    cacheHitRate: total.promptTokens > 0 ? total.cachedTokens / total.promptTokens : 0,
    source: total.fromApi ? 'api' : 'estimate'
  })

  let round = 0
  while (round < MAX_TOOL_ROUNDS) {
    if (aborted.has(requestId)) {
      aborted.delete(requestId)
      logger.info('ai', `请求 ${requestId} 已被用户停止`)
      /*
       * ⚠️ 必须发一个 done 收尾，不能只是 return。
       *
       * 渲染层的「正在生成」状态只在收到 done / error 时才清 ——
       * 静默 return 会让停止按钮点下去后**界面一直转圈**，
       * 用户以为没停下来（实际主进程早就停了）。
       * 这个坑踩过：看起来像「停止无效」，其实是没通知前端。
       *
       * 不发 usage：这次没有完整跑完，统计口径留给正常结束那条路。
       */
      emit({ requestId, kind: 'done' })
      return
    }

    /*
     * 发请求之前先看一眼上下文预算。
     *
     * 只做两件**无副作用**的事：
     *   1. 裁掉历史里最占地方的旧工具输出（不花钱、不改写对话语义，
     *      被裁掉的只是「AI 之前读过什么」，它可以再读一次）
     *   2. 如果裁完仍逼近窗口上限，提示用户 —— 而不是等中转站报 400
     *
     * 刻意**不做**自动总结压缩：那要额外发一次请求、要花钱、要等，
     * 而且总结错了会静默丢信息。教学场景里「明确告诉用户该开新对话了」
     * 比「悄悄丢掉一半历史」更可解释。
     */
    if (round > 0) pruneOldToolOutput(wire)

    const result = await streamRound(requestId, wire, emit, { includeUsage, useTools })

    if (result.kind === 'retry') {
      // 降级重试不算一轮，否则中转站不认参数时会把轮数白白吃掉
      if (result.reason === 'stream-options') includeUsage = false
      else useTools = false
      continue
    }

    round++

    if (result.kind === 'error') {
      emit({ requestId, kind: 'error', message: result.message })
      return
    }

    // 用量在报错分支之后累加：错误里没有 usage，顺序反了 TS 也不让过
    addUsage(result.usage)

    if (result.kind === 'final') {
      lastPromptText = promptText
      emit({ requestId, kind: 'done', usage: finalUsage() })
      return
    }

    // 模型要求调工具：先把它的 tool_calls 记进上下文，再逐个执行。
    // content 也要带上 —— 有些模型会先说一句「我先看一下这个文件」再调工具，
    // 丢掉它下一轮模型就看不到自己刚说过的话，容易出现前后矛盾的解释。
    wire.push({ role: 'assistant', content: result.text || null, tool_calls: result.calls })

    for (const call of result.calls) {
      const name = call.function?.name || 'unknown'
      const rawArgs = call.function?.arguments || ''
      emit({
        requestId,
        kind: 'tool',
        tool: { name, phase: 'start', summary: summarizeCall(name, rawArgs) }
      })

      /*
       * 参数没传完就断了 —— 绝不能执行。
       *
       * 这类残缺参数有时能被「宽容修复」成语法合法、语义错误的值
       * （路径被截断成另一个真实存在的路径是最典型的），
       * 执行下去就是改了不该改的文件。所以这里直接拒绝，
       * 并把原因作为工具结果回灌，让模型重新发起这次调用。
       */
      if (result.truncated.truncated.has(call.id)) {
        const reason = result.truncated.reasons.get(call.id) || '参数不完整'
        const text = describeTruncatedCall(name, reason)
        logger.warn('ai', `拒绝执行参数不完整的工具调用: ${name} (${call.id})`)
        emit({
          requestId,
          kind: 'tool',
          tool: { name, phase: 'done', summary: `${name}：参数不完整，已拒绝执行`, ok: false }
        })
        wire.push({ role: 'tool', tool_call_id: call.id, content: text })
        continue
      }

      /*
       * 把 sessionId 传进工具层。
       *
       * 权限层要靠它判断「这个会话是否已批准执行计划」（计划模式的硬门禁），
       * 以及越界授权该记在哪个会话名下。传错会话的后果是把批准放行到了
       * 另一段对话上，所以这里必须用当前这次请求的真实 sessionId。
       */
      const outcome = await executeTool(
        { id: call.id, name, arguments: rawArgs },
        { sessionId }
      )

      emit({
        requestId,
        kind: 'tool',
        tool: { name, phase: 'done', summary: outcome.summary, ok: outcome.ok }
      })
      wire.push({ role: 'tool', tool_call_id: call.id, content: outcome.text })
    }

    if (aborted.has(requestId)) {
      aborted.delete(requestId)
      logger.info('ai', `请求 ${requestId} 在工具执行后被停止`)
      // 同上：必须发 done 让前端清掉「正在生成」，否则一直转圈
      emit({ requestId, kind: 'done' })
      return
    }
  }

  // 到上限了：把已经生成的内容留着，明说一句，不要静默截断
  lastPromptText = promptText
  emit({
    requestId,
    kind: 'delta',
    text: `\n\n（本次工具调用已达 ${MAX_TOOL_ROUNDS} 轮上限，先停在这里。可以让我继续。）`
  })
  emit({ requestId, kind: 'done', usage: finalUsage() })
}

/* ------------------------------------------------------------------ *
 * 上下文预算
 * ------------------------------------------------------------------ */

/** 被裁掉的工具输出替换成这句话，让模型知道「这里原本有内容」 */
const PRUNED_PLACEHOLDER = '[输出已被裁剪以腾出上下文空间。需要的话请重新读取。]'

/**
 * 自动压缩：到模型上下文窗口的 80% 就把较早的对话总结成一段。
 *
 * ## 放在哪一步
 *
 * 在预算检查之前、pruneOldToolOutput 之后：
 *   1. 先裁工具输出（不花钱、无副作用）—— 能解决就不必花这次总结的钱
 *   2. 裁完仍到阈值，才调模型总结
 *
 * ## 为什么必须把结果发回渲染层
 *
 * 历史消息归渲染层所有，每轮整份发过来。主进程压完不通知的话，
 * 下一轮收到的还是完整历史 —— 每轮都要重新总结一次，
 * 既重复花钱、又永远压不下去（每次输入相同，算出同样的摘要）。
 *
 * ## 失败怎么办
 *
 * 不抛、不阻断。压缩失败只是回到「带着完整历史发出去」——
 * 与没有这个功能时的行为完全一样。绝不能因为总结不了就让用户发不出话。
 */
async function compactIfNeeded(
  wire: WireMessage[],
  sessionId: string,
  requestId: string,
  emit: (chunk: AiStreamChunk) => void
): Promise<void> {
  const ai = getConfig().ai
  const budget = resolveBudgetForModel(ai)
  const now = Date.now()
  const pressure = pressureOf(sessionId, now)

  const threshold = resolveThreshold({
    intent: 'optimization',
    contextWindow: budget.contextWindow,
    maxOutputToken: budget.maxOutputToken,
    pressureLevel: pressure.level
  })

  const total = roughTokens(flattenPrompt(wire))
  if (total < threshold) return

  /*
   * 冷却：刚压完就别再压。
   *
   * 只在「用户消息还很少」时挡 —— 一次超大粘贴会让对话立刻越阈值，
   * 那时若因为冷却而不压，用户会一直卡在超预算里发不出话。
   */
  const userMessages = wire.filter((m) => m.role === 'user').length
  if (
    pressure.lastCompactionAt > 0 &&
    now - pressure.lastCompactionAt < MIN_COMPACTION_INTERVAL_MS &&
    userMessages < MIN_COMPACTION_USER_MESSAGES
  ) {
    return
  }

  /*
   * 切分：system 与工具消息不参与总结，只在 user 边界上切。
   *
   * 切在 assistant / tool 中间会留下「回答没有对应提问」或
   * 「工具结果没有对应调用」的历史，而 OpenAI 兼容接口对 tool
   * 消息有配对要求 —— 那会直接 400。
   */
  const { head, tail } = splitForCompaction(wire)
  if (head.length === 0) {
    // 没有可折叠的内容（比如只有一轮但单条极大）——
    // 那不是压缩能解决的，交给后面的预算检查去报错
    return
  }

  logger.info(
    'ai',
    `上下文到 ${Math.round((total / threshold) * 100)}% 阈值，开始压缩：折叠 ${head.length} 条，保留 ${tail.length} 条`
  )

  const result = await summarizeForCompaction(head, sessionId)
  if (!result.ok || !result.summary) {
    // 压不动不算错误：退回原文发送，预算检查会在真的超了时报可读的错
    logger.warn('ai', `压缩失败，本次仍按完整历史发送：${result.error || '模型未返回摘要'}`)
    return
  }

  /*
   * 用摘要替换被折叠的那一段。
   *
   * 角色用 system 而不是 user：它是系统生成的交接说明，
   * 不是学生说的话。让学生以为「自己说过这段话」是错的。
   */
  // 就地改 wire：调用方之后直接用它发请求
  rebuildAfterCompaction(wire, summaryContent(result.summary), tail)

  const after = roughTokens(flattenPrompt(wire))
  noteCompacted(sessionId, { totalTokensAfter: after, threshold, now })

  logger.info(
    'ai',
    `压缩完成：约 ${total} → ${after} token（摘要 ${result.summary.length} 字，折叠 ${result.foldedCount} 条）`
  )

  /*
   * 通知渲染层改它自己的历史。
   *
   * keptCount 用「实际保留的条数」而不是让它自己再数一遍：
   * 两处各写一份「保留最近几轮」的判定迟早跑偏，
   * 跑偏要么重复发（浪费），要么把模型正在用的那几轮也丢掉（答非所问）。
   */
  emit({
    requestId,
    kind: 'compacted',
    compaction: {
      summary: result.summary,
      keptCount: tail.length,
      foldedCount: result.foldedCount
    }
  })
}

/**
 * 压缩之后重建 wire：`[system prompt?] [新摘要] [保留的最近几轮]`
 *
 * ## 为什么单独一个函数（两个调用点都必须一致）
 *
 * 自动压缩与手动压缩（`/compact`）都要做这件事。以前是各写一遍，
 * 而两份都写错了同一个地方：用 `findIndex(role === 'system')` 拿
 * 「第一条 system」当作系统提示词塞回最前面 ——
 *
 *   - 若历史里**已经有**上一次的摘要（那也是 system，且在更前面），
 *     取到的其实是摘要，于是新旧两条摘要同时存在：模型会读两遍
 *     而且可能读到互相矛盾的两版
 *   - 若系统提示词组装失败（极端情况），也会取到摘要，
 *     把它当成系统提示词插到最前 —— 语义完全错位
 *
 * 现在只认「非摘要的 system」才是系统提示词（用 SUMMARY_MARKER 区分）。
 * 找不到就不放（主进程稍后还会注入真正的那份，见 injectSystemPrompt）。
 */
function rebuildAfterCompaction(wire: WireMessage[], summary: string, tail: WireMessage[]): void {
  const promptIndex = wire.findIndex(
    (m) =>
      m.role === 'system' &&
      !(typeof m.content === 'string' && m.content.startsWith(SUMMARY_MARKER))
  )
  const rebuilt: WireMessage[] = []
  if (promptIndex >= 0) rebuilt.push(wire[promptIndex])
  rebuilt.push({ role: 'system', content: summary }, ...tail)
  wire.length = 0
  wire.push(...rebuilt)
}

/**
 * 把真正的 system prompt 放到 wire 的最前面。
 *
 * ## 为什么不能简单地「找到第一条 system 就替换」
 *
 * 压缩摘要**也是 system 角色**（见 compaction.ts）。老写法是
 * `findIndex(role === 'system')` 然后整个替换掉 —— 那会把摘要**直接删掉**：
 * 模型于是完全不知道之前聊过什么，压缩反而变成了「失忆」。
 * 这个 bug 完全静默（请求照常成功），只是 AI 突然开始答非所问。
 *
 * 所以判定要区分两种 system：
 *   - **摘要**：以 SUMMARY_MARKER 开头 → 属于历史内容，必须保留
 *   - **占位/系统提示词**：渲染层发来的空壳（旧版行为）或上次注入的那份
 *     → 可以被替换
 *
 * 替换掉第一条**非摘要**的 system；没有就插到最前面。
 * 摘要永远留在它原来的位置（历史的开头），语义不变。
 */
function injectSystemPrompt(wire: WireMessage[], systemText: string): void {
  const isSummary = (m: WireMessage): boolean =>
    typeof m.content === 'string' && m.content.startsWith(SUMMARY_MARKER)

  const index = wire.findIndex((m) => m.role === 'system' && !isSummary(m))
  if (index >= 0) wire[index] = { role: 'system', content: systemText }
  else wire.unshift({ role: 'system', content: systemText })
}

/**
 * 裁剪历史里较旧的工具输出。
 *
 * ## 为什么只裁工具输出
 *
 * 一轮工具往返可能把整个文件读进上下文（readFile 一次几千行）。
 * 这些内容的特点是**可以重新获得**：模型只要再调一次 readFile 就有。
 * 而用户的提问、模型的回答不能重来 —— 裁掉它们等于篡改对话。
 *
 * ## 保护策略
 *
 * 从**最新往前**数，保留最近若干条工具输出；再往前的才裁。
 * 这样模型对「刚才那几步」的记忆是完整的，丢掉的只是更早的、
 * 通常已经用完的中间结果。
 *
 * 这是第一道防线，成本为零。裁完还超预算才提示用户开新对话。
 */
function pruneOldToolOutput(wire: WireMessage[]): void {
  const ai = getConfig().ai
  const budget = resolveBudgetForModel(ai)
  const threshold = resolveThreshold({
    intent: 'optimization',
    contextWindow: budget.contextWindow,
    maxOutputToken: budget.maxOutputToken,
    pressureLevel: 0
  })

  const total = roughTokens(flattenPrompt(wire))
  // 还宽裕就什么都不做 —— 不要在没压力时动历史
  if (total < threshold * 0.8) return

  // 收集可裁的工具消息下标（从新到旧）
  const toolIndexes: number[] = []
  for (let i = wire.length - 1; i >= 0; i--) {
    if (wire[i].role === 'tool') toolIndexes.push(i)
  }
  // 最近 4 条留着：模型正在用的上下文
  const PROTECT_RECENT = 4
  const candidates = toolIndexes.slice(PROTECT_RECENT)

  let released = 0
  let pruned = 0
  for (const index of candidates) {
    const content = wire[index].content
    if (typeof content !== 'string') continue
    // 已经裁过的不重复裁
    if (content === PRUNED_PLACEHOLDER) continue
    const size = roughTokens(content)
    // 太短的裁了没意义，还会让消息语义变模糊
    if (size < 500) continue
    released += size - roughTokens(PRUNED_PLACEHOLDER)
    wire[index] = { ...wire[index], content: PRUNED_PLACEHOLDER }
    pruned++
    if (released >= PRUNE_MINIMUM_TOKENS) break
  }

  if (pruned > 0) {
    logger.info(
      'ai',
      `上下文接近上限，已裁剪 ${pruned} 条旧工具输出，释放约 ${released} token（当前约 ${total}）`
    )
  }
}

/**
 * 检查这次请求会不会撑爆窗口。
 *
 * 返回一句给用户看的话，或 null（没问题）。
 * 宁可提前说清楚，也不要让用户看着一个 HTTP 400 猜原因 ——
 * 中转站的报错信息通常只有一句「context length exceeded」，
 * 学生根本不知道该怎么办。
 */
function checkContextBudget(wire: WireMessage[]): string | null {
  const cfg = getConfig().ai
  const budget = resolveBudgetForModel(cfg)
  const total = roughTokens(flattenPrompt(wire))
  const threshold = resolveThreshold({
    intent: 'protection',
    contextWindow: budget.contextWindow,
    maxOutputToken: budget.maxOutputToken,
    pressureLevel: 0
  })

  if (total <= threshold) return null

  const known = isModelKnown(cfg.model)
  return (
    `这次提问的上下文约 ${total} token，已经超过当前模型的预算（约 ${threshold}）。\n\n` +
    (known
      ? `当前模型按「${cfg.model}」判定窗口为 ${budget.contextWindow} token。`
      : `内置表不认识模型「${cfg.model}」，已按保守值 ${budget.contextWindow} token 估算；` +
        '如果这个模型实际窗口更大，可以在「设置 → 模型」里手动填写上下文窗口。') +
    '\n\n建议：**新建一个对话**再继续问。当前这个会话的历史已经很长，' +
    '继续下去即使能发出去，模型也容易忽略前面的内容。'
  )
}

/* ------------------------------------------------------------------ *
 * 各 IPC 入口
 * ------------------------------------------------------------------ */

/** 连通性自检：用最小请求验证地址 / 密钥 / 模型三者是否可用 */
function testConnection(): Promise<AiTestResult> {
  const invalid = configError()
  if (invalid) return Promise.resolve({ ok: false, detail: invalid })

  const cfg = getConfig().ai
  const started = Date.now()
  const body = JSON.stringify({
    model: cfg.model,
    messages: [{ role: 'user', content: 'ping' }],
    max_tokens: 1,
    stream: false
  })

  return new Promise((resolve) => {
    const request = net.request({ method: 'POST', url: chatEndpoint(cfg.baseUrl), redirect: 'follow' })
    for (const [key, value] of Object.entries(buildHeaders('application/json'))) request.setHeader(key, value)

    let settled = false
    const done = (result: AiTestResult): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(result)
    }
    const timer = setTimeout(() => {
      try {
        request.abort()
      } catch {
        /* ignore */
      }
      done({ ok: false, detail: `连接超时（${SHORT_TIMEOUT_MS / 1000}s）` })
    }, SHORT_TIMEOUT_MS)

    request.on('response', (response) => {
      const status = response.statusCode || 0
      const latencyMs = Date.now() - started
      readBody(response, (raw) => {
        if (status === 200) done({ ok: true, detail: `连接正常，模型 ${cfg.model} 可用`, latencyMs })
        else done({ ok: false, detail: describeHttpError(status, raw), latencyMs })
      })
    })
    request.on('error', (err: Error) => done({ ok: false, detail: describeNetworkError(err.message) }))
    request.write(body)
    request.end()
  })
}

/**
 * 拉取可用模型列表。
 * 中转站的模型名差异很大，让用户手敲很容易填错，这里直接问它。
 */
function listModels(): Promise<ModelListResult> {
  const cfg = getConfig().ai
  if (!cfg.baseUrl.trim()) return Promise.resolve({ ok: false, models: [], detail: '尚未配置接口地址' })
  if (!cfg.apiKey.trim()) return Promise.resolve({ ok: false, models: [], detail: '尚未配置 API Key' })

  return new Promise((resolve) => {
    const request = net.request({ method: 'GET', url: modelsEndpoint(cfg.baseUrl), redirect: 'follow' })
    for (const [key, value] of Object.entries(buildHeaders('application/json'))) request.setHeader(key, value)

    let settled = false
    const done = (result: ModelListResult): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(result)
    }
    const timer = setTimeout(() => {
      try {
        request.abort()
      } catch {
        /* ignore */
      }
      done({ ok: false, models: [], detail: `拉取模型列表超时（${SHORT_TIMEOUT_MS / 1000}s）` })
    }, SHORT_TIMEOUT_MS)

    request.on('response', (response) => {
      const status = response.statusCode || 0
      readBody(response, (raw) => {
        if (status !== 200) {
          done({ ok: false, models: [], detail: describeHttpError(status, raw) })
          return
        }
        try {
          const json = JSON.parse(raw) as { data?: Array<{ id?: string }> }
          const models = (json.data || [])
            .map((m) => m.id || '')
            .filter(Boolean)
            .sort((a, b) => a.localeCompare(b))
          done({
            ok: models.length > 0,
            models,
            detail: models.length ? `共 ${models.length} 个模型` : '接口未返回任何模型'
          })
        } catch (err) {
          done({ ok: false, models: [], detail: `模型列表解析失败: ${String(err)}` })
        }
      })
    })
    request.on('error', (err: Error) =>
      done({ ok: false, models: [], detail: describeNetworkError(err.message) })
    )
    request.end()
  })
}

/**
 * 手动压缩（`/compact` 命令）。
 *
 * ## 与自动压缩的区别
 *
 *   - **不看阈值**：用户说了压就压，哪怕现在只有 30% ——
 *     他的意图可能是「我知道接下来要贴个大文件，先腾地方」
 *   - **不看冷却**：刚压完又压一次是用户自己的选择
 *   - **要给出结论**：压了多少、省了多少，当场说清楚；
 *     自动那次是后台行为，不打扰用户
 *
 * 硬守卫仍然生效：至少得有两轮以上对话才谈得上压缩，
 * 否则「压完只剩摘要」等于把刚问的那句话也吞了。
 *
 * 返回结构化结果而不是抛异常：渲染层要拿它拼一句中文提示。
 */
async function manualCompact(messages: ChatMessage[], sessionId: string): Promise<ManualCompactionResult> {
  const invalid = configError()
  if (invalid) return { ok: false, beforeTokens: 0, afterTokens: 0, message: invalid }

  const wire: WireMessage[] = messages.map((m) => ({ role: m.role, content: m.content }))
  const systemText = await sessionSystemPrompt(sessionId)
  // 走与自动压缩同一个注入函数：它会跳过摘要，不会把已有的摘要顶掉
  if (systemText) injectSystemPrompt(wire, systemText)

  const beforeTokens = roughTokens(flattenPrompt(wire))

  /*
   * 至少要留得下一轮完整对话才值得压。
   *
   * keepTurns=2 时，splitForCompaction 要求 user 消息 > 2 才有得切；
   * 否则 head 为空，这里直接给一句可读的说明，而不是让用户
   * 对着一个「压完了但什么都没变」的结果发懵。
   */
  const userMessages = wire.filter((m) => m.role === 'user').length
  if (userMessages <= KEEP_RECENT_USER_TURNS) {
    return {
      ok: false,
      beforeTokens,
      afterTokens: beforeTokens,
      message: `对话还很短（${userMessages} 轮），压缩会把当前话题也一起折叠掉。先多聊几轮再用 /compact。`
    }
  }

  const { head, tail } = splitForCompaction(wire)
  if (head.length === 0) {
    return {
      ok: false,
      beforeTokens,
      afterTokens: beforeTokens,
      message: '没有可压缩的内容 —— 较早的部分已经是摘要了。'
    }
  }

  logger.info('ai', `手动压缩：折叠 ${head.length} 条，保留 ${tail.length} 条`)
  const result = await summarizeForCompaction(head, sessionId)
  if (!result.ok || !result.summary) {
    return {
      ok: false,
      beforeTokens,
      afterTokens: beforeTokens,
      message: `压缩失败：${result.error || '模型没有返回摘要'}`
    }
  }

  // 与自动压缩走同一个重建函数：两处各写一遍正是上面那串 bug 的来源
  rebuildAfterCompaction(wire, summaryContent(result.summary), tail)

  const afterTokens = roughTokens(flattenPrompt(wire))

  // 手动压缩也要记压力：否则「刚手动压完、下一轮自动又压一次」
  noteCompacted(sessionId, { totalTokensAfter: afterTokens, threshold: 0, now: Date.now() })

  logger.info('ai', `手动压缩完成：约 ${beforeTokens} → ${afterTokens} token`)

  return {
    ok: true,
    beforeTokens,
    afterTokens,
    notice: { summary: result.summary, keptCount: tail.length, foldedCount: result.foldedCount },
    message: `已压缩：约 ${beforeTokens} → ${afterTokens} token（折叠 ${result.foldedCount} 条，保留最近 ${tail.length} 条）`
  }
}

export function registerAiIpc(): void {
  ipcMain.handle(IPC.aiAbort, (_e, requestId: string) => abortAi(requestId))
  ipcMain.handle(IPC.aiTest, () => testConnection())
  ipcMain.handle(IPC.aiListModels, () => listModels())
  ipcMain.handle(IPC.aiCompact, (_e, messages: ChatMessage[], sessionId?: string) =>
    manualCompact(messages, typeof sessionId === 'string' ? sessionId : '')
  )
  ipcMain.handle(IPC.aiChat, async (event, requestId: string, messages: ChatMessage[], sessionId?: string) => {
    const sender = event.sender
    const emit = (chunk: AiStreamChunk): void => {
      if (!sender.isDestroyed()) sender.send(IPC.evtAiStream, chunk)
    }
    /*
     * ⚠️ 兜底 catch：任何未预期的异常都要变成一条 **error 事件**，
     * 而不是让 IPC promise reject。
     *
     * runStream 内部大部分失败都会自己 emit error，但准备阶段
     * （建请求、拼 header、读系统提示词…）里抛出的异常没有那层保护 ——
     * 它会一路 reject 到渲染层的 await。渲染层虽然有 finally 兜住 busy 状态，
     * 但用户只会看到「突然结束」，看不到原因。
     * 这里补一条可读的 error，两端都不会留下无解释的失败。
     */
    try {
      await runStream(requestId, messages, emit, typeof sessionId === 'string' ? sessionId : '')
    } catch (err) {
      logger.error('ai', `请求 ${requestId} 异常终止: ${String(err)}`)
      emit({
        requestId,
        kind: 'error',
        message: `本次请求异常终止：${err instanceof Error ? err.message : String(err)}`
      })
      emit({ requestId, kind: 'done' })
    }
  })
}
