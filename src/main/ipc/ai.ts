import { StringDecoder } from 'node:string_decoder'
import { ipcMain, net } from 'electron'
import {
  IPC,
  textOf,
  type AiStreamChunk,
  type AiTestResult,
  type AiUsage,
  type ChatContent,
  type ChatMessage,
  type ModelListResult
} from '../../shared/types'
import { chatEndpoint, describeHttpError, modelsEndpoint } from '../../shared/ai-endpoint'
import { getConfig } from '../config'
import {
  isModelKnown,
  PRUNE_MINIMUM_TOKENS,
  resolveBudgetForModel,
  resolveThreshold
} from '../compaction-policy'
import { getCapabilityInfo } from '../capabilities'
import { sessionSystemPrompt } from '../system-doc'
import { buildHeaders, configError } from '../llm'
import { recordUsage } from '../usage'
import { executeTool, summarizeCall, toolSchemasForModel } from '../tools'
import { collectMcpTools, ensureMcpStarted } from '../mcp/manager'
import {
  describeTruncatedCall,
  ToolArgumentTracker,
  type TruncationReport
} from '../tools/argument-guard'
import { logger } from '../logger'

/** 正在进行的流式请求，用于中断 */
const active = new Map<string, Electron.ClientRequest>()

/**
 * 被用户点了「停止」的请求。
 * 光 abort 掉当前那条 HTTP 请求不够 —— 工具循环可能正在执行工具，
 * 执行完还会再发一轮请求，所以循环里每轮都要看一眼这个标记。
 */
const aborted = new Set<string>()

const CHAT_TIMEOUT_MS = 120_000
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
    let timer: NodeJS.Timeout
    let rawUsage: RawUsage | null = null
    let completionText = ''
    const calls = new Map<number, WireToolCall>()
    // 记录参数分片原文，用于识别「参数没传完」的截断调用。
    // 必须在这里顺手记：拼好的 arguments 已经丢掉了分片边界，
    // 事后再看无法区分真截断和「累计快照流」。
    const argTracker = new ToolArgumentTracker()

    const settle = (result: RoundResult): void => {
      if (settled) return
      settled = true
      active.delete(requestId)
      clearTimeout(timer)
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
    timer = setTimeout(() => {
      try {
        request.abort()
      } catch {
        /* ignore */
      }
      settle({
        kind: 'error',
        message: `请求超时（${CHAT_TIMEOUT_MS / 1000}s），请检查网络或中转站状态`
      })
    }, CHAT_TIMEOUT_MS)

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
              choices?: Array<{ delta?: { content?: string; tool_calls?: RawToolCallDelta[] } }>
              usage?: RawUsage
            }
            // usage 是单独一块送来的，那时 choices 是空数组
            if (json.usage) rawUsage = json.usage
            const delta = json.choices && json.choices[0] && json.choices[0].delta
            if (!delta) continue
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

    request.on('error', (err: Error) => settle({ kind: 'error', message: `网络错误: ${err.message}` }))
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
    const systemIndex = wire.findIndex((m) => m.role === 'system')
    if (systemIndex >= 0) wire[systemIndex] = { role: 'system', content: systemText }
    else wire.unshift({ role: 'system', content: systemText })
  } else if (wire.every((m) => m.role !== 'system')) {
    // 组装失败（极端情况）时退回渲染层发来的那份，而不是发一个没有 system 的请求
    logger.warn('ai', '系统提示词组装失败，本次对话不带 system prompt')
  }

  // 先记下本次 prompt，估算缓存命中要拿它当下一轮请求的对比基准。
  // 放在补完 system 之后：否则算出来的前缀与真正发出去的不一致
  const promptText = flattenPrompt(wire)

  // 发出去之前先算一次预算。撑爆窗口就在这里拦住并说清原因，
  // 别让用户对着中转站那句 "context length exceeded" 发懵
  const overBudget = checkContextBudget(wire)
  if (overBudget) {
    logger.warn('ai', `上下文超出预算，已拒绝本次请求: 约 ${roughTokens(promptText)} token`)
    emit({ requestId, kind: 'error', message: overBudget })
    return
  }

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
    request.on('error', (err: Error) => done({ ok: false, detail: `网络错误: ${err.message}` }))
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
    request.on('error', (err: Error) => done({ ok: false, models: [], detail: `网络错误: ${err.message}` }))
    request.end()
  })
}

export function registerAiIpc(): void {
  ipcMain.handle(IPC.aiAbort, (_e, requestId: string) => abortAi(requestId))
  ipcMain.handle(IPC.aiTest, () => testConnection())
  ipcMain.handle(IPC.aiListModels, () => listModels())
  ipcMain.handle(IPC.aiChat, async (event, requestId: string, messages: ChatMessage[], sessionId?: string) => {
    const sender = event.sender
    await runStream(
      requestId,
      messages,
      (chunk) => {
        if (!sender.isDestroyed()) sender.send(IPC.evtAiStream, chunk)
      },
      typeof sessionId === 'string' ? sessionId : ''
    )
  })
}
