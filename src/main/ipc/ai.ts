import { ipcMain, net } from 'electron'
import {
  IPC,
  type AiStreamChunk,
  type AiTestResult,
  type AiUsage,
  type ChatMessage,
  type ModelListResult
} from '../../shared/types'
import { chatEndpoint, describeHttpError, modelsEndpoint } from '../../shared/ai-endpoint'
import { getConfig } from '../config'
import { logger } from '../logger'

/** 正在进行的流式请求，用于中断 */
const active = new Map<string, Electron.ClientRequest>()
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
  const req = active.get(requestId)
  if (!req) return false
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
function flattenPrompt(messages: ChatMessage[]): string {
  return messages.map((m) => `${m.role}\u0000${m.content}`).join('\u0001')
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
function estimateUsage(messages: ChatMessage[], completion: string): AiUsage {
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
function buildUsage(raw: RawUsage | null, messages: ChatMessage[], completion: string): AiUsage {
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

/**
 * 单次流式尝试。
 * 返回 'retry' 表示中转站不认 stream_options（HTTP 400/422），需要去掉它再试一次。
 */
function runStreamOnce(
  requestId: string,
  messages: ChatMessage[],
  emit: (chunk: AiStreamChunk) => void,
  includeUsage: boolean
): Promise<'ok' | 'retry'> {
  const cfg = getConfig().ai
  const body = JSON.stringify({
    model: cfg.model,
    messages,
    temperature: cfg.temperature,
    stream: true,
    // 只有带上它，OpenAI / DeepSeek 才会在流末尾补一块 usage
    ...(includeUsage ? { stream_options: { include_usage: true } } : {})
  })

  return new Promise((resolve) => {
    let settled = false
    let timer: NodeJS.Timeout
    let rawUsage: RawUsage | null = null
    let completionText = ''

    const finish = (chunk: AiStreamChunk): void => {
      if (settled) return
      settled = true
      active.delete(requestId)
      clearTimeout(timer)
      emit(chunk)
      resolve('ok')
    }

    /** 收尾时统一带上用量；中断 / 报错路径不给 */
    const doneChunk = (): AiStreamChunk => ({
      requestId,
      kind: 'done',
      usage: buildUsage(rawUsage, messages, completionText)
    })

    let request: Electron.ClientRequest
    try {
      request = net.request({ method: 'POST', url: chatEndpoint(cfg.baseUrl), redirect: 'follow' })
    } catch (err) {
      emit({ requestId, kind: 'error', message: `请求创建失败: ${String(err)}` })
      resolve('ok')
      return
    }

    active.set(requestId, request)
    timer = setTimeout(() => {
      try {
        request.abort()
      } catch {
        /* ignore */
      }
      finish({ requestId, kind: 'error', message: `请求超时（${CHAT_TIMEOUT_MS / 1000}s），请检查网络或中转站状态` })
    }, CHAT_TIMEOUT_MS)

    for (const [key, value] of Object.entries(buildHeaders('text/event-stream'))) request.setHeader(key, value)

    request.on('response', (response) => {
      const status = response.statusCode || 0
      if (status !== 200) {
        readBody(response, (raw) => {
          if (includeUsage && (status === 400 || status === 422)) {
            // 部分中转站不认 stream_options，去掉后重试一次，别把整个功能打挂
            logger.warn('ai', `中转站拒绝了 stream_options（HTTP ${status}），去掉该参数重试`)
            settled = true
            active.delete(requestId)
            clearTimeout(timer)
            resolve('retry')
            return
          }
          finish({ requestId, kind: 'error', message: describeHttpError(status, raw) })
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
            finish(doneChunk())
            return
          }
          try {
            const json = JSON.parse(payload) as {
              choices?: Array<{ delta?: { content?: string } }>
              usage?: RawUsage
            }
            // usage 是单独一块送来的，那时 choices 是空数组
            if (json.usage) rawUsage = json.usage
            const delta = json.choices && json.choices[0] && json.choices[0].delta?.content
            if (delta) {
              completionText += delta
              emit({ requestId, kind: 'delta', text: delta })
            }
          } catch {
            /* 分片不完整，等下一个 chunk */
          }
        }
      })
      response.on('end', () => finish(doneChunk()))
      response.on('error', (err: Error) =>
        finish({ requestId, kind: 'error', message: `响应中断: ${err.message}` })
      )
    })

    request.on('error', (err: Error) => finish({ requestId, kind: 'error', message: `网络错误: ${err.message}` }))
    request.write(body)
    request.end()
  })
}

/** 流式对话：先按带 usage 的方式请求，中转站不认就退回去重试一次 */
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

  // 先记下本次 prompt，估算缓存命中要拿它当下一轮的对比基准
  const promptText = flattenPrompt(messages)

  const first = await runStreamOnce(requestId, messages, emit, true)
  if (first === 'retry') await runStreamOnce(requestId, messages, emit, false)

  lastPromptText = promptText
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
