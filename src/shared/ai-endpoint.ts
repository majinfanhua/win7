/**
 * 中转站地址归一化。
 *
 * 用户从各家中转站拿到的地址形式不统一，常见四种：
 *   https://relay.example.com
 *   https://relay.example.com/v1
 *   https://relay.example.com/v1/
 *   https://relay.example.com/v1/chat/completions
 * 统一收敛成 https://relay.example.com/v1，再拼各自的路径。
 */
export function normalizeBaseUrl(raw: string): string {
  let base = (raw || '').trim().replace(/\/+$/, '')
  if (!base) return ''

  // 允许用户直接粘贴完整端点
  base = base.replace(/\/chat\/completions$/i, '').replace(/\/models$/i, '')
  if (!/\/v\d+$/i.test(base)) base = `${base}/v1`
  return base
}

export function chatEndpoint(baseUrl: string): string {
  const base = normalizeBaseUrl(baseUrl)
  return base ? `${base}/chat/completions` : ''
}

export function modelsEndpoint(baseUrl: string): string {
  const base = normalizeBaseUrl(baseUrl)
  return base ? `${base}/models` : ''
}

/**
 * 把中转站返回的 HTTP 错误翻译成能直接给用户看的中文。
 * 中转站最常见的几类失败都在这里了。
 */
export function describeHttpError(status: number, body: string): string {
  const snippet = (body || '').slice(0, 300)
  switch (status) {
    case 401:
      return `401 鉴权失败：密钥无效或已过期，请检查设置里的 API Key（${snippet}）`
    case 402:
      return `402 余额不足：中转站账户额度已用完（${snippet}）`
    case 403:
      return `403 无权访问：密钥可能不允许调用该模型（${snippet}）`
    case 404:
      return `404 地址或模型不存在：请确认接口地址是 OpenAI 兼容的 /v1 端点，且模型名正确（${snippet}）`
    case 429:
      return `429 触发限流：请求过于频繁，稍后重试（${snippet}）`
    default:
      if (status >= 500) return `${status} 中转站服务异常：请稍后重试（${snippet}）`
      return `HTTP ${status}: ${snippet}`
  }
}
