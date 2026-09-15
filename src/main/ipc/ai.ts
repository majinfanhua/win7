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
import { getCapabilityInfo } from '../capabilities'
import { describeRuntimesForModel, detectRuntimes } from '../runtimes'
import { executeTool, summarizeCall, toolSchemasForModel } from '../tools'
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

/**
 * 拼请求头。extraHeaders 用于兼容各类中转站的自定义鉴权要求。
 * 注意：Electron 22 主进程的 Node 是 16.x，没有全局 fetch，
 * 因此统一使用 Electron 的 net 模块（走 Chromium 网络栈，自动继承系统代理）。
 */
function buildHeaders(accept: string): Record<string, string> {
  const { apiKey, extraHeaders } = getConfig().ai
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: accept,
    Authorization: `Bearer ${apiKey}`
  }
  for (const [key, value] of Object.entries(extraHeaders || {})) {
    if (key.trim()) headers[key.trim()] = value
  }
  return headers
}

/** 配置不完整时给出能直接照做的提示 */
function configError(): string | null {
  const { baseUrl, apiKey, model } = getConfig().ai
  if (!baseUrl.trim()) return '尚未配置接口地址，请在「设置 → AI 模型」中填写中转站地址。'
  if (!apiKey.trim()) return '尚未配置 API Key，请在「设置 → AI 模型」中填写。'
  if (!model.trim()) return '尚未选择模型，请在「设置 → AI 模型」中点“拉取模型列表”后选择。'
  return null
}

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
  stream.on('data', (chunk) => {
    raw += chunk.toString('utf8')
  })
  stream.on('end', () => done(raw))
  stream.on('error', () => done(raw))
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
  | { kind: 'tools'; calls: WireToolCall[]; usage: AiUsage; text: string }
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
      if (list.length > 0) settle({ kind: 'tools', calls: list, usage, text: completionText })
      else settle({ kind: 'final', usage })
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
      response.on('data', (chunk) => {
        buffer += chunk.toString('utf8')
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
  emit: (chunk: AiStreamChunk) => void
): Promise<void> {
  const invalid = configError()
  if (invalid) {
    emit({ requestId, kind: 'error', message: invalid })
    return
  }

  aborted.delete(requestId)

  /*
   * 把本机装了哪些运行时补进 system prompt。
   *
   * 在主进程做而不是渲染层：探测逻辑（detectRuntimes）在这里，
   * 而且结果要跟着**请求**走 —— 学生换了机器上的 python 版本，
   * 重开应用就生效，不需要去改设置里的 system prompt 文本。
   *
   * 拼接而不是替换：用户自己写的 system prompt 一个字都不动，
   * 只在末尾补一段事实。这样「设置里能看到我写了什么」仍然成立。
   */
  const wire: WireMessage[] = messages.map((m) => ({ role: m.role, content: m.content }))
  const systemIndex = wire.findIndex((m) => m.role === 'system')
  if (systemIndex >= 0) {
    try {
      const runtimes = await detectRuntimes()
      const extra = describeRuntimesForModel(runtimes)
      if (extra) {
        const current = wire[systemIndex].content
        const text = typeof current === 'string' ? current : textOf(current ?? '')
        wire[systemIndex] = { role: 'system', content: `${text}\n\n${extra}` }
      }
    } catch (err) {
      // 探测失败不该让对话发不出去 —— 退化成「没有这段提示」而已
      logger.warn('ai', `运行时探测失败，本次对话不带环境提示: ${String(err)}`)
    }
  }

  // 先记下本次 prompt，估算缓存命中要拿它当下一轮请求的对比基准。
  // 放在补完 system 之后：否则算出来的前缀与真正发出去的不一致
  const promptText = flattenPrompt(wire)

  let includeUsage = true
  let useTools = toolSchemasForModel().length > 0
  if (useTools) {
    const caps = getCapabilityInfo()
    logger.info('ai', `本次对话启用 ${caps.effective.length} 个工具: ${caps.effective.join(', ')}`)
  } else {
    logger.info('ai', '本次对话未启用工具（当前环境/设置下无可用工具）')
  }

  // 多轮之间用量累加：一次提问可能包含好几次 HTTP 往返，看到的应该是总数
  const total = { promptTokens: 0, completionTokens: 0, cachedTokens: 0, fromApi: false }
  const addUsage = (usage: AiUsage): void => {
    total.promptTokens += usage.promptTokens
    total.completionTokens += usage.completionTokens
    total.cachedTokens += usage.cachedTokens
    if (usage.source === 'api') total.fromApi = true
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
      return
    }

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

      const outcome = await executeTool({ id: call.id, name, arguments: rawArgs })

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
  ipcMain.handle(IPC.aiChat, async (event, requestId: string, messages: ChatMessage[]) => {
    const sender = event.sender
    await runStream(requestId, messages, (chunk) => {
      if (!sender.isDestroyed()) sender.send(IPC.evtAiStream, chunk)
    })
  })
}
