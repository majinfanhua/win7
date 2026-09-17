import { net } from 'electron'
import { StringDecoder } from 'node:string_decoder'
import { chatEndpoint, describeHttpError } from '../shared/ai-endpoint'
import { textOf, type ChatContent, type AiUsage } from '../shared/types'
import { getConfig } from './config'
import { logger } from './logger'

/**
 * 一次性的模型调用（非流式）。
 *
 * 与 ipc/ai.ts 的流式对话是两条路：
 *   - 流式的走 SSE，要处理分片、工具调用、中断，是给用户看的
 *   - 这里的是一次问一句、拿回一段文本就完事，是给**后台任务**用的
 *     （目前只有「归档总结」，以后可能有「自动起标题」）
 *
 * 为什么不复用流式那套：后台任务没人盯着，不需要逐字显示；
 * 而 SSE 解析要多写一百多行分片拼接逻辑，失败面只会更大。
 * 用最小的请求形态，出错也最容易定位。
 *
 * ## 为什么单独一个模块
 *
 * 请求头、端点归一化、错误翻译这三件事，流式与非流式必须完全一致 ——
 * 否则会出现「测试连接能用、总结却 401」这类只在一条路上复现的怪问题。
 * 所以它们在这里只写一份，两条路都从这里取。
 */

/**
 * 拼请求头。extraHeaders 用于兼容各类中转站的自定义鉴权要求。
 *
 * 注意：Electron 22 主进程的 Node 是 16.x，没有全局 fetch，
 * 因此统一使用 Electron 的 net 模块（走 Chromium 网络栈，自动继承系统代理）。
 */
export function buildHeaders(accept: string): Record<string, string> {
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

/** 配置不完整时给出能直接照做的提示。完整返回 null */
export function configError(): string | null {
  const { baseUrl, apiKey, model } = getConfig().ai
  if (!baseUrl.trim()) return '尚未配置接口地址，请在「设置 → AI 设定」中填写中转站地址。'
  if (!apiKey.trim()) return '尚未配置 API Key，请在「设置 → AI 设定」中填写。'
  if (!model.trim()) return '尚未选择模型，请在「设置 → AI 设定」中点“拉取模型列表”后选择。'
  return null
}

/** 发出去的消息。tool 角色只用于流式那条路，这里用不到 */
export interface LlmMessage {
  role: 'system' | 'user' | 'assistant'
  content: ChatContent | null
}

export interface LlmToolSchema {
  type: 'function'
  function: { name: string; description: string; parameters: Record<string, unknown> }
}

/** 中转站返回的 usage 原始形状，各家字段名不统一，全都要接住 */
interface RawUsage {
  prompt_tokens?: number
  completion_tokens?: number
  prompt_cache_hit_tokens?: number
  prompt_tokens_details?: { cached_tokens?: number }
}

export interface LlmResult {
  ok: boolean
  text: string
  usage: AiUsage
  error?: string
}

function emptyUsage(): AiUsage {
  return {
    promptTokens: 0,
    completionTokens: 0,
    cachedTokens: 0,
    cacheHitRate: 0,
    source: 'estimate'
  }
}

/**
 * 从原始 usage 里取缓存命中数。
 *
 * 字段名各家不同，且都要能缺省：
 *   - OpenAI / 多数中转站：`prompt_tokens_details.cached_tokens`
 *   - DeepSeek：`prompt_cache_hit_tokens`（顶层）
 * 取不到就返回 0，而不是估算 —— 缓存命中数估不出来，
 * 猜一个数字只会让统计变成假的。
 */
function cachedTokensFrom(raw: RawUsage): number {
  const nested = raw.prompt_tokens_details?.cached_tokens
  if (typeof nested === 'number' && nested >= 0) return nested
  if (typeof raw.prompt_cache_hit_tokens === 'number' && raw.prompt_cache_hit_tokens >= 0) {
    return raw.prompt_cache_hit_tokens
  }
  return 0
}

export interface CallOptions {
  messages: LlmMessage[]
  /** 输出上限。留空则由中转站按模型默认值决定 */
  maxTokens?: number
  /** 温度。总结类任务用低温度更稳定 */
  temperature?: number
  /**
   * 一起发出去的工具定义。
   *
   * 归档总结会带上它 —— 不是为了真调工具，而是为了**让请求前缀
   * 与原对话完全一致**，从而命中 prompt 缓存（详见 archive.ts）。
   */
  tools?: LlmToolSchema[]
  timeoutMs?: number
}

const DEFAULT_TIMEOUT_MS = 60_000

/**
 * 调一次模型，拿回完整文本。
 *
 * 任何失败都收敛成 `{ ok: false, error }` 而**不抛异常** ——
 * 调用方都是后台任务，抛出去只会变成一个没人接的 unhandled rejection。
 */
export function callModelOnce(opts: CallOptions): Promise<LlmResult> {
  const invalid = configError()
  if (invalid) return Promise.resolve({ ok: false, text: '', usage: emptyUsage(), error: invalid })

  const cfg = getConfig().ai
  const body = JSON.stringify({
    model: cfg.model,
    messages: opts.messages,
    temperature: opts.temperature ?? cfg.temperature,
    stream: false,
    ...(opts.maxTokens ? { max_tokens: opts.maxTokens } : {}),
    ...(opts.tools && opts.tools.length > 0 ? { tools: opts.tools } : {})
  })

  return new Promise((resolve) => {
    let settled = false
    let request: Electron.ClientRequest
    try {
      request = net.request({ method: 'POST', url: chatEndpoint(cfg.baseUrl), redirect: 'follow' })
    } catch (err) {
      resolve({ ok: false, text: '', usage: emptyUsage(), error: `请求创建失败: ${String(err)}` })
      return
    }

    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
    const done = (result: LlmResult): void => {
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
      done({
        ok: false,
        text: '',
        usage: emptyUsage(),
        error: `请求超时（${timeoutMs / 1000}s）`
      })
    }, timeoutMs)

    for (const [key, value] of Object.entries(buildHeaders('application/json'))) {
      request.setHeader(key, value)
    }

    request.on('response', (response) => {
      const status = response.statusCode || 0
      let raw = ''
      // 同上：网络分块会切断多字节字符，必须用 StringDecoder
      const decoder = new StringDecoder('utf8')
      response.on('data', (chunk) => {
        raw += decoder.write(chunk)
      })
      response.on('end', () => {
        if (status !== 200) {
          done({ ok: false, text: '', usage: emptyUsage(), error: describeHttpError(status, raw) })
          return
        }
        try {
          const json = JSON.parse(raw) as {
            choices?: Array<{ message?: { content?: unknown } }>
            usage?: RawUsage
          }
          const content = json.choices?.[0]?.message?.content
          const text = typeof content === 'string' ? content : textOf(content as ChatContent)
          const usageRaw = json.usage
          if (!usageRaw) {
            done({ ok: true, text, usage: emptyUsage() })
            return
          }
          const promptTokens = Math.max(0, Math.floor(Number(usageRaw.prompt_tokens) || 0))
          const completionTokens = Math.max(0, Math.floor(Number(usageRaw.completion_tokens) || 0))
          const cachedTokens = cachedTokensFrom(usageRaw)
          done({
            ok: true,
            text,
            usage: {
              promptTokens,
              completionTokens,
              cachedTokens,
              cacheHitRate: promptTokens > 0 ? cachedTokens / promptTokens : 0,
              source: 'api'
            }
          })
        } catch (err) {
          done({ ok: false, text: '', usage: emptyUsage(), error: `响应解析失败: ${String(err)}` })
        }
      })
      response.on('error', (err: Error) => {
        done({ ok: false, text: '', usage: emptyUsage(), error: `网络错误: ${err.message}` })
      })
    })
    request.on('error', (err: Error) => {
      done({ ok: false, text: '', usage: emptyUsage(), error: `网络错误: ${err.message}` })
    })

    logger.debug('llm', `非流式请求：${opts.messages.length} 条消息，模型 ${cfg.model}`)
    request.write(body)
    request.end()
  })
}
