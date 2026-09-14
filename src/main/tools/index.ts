import type { ToolName } from '../../shared/types'
import { getCapabilityInfo } from '../capabilities'
import { logger } from '../logger'
import { FILE_TOOL_HANDLERS } from './file-tools'
import { IMPLEMENTED_TOOLS, TOOL_LABELS, TOOL_SCHEMAS, type ToolSchema } from './meta'

/**
 * 工具调度层。
 *
 * 两件事：
 *   1. 只把「当前生效」的工具定义交给模型 —— 模型看不到就不会去调
 *   2. 真正执行时再检查一次，不可用就返回可读错误（TOOL_UNAVAILABLE）
 *
 * 第 2 步不能省：模型可能凭历史上下文去调一个刚被关掉的工具，
 * 或者 full 模式下强开了本机其实不支持的工具。
 * 返回可读错误而不是静默失败，模型能自己绕开，比报一堆内部异常好。
 */

export interface ToolCallRequest {
  id: string
  name: string
  /** 模型给的原始 JSON 字符串，可能写坏 */
  arguments: string
}

export interface ToolExecResult {
  ok: boolean
  /** 回灌给模型的文本 */
  text: string
  /** 给界面的一行摘要，如「读取 hello.py」 */
  summary: string
}

/** 当前生效的工具定义，直接放进请求体的 tools 字段 */
export function toolSchemasForModel(): ToolSchema[] {
  const { effective } = getCapabilityInfo()
  return TOOL_SCHEMAS.filter((schema) => effective.includes(schema.function.name))
}

/** 从参数里拼一个给人看的短名，如「读取 hello.py」 */
function describeCall(name: string, args: Record<string, unknown>): string {
  const label = TOOL_LABELS[name as ToolName] || name
  const raw = typeof args.path === 'string' ? args.path : ''
  if (!raw) return label
  const file = raw.split(/[\\/]/).filter(Boolean).pop() || raw
  return `${label} ${file}`
}

function parseArgs(raw: string): { ok: true; args: Record<string, unknown> } | { ok: false; message: string } {
  const text = (raw || '').trim()
  if (!text) return { ok: true, args: {} }
  try {
    const parsed = JSON.parse(text) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, message: '参数应该是一个 JSON 对象' }
    }
    return { ok: true, args: parsed as Record<string, unknown> }
  } catch (err) {
    return { ok: false, message: `参数不是合法 JSON：${String(err)}` }
  }
}

/**
 * 给界面用的一行摘要。
 * 与执行无关，所以参数解不开也不报错 —— 那时退化成工具名。
 */
export function summarizeCall(name: string, rawArgs: string): string {
  let args: Record<string, unknown> = {}
  try {
    const parsed = JSON.parse(rawArgs || '{}') as unknown
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      args = parsed as Record<string, unknown>
    }
  } catch {
    /* 摘要用，解不开就算了 */
  }
  return describeCall(name, args)
}

/** 执行一次工具调用。永远不抛错 —— 错误以文本形式回灌给模型。 */
export async function executeTool(call: ToolCallRequest): Promise<ToolExecResult> {
  const name = call.name as ToolName
  const label = TOOL_LABELS[name] || call.name

  const handler = FILE_TOOL_HANDLERS[name]
  if (!handler || !IMPLEMENTED_TOOLS.includes(name)) {
    logger.warn('tool', `模型调用了未实现的工具: ${name}`)
    return {
      ok: false,
      summary: `${label}：本版本未实现`,
      text: `TOOL_UNAVAILABLE: 工具 ${name} 在当前版本中不可用，请改用其他方式完成，不要重试。`
    }
  }

  const caps = getCapabilityInfo()
  if (!caps.effective.includes(name)) {
    const reason = caps.filtered.find((item) => item.name === name)?.reason || '当前不可用'
    logger.warn('tool', `工具 ${name} 被门控拦住: ${reason}`)
    return {
      ok: false,
      summary: `${label}：不可用（${reason}）`,
      text:
        `TOOL_UNAVAILABLE: 当前环境下无法使用 ${name}（${reason}）。` +
        '请改用直接读写文件的方式完成，不要重试本工具。'
    }
  }

  const parsed = parseArgs(call.arguments)
  if (!parsed.ok) {
    return {
      ok: false,
      summary: `${label}：参数错误`,
      text: `ERROR: ${parsed.message}。请检查后重新调用。`
    }
  }

  const summary = describeCall(name, parsed.args)
  try {
    const text = await handler(parsed.args as never)
    return { ok: true, text, summary }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    logger.warn('tool', `${name} 执行失败: ${message}`)
    return { ok: false, text: `ERROR: ${message}`, summary: `${summary}（失败）` }
  }
}
