import type { ToolName } from '../../shared/types'
import { getCapabilityInfo } from '../capabilities'
import { logger } from '../logger'
import { callMcpTool, collectMcpTools, mcpToolName, parseMcpToolName } from '../mcp/manager'
import { COMMAND_TOOL_HANDLERS } from './command-tools'
import { FILE_TOOL_HANDLERS } from './file-tools'
import { SESSION_TOOL_HANDLERS } from './session-tools'
import {
  IMPLEMENTED_TOOLS,
  TOOL_LABELS,
  TOOL_SCHEMAS,
  type ToolContext,
  type ToolSchema
} from './meta'
export type { ToolContext }

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

/**
 * 当前生效的工具定义，直接放进请求体的 tools 字段。
 *
 * 两部分拼起来：
 *   1. 内置工具 —— 用封闭的 ToolName 过滤（门控已经在 capabilities 里算过）
 *   2. MCP 工具 —— 运行时从已连接的服务器拿，**名字动态**
 *
 * 第 2 部分是这个文件里唯一「名字不受类型系统保护」的地方，
 * 所以下面单独写着，并在调度处（executeTool）用同一套前缀解析回来。
 */
export function toolSchemasForModel(): ToolSchema[] {
  const { effective } = getCapabilityInfo()
  const builtin = TOOL_SCHEMAS.filter((schema) =>
    effective.includes(schema.function.name as ToolName)
  )

  /*
   * MCP 工具只在服务器**已就绪**时出现。
   *
   * 这里不主动去连接（那会让每次取工具表都变成可能几秒的等待）——
   * 启动由 ensureMcpStarted() 在对话开始前调用一次。
   * 没就绪就不给模型看：与其给它一个必然失败的工具，不如让它先用内置能力。
   */
  const mcp = collectMcpTools().map((route) => ({
    type: 'function' as const,
    function: {
      name: mcpToolName(route.serverId, route.original),
      description:
        (route.def.description || `来自 MCP 服务器「${route.serverId}」的工具`).trim() +
        `\n（外部工具，由 MCP 服务器 ${route.serverId} 提供）`,
      // inputSchema 是协议字段名，OpenAI 要的是 parameters，形状本来就一致
      parameters: (route.def.inputSchema as Record<string, unknown>) || {
        type: 'object',
        properties: {}
      }
    }
  }))

  return [...builtin, ...mcp]
}

/**
 * 全部已实现工具的实作表。
 * 与 IMPLEMENTED_TOOLS 是同一份名单的两个面：前者给门控用，后者给调度用。
 */
const HANDLERS: Record<string, (args: never, ctx?: ToolContext) => Promise<string>> = {
  ...FILE_TOOL_HANDLERS,
  ...COMMAND_TOOL_HANDLERS,
  ...SESSION_TOOL_HANDLERS
}

/** 摘要里一个参数值最多显示多少字，多了会把对话面板那一行挤爆 */
const SUMMARY_VALUE_CHARS = 48

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text
}

/** 从参数里拼一个给人看的短名，如「读取 hello.py」「执行命令 npm test」 */
function describeCall(name: string, args: Record<string, unknown>): string {
  const label = TOOL_LABELS[name as ToolName] || name

  // 文件类：只显示文件名。整条路径会把侧栏那一行挤没，而文件名已经够定位了
  const raw = typeof args.path === 'string' ? args.path : ''
  if (raw) {
    const file = raw.split(/[\\/]/).filter(Boolean).pop() || raw
    return `${label} ${file}`
  }

  // 命令类：显示命令本身。学生会想看到 AI 到底在跑什么
  const command = typeof args.command === 'string' ? args.command.trim() : ''
  if (command) return `${label} ${clip(command.replace(/\s+/g, ' '), SUMMARY_VALUE_CHARS)}`

  // 后台任务：显示任务号
  const id = typeof args.id === 'string' ? args.id.trim() : ''
  if (id) return `${label} ${clip(id, SUMMARY_VALUE_CHARS)}`

  // 检索类：显示关键词。没有关键词时只显示工具名（「翻归档会话」）
  const keyword = typeof args.keyword === 'string' ? args.keyword.trim() : ''
  if (keyword) return `${label} ${clip(keyword, SUMMARY_VALUE_CHARS)}`

  /*
   * 记忆类：显示记的内容开头。
   *
   * 这一条对用户很重要 —— 「记一笔」是唯一会**长期留存**内容的工具，
   * 用户需要在对话面板上直接看到「它到底记了什么」，
   * 而不是只有一个「记一笔」然后去翻文件。
   */
  const content = typeof args.content === 'string' ? args.content.trim() : ''
  if (content) return `${label} ${clip(content.replace(/\s+/g, ' '), SUMMARY_VALUE_CHARS)}`

  return label
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

/**
 * 执行一次工具调用。永远不抛错 —— 错误以文本形式回灌给模型。
 *
 * `ctx.sessionId` 用参数传递而不是模块级变量：一次对话里模型可能并发
 * 发起多个工具调用（见 ai.ts 的 for 循环），模块级变量会被相邻请求覆盖 ——
 * 表现是「A 会话批准了，B 会话的工具跟着放行」，属于静默的权限泄漏。
 */
export async function executeTool(
  call: ToolCallRequest,
  ctx: ToolContext = {}
): Promise<ToolExecResult> {
  /*
   * MCP 工具先分流。
   *
   * 它们的名字是运行时才知道的，不在 ToolName 里，也不在这张 HANDLERS 表里 ——
   * 所以必须在走内置那套「未实现 / 被门控」判断**之前**处理，
   * 否则每个 MCP 调用都会被当成「本版本未实现」。
   *
   * 前缀解析用 manager 里的同一个函数（不要在这里自己切字符串）：
   * 分隔符约定只有一处定义，两边各切一次迟早不一致。
   */
  const mcpRoute = parseMcpToolName(call.name)
  if (mcpRoute) {
    const parsedMcp = parseArgs(call.arguments)
    if (!parsedMcp.ok) {
      return {
        ok: false,
        summary: `${call.name}：参数错误`,
        text: `ERROR: ${parsedMcp.message}。请检查后重新调用。`
      }
    }
    const mcpLabel = `MCP ${mcpRoute.serverId}/${mcpRoute.tool}`
    try {
      const text = await callMcpTool(call.name, parsedMcp.args)
      return { ok: true, text, summary: mcpLabel }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      logger.warn('tool', `${call.name} 执行失败: ${message}`)
      // MCP 服务器可能已经被停掉/改了配置，所以明确提示「不要重试」，
      // 否则模型会对着一个死连接反复尝试
      return {
        ok: false,
        text: `ERROR: ${message}。这个外部工具当前不可用，请不要重试；改用内置工具完成，或告诉用户去设置里检查 MCP 服务器。`,
        summary: `${mcpLabel}（失败）`
      }
    }
  }

  const name = call.name as ToolName
  const label = TOOL_LABELS[name] || call.name

  const handler = HANDLERS[name]
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
    const text = await handler(parsed.args as never, ctx as never)
    return { ok: true, text, summary }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    logger.warn('tool', `${name} 执行失败: ${message}`)
    return { ok: false, text: `ERROR: ${message}`, summary: `${summary}（失败）` }
  }
}
