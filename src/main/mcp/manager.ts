import { getConfig, setConfig } from '../config'
import { logger } from '../logger'
import { McpConnection, type McpServerConfig, type McpServerState, type McpToolDef } from './client'

/**
 * MCP 服务器的生命周期管理。
 *
 * 职责三件：
 *   1. 按配置建连接（启动 / 停止 / 重连）
 *   2. 把「服务器 id + 工具名」拼成**全局唯一的工具名**给模型用
 *   3. 把模型的调用分发回对应连接
 *
 * ## 为什么工具名要加前缀
 *
 * 两个服务器可能都提供一个叫 `search` 的工具。直接暴露原名的话，
 * 模型调 `search` 时分不清是哪个 —— 而错调一个工具往往不是报错，
 * 是**静默地用错的数据源**。所以暴露成 `mcp__<serverId>__<tool>`。
 *
 * 用双下划线而不是单个：MCP 工具名本身可能含下划线（`read_file`），
 * 单下划线会让「从哪切开」变得有歧义。双下划线是约定俗成的分隔符。
 *
 * ## 为什么是懒启动
 *
 * 应用启动时不连 —— MCP 服务器通常是 npx 拉包，冷启动好几秒，
 * 会让应用开屏明显变慢，而用户可能压根不用。所以：
 *   - 启动时只建对象，不 spawn
 *   - 第一次有对话要用工具时（ensureStarted）才真正拉起
 */

/** 工具名前缀分隔符。见上面的说明 */
const SEP = '__'
const PREFIX = 'mcp'

export function mcpServers(): McpServerConfig[] {
  return getConfig().mcp?.servers || []
}

/** 连接池：serverId → 连接 */
const connections = new Map<string, McpConnection>()

/** 全局唯一的工具名 → 归属 */
export interface McpToolRoute {
  serverId: string
  /** 服务器那边的原始工具名 */
  original: string
  def: McpToolDef
}

export function mcpToolName(serverId: string, tool: string): string {
  return `${PREFIX}${SEP}${serverId}${SEP}${tool}`
}

/**
 * 解析一个带前缀的工具名。
 *
 * 返回 null 表示「这不是 MCP 工具」。注意要**从右往左**找最后一个分隔符：
 * serverId 里不该有双下划线（写入时校验过），但工具名可能有，
 * 所以 serverId 取第一个分隔符之后、最后一个分隔符之前的那一段会更稳。
 * 这里约束 serverId 不含双下划线，所以从左切是安全的 —— 校验见 setServers。
 */
export function parseMcpToolName(name: string): { serverId: string; tool: string } | null {
  if (!name.startsWith(`${PREFIX}${SEP}`)) return null
  const rest = name.slice(PREFIX.length + SEP.length)
  const idx = rest.indexOf(SEP)
  if (idx <= 0) return null
  return { serverId: rest.slice(0, idx), tool: rest.slice(idx + SEP.length) }
}

/**
 * 取（必要时建）一个连接。**不启动**，只保证对象在。
 */
function connectionOf(config: McpServerConfig): McpConnection {
  const existing = connections.get(config.id)
  if (existing) return existing
  const conn = new McpConnection(config)
  connections.set(config.id, conn)
  return conn
}

/**
 * 确保所有启用的服务器都已启动并拿到工具列表。
 *
 * 这个方法在**每次取工具表时**被调用，所以必须便宜：
 * 已就绪的连接直接返回，只有没启动过的才会真的 spawn（并且只 spawn 一次）。
 *
 * 一个服务器起不来**不影响其他服务器**，也不影响内置工具 ——
 * 记下错误状态、继续。这是「外部依赖不该拖垮主体」的基本要求。
 */
export async function ensureMcpStarted(): Promise<void> {
  const configs = mcpServers().filter((s) => s.enabled)
  await Promise.all(
    configs.map(async (cfg) => {
      const conn = connectionOf(cfg)
      const st = conn.getState()
      // 已就绪 / 正在启动中的不重复拉。error 状态也不自动重试（由用户显式重连）
      if (st.status === 'ready' || st.status === 'starting') return
      if (st.status === 'error') return
      try {
        await conn.start()
      } catch {
        /* 失败状态已经记在连接里，由设置页显示 */
      }
    })
  )
}

/**
 * 收集所有已就绪服务器提供的工具。
 *
 * 工具名冲突的处理：同名时**后来的跳过**并记日志。
 * 不覆盖的原因同「工具名前缀」那段 —— 静默顶掉一个工具比少一个更难发现。
 */
export function collectMcpTools(): McpToolRoute[] {
  const out: McpToolRoute[] = []
  const seen = new Set<string>()
  for (const cfg of mcpServers()) {
    if (!cfg.enabled) continue
    const conn = connections.get(cfg.id)
    if (!conn) continue
    const st = conn.getState()
    if (st.status !== 'ready') continue
    for (const def of st.tools) {
      const full = mcpToolName(cfg.id, def.name)
      if (seen.has(full)) {
        logger.warn('mcp', `工具名冲突，已跳过：${full}`)
        continue
      }
      seen.add(full)
      out.push({ serverId: cfg.id, original: def.name, def })
    }
  }
  return out
}

/** 调用一个 MCP 工具。路由由工具名里的前缀决定 */
export async function callMcpTool(
  fullName: string,
  args: Record<string, unknown>
): Promise<string> {
  const parsed = parseMcpToolName(fullName)
  if (!parsed) throw new Error(`不是 MCP 工具名：${fullName}`)
  const conn = connections.get(parsed.serverId)
  if (!conn) throw new Error(`MCP 服务器「${parsed.serverId}」没有连接（可能已被移除）`)
  return conn.callTool(parsed.tool, args)
}

/** 每个服务器的状态，给设置页显示 */
export function mcpStates(): Array<{ config: McpServerConfig; state: McpServerState }> {
  return mcpServers().map((config) => {
    const conn = connections.get(config.id)
    return {
      config,
      state: conn ? conn.getState() : { status: 'stopped' as const, detail: '未启动', tools: [] }
    }
  })
}

/** 显式重连一个服务器（设置页的「连接 / 重连」按钮） */
export async function reconnectMcp(id: string): Promise<void> {
  const cfg = mcpServers().find((s) => s.id === id)
  if (!cfg) throw new Error(`没有这个 MCP 服务器：${id}`)
  connections.get(id)?.stop()
  connections.delete(id)
  const conn = connectionOf(cfg)
  await conn.start()
}

/** 停掉一个并移出连接池（删除服务器时调） */
export function disposeMcp(id: string): void {
  connections.get(id)?.stop()
  connections.delete(id)
}

/**
 * 写回服务器配置。
 *
 * 校验两件事：
 *   - id 不含双下划线（否则工具名前缀的切分会出错，见 parseMcpToolName）
 *   - id 不重复
 * 校验放在写入侧而不是读取侧：配置一旦落盘就到处在用，
 * 在那里挡比在每个使用点判断便宜。
 */
export function setMcpServers(servers: McpServerConfig[]): void {
  for (const s of servers) {
    if (s.id.includes(SEP)) {
      throw new Error(`MCP 服务器 id 不能包含「${SEP}」：${s.id}（它是工具名的分隔符）`)
    }
  }
  const ids = servers.map((s) => s.id)
  if (new Set(ids).size !== ids.length) throw new Error('MCP 服务器 id 不能重复')

  // 删掉的服务器要停掉进程，否则会留下孤儿进程
  const alive = new Set(ids)
  for (const id of [...connections.keys()]) {
    if (!alive.has(id)) disposeMcp(id)
  }
  setConfig({ mcp: { servers } })
}

/** 退出应用时全部停掉。不调的话会留下孤儿子进程 */
export function stopAllMcp(): void {
  for (const [, conn] of connections) conn.stop()
  connections.clear()
}
