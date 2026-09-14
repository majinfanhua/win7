import { ipcMain, net } from 'electron'
import {
  IPC,
  type AiStreamChunk,
  type AiTestResult,
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

/** 流式对话，SSE 逐块回推给渲染进程 */
function runStream(requestId: string, messages: ChatMessage[], emit: (chunk: AiStreamChunk) => void): Promise<void> {
  const invalid = configError()
  if (invalid) {
    emit({ requestId, kind: 'error', message: invalid })
    return Promise.resolve()
  }

  const cfg = getConfig().ai
  const body = JSON.stringify({
    model: cfg.model,
    messages,
    temperature: cfg.temperature,
    stream: true
  })

  return new Promise((resolve) => {
    let settled = false
    let timer: NodeJS.Timeout

    const finish = (chunk: AiStreamChunk): void => {
      if (settled) return
      settled = true
      active.delete(requestId)
      clearTimeout(timer)
      emit(chunk)
      resolve()
    }

    let request: Electron.ClientRequest
    try {
      request = net.request({ method: 'POST', url: chatEndpoint(cfg.baseUrl), redirect: 'follow' })
    } catch (err) {
      emit({ requestId, kind: 'error', message: `请求创建失败: ${String(err)}` })
      resolve()
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
        readBody(response, (raw) => finish({ requestId, kind: 'error', message: describeHttpError(status, raw) }))
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
            finish({ requestId, kind: 'done' })
            return
          }
          try {
            const json = JSON.parse(payload) as { choices?: Array<{ delta?: { content?: string } }> }
            const delta = json.choices && json.choices[0] && json.choices[0].delta?.content
            if (delta) emit({ requestId, kind: 'delta', text: delta })
          } catch {
            /* 分片不完整，等下一个 chunk */
          }
        }
      })
      response.on('end', () => finish({ requestId, kind: 'done' }))
      response.on('error', (err: Error) =>
        finish({ requestId, kind: 'error', message: `响应中断: ${err.message}` })
      )
    })

    request.on('error', (err: Error) => finish({ requestId, kind: 'error', message: `网络错误: ${err.message}` }))
    request.write(body)
    request.end()
  })
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
