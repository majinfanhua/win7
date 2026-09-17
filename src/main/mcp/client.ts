import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { logger } from '../logger'

/**
 * MCP（Model Context Protocol）客户端：stdio 传输。
 *
 * ## 协议是什么
 *
 * MCP 用 **JSON-RPC 2.0** 通信，一行一个 JSON 消息（换行分隔）。
 * 一个典型会话：
 *
 *   → {"jsonrpc":"2.0","id":1,"method":"initialize","params":{...}}
 *   ← {"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2024-11-05",...}}
 *   → {"jsonrpc":"2.0","method":"notifications/initialized"}
 *   → {"jsonrpc":"2.0","id":2,"method":"tools/list"}
 *   ← {"jsonrpc":"2.0","id":2,"result":{"tools":[{"name":"...","inputSchema":{...}}]}}
 *   → {"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"...","arguments":{...}}}
 *   ← {"jsonrpc":"2.0","id":3,"result":{"content":[{"type":"text","text":"..."}]}}
 *
 * ## 为什么自己实现，不用官方 SDK
 *
 * `@modelcontextprotocol/sdk` 依赖链很长（zod、express、各种 transport），
 * 而这里只需要 **stdio 一个传输**、只需要 **tools 一种能力**。
 * 本项目对依赖体积敏感（Win7 机械盘 + 杀软扫描，启动解析依赖是实打实的开销），
 * 自己写协议层的收益大于风险：协议本身很小，就是上面那几行。
 *
 * 代价是以后 MCP 加新能力（resources / prompts）要自己补，
 * 但当前需求就是「把外部工具接进来」，够用。
 *
 * ## 消息分帧
 *
 * 子进程的 stdout 是**字节流**，一次 data 事件可能拿到半条消息、
 * 也可能拿到三条半。所以必须自己缓冲区、按换行切、把最后不完整的一段留着。
 * 这个逻辑写错了会表现为「偶尔解析失败」，很难查 —— 所以下面写得很直白。
 */

/** 一个 MCP 工具的原始定义（协议字段名照抄，不做改名） */
export interface McpToolDef {
  name: string
  description?: string
  inputSchema?: Record<string, unknown>
}

export interface McpServerConfig {
  /** 唯一 id，也是工具名前缀的来源 */
  id: string
  /** 展示名 */
  name: string
  /** 启动命令，如 `npx` */
  command: string
  /** 命令参数，如 `["-y","@modelcontextprotocol/server-filesystem","/tmp"]` */
  args: string[]
  /** 额外环境变量 */
  env?: Record<string, string>
  /** 是否启用 */
  enabled: boolean
}

export type McpStatus = 'stopped' | 'starting' | 'ready' | 'error'

export interface McpServerState {
  status: McpStatus
  /** 状态说明（错误原因 / 工具数） */
  detail: string
  tools: McpToolDef[]
}

/** 一次请求的等待上限。MCP 服务器慢启动时 initialize 可能要几秒 */
const REQUEST_TIMEOUT_MS = 30_000
/** startup 后多久没响应就认为起不来 */
const INIT_TIMEOUT_MS = 20_000

interface Pending {
  resolve: (value: unknown) => void
  reject: (err: Error) => void
  timer: NodeJS.Timeout
}

/**
 * 一个 MCP 服务器连接。
 *
 * 生命周期：start() → ready → callTool()* → stop()
 * 断线或出错后**不自动重连** —— 那会让「配错了命令」表现为反复重启刷日志。
 * 由设置页的「重连」按钮显式触发。
 */
export class McpConnection {
  private child: ChildProcessWithoutNullStreams | null = null
  private nextId = 1
  private pending = new Map<number, Pending>()
  private state: McpServerState = { status: 'stopped', detail: '未启动', tools: [] }
  /** stdout 分帧缓冲 */
  private buffer = ''

  constructor(private readonly config: McpServerConfig) {}

  getState(): McpServerState {
    return { ...this.state, tools: [...this.state.tools] }
  }

  private setState(status: McpStatus, detail: string, tools = this.state.tools): void {
    this.state = { status, detail, tools }
  }

  /**
   * 启动并完成 initialize 握手。
   *
   * 任何一步失败都要把子进程杀掉 —— 留着半个进程会让下次 start()
   * 面对一个已存在的 child，行为不可预期。
   */
  async start(): Promise<void> {
    if (this.child) return
    this.setState('starting', '正在启动…')
    this.buffer = ''

    try {
      /*
       * shell: false —— 不要让命令经 shell 解析。
       * 用户填的 args 里若有空格或引号，走 shell 会被二次解释，
       * 表现为「命令行里能跑、这里报奇怪的错」。直接 exec 更可预期。
       */
      const child = spawn(this.config.command, this.config.args, {
        env: { ...process.env, ...(this.config.env || {}) },
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true
      })
      this.child = child

      child.stdout.setEncoding('utf8')
      child.stdout.on('data', (chunk: string) => this.onData(chunk))

      /*
       * stderr 只记日志、不参与协议。
       * MCP 服务器普遍把启动信息与错误打在 stderr 上，
       * 丢掉它会让「起不来」变成没有任何线索的失败。
       */
      child.stderr.setEncoding('utf8')
      child.stderr.on('data', (chunk: string) => {
        const text = String(chunk).trim()
        if (text) logger.info('mcp', `[${this.config.id}] ${text.slice(0, 500)}`)
      })

      child.on('error', (err) => {
        // 命令不存在 / 无执行权限都在这里
        this.fail(`启动失败：${err.message}`)
      })
      child.on('exit', (code, signal) => {
        // 主动 stop() 时 child 已被置空，不会走到这条分支
        if (!this.child) return
        this.fail(`进程退出（code=${code ?? 'null'}${signal ? `, signal=${signal}` : ''}）`)
      })

      await this.handshake(INIT_TIMEOUT_MS)
    } catch (err) {
      this.fail(err instanceof Error ? err.message : String(err))
      this.kill()
      throw err instanceof Error ? err : new Error(String(err))
    }
  }

  /**
   * initialize 握手 + 拉工具列表。
   *
   * 超时是必须的：MCP 服务器可能挂在那里既不响应也不退出，
   * 没有超时的话 start() 会永远不 resolve，设置页一直显示「正在启动」。
   */
  private async handshake(timeoutMs: number): Promise<void> {
    const init = this.request(
      'initialize',
      {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        clientInfo: { name: 'hangkeIDE', version: '0.2.1' }
      },
      timeoutMs
    )
    await init

    /*
     * 按协议要求补发 initialized 通知。
     * 它是**通知**（没有 id），服务器不回，所以只写不等。
     */
    this.notify('notifications/initialized')

    const listed = (await this.request('tools/list', {}, timeoutMs)) as {
      tools?: McpToolDef[]
    }
    const tools = Array.isArray(listed?.tools) ? listed.tools : []
    this.setState('ready', `已连接，${tools.length} 个工具`, tools)
    logger.info('mcp', `[${this.config.id}] 就绪，工具：${tools.map((t) => t.name).join(', ') || '（无）'}`)
  }

  /** 把子进程判为失败并清空 pending */
  private fail(reason: string): void {
    this.setState('error', reason, [])
    logger.warn('mcp', `[${this.config.id}] ${reason}`)
    for (const [, p] of this.pending) {
      clearTimeout(p.timer)
      p.reject(new Error(reason))
    }
    this.pending.clear()
    this.child = null
  }

  /**
   * 分帧：按换行切 JSON。
   *
   * 关键在最后一行 —— 它可能是**半条消息**，必须留在缓冲里等下一个 chunk。
   * 直接 JSON.parse 所有行的话，每次恰好被截断的那条都会报解析错。
   */
  private onData(chunk: string): void {
    this.buffer += chunk
    const lines = this.buffer.split('\n')
    this.buffer = lines.pop() || ''
    for (const line of lines) {
      const text = line.trim()
      if (!text) continue
      let msg: { id?: number; result?: unknown; error?: { message?: string } }
      try {
        msg = JSON.parse(text)
      } catch {
        // 服务器可能打了非协议内容到 stdout。记一条就够，不要刷屏
        logger.info('mcp', `[${this.config.id}] 忽略无法解析的输出: ${text.slice(0, 200)}`)
        continue
      }
      // 没有 id 的是通知（如日志），当前不需要处理
      if (typeof msg.id !== 'number') continue
      const p = this.pending.get(msg.id)
      if (!p) continue
      this.pending.delete(msg.id)
      clearTimeout(p.timer)
      if (msg.error) p.reject(new Error(msg.error.message || '未知错误'))
      else p.resolve(msg.result)
    }
  }

  private write(obj: unknown): void {
    const child = this.child
    if (!child || child.killed) throw new Error('MCP 连接不可用')
    child.stdin.write(`${JSON.stringify(obj)}\n`)
  }

  private request(method: string, params: unknown, timeoutMs = REQUEST_TIMEOUT_MS): Promise<unknown> {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`${method} 超时（${timeoutMs}ms）`))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      try {
        this.write({ jsonrpc: '2.0', id, method, params })
      } catch (err) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(err instanceof Error ? err : new Error(String(err)))
      }
    })
  }

  private notify(method: string, params?: unknown): void {
    try {
      this.write({ jsonrpc: '2.0', method, ...(params ? { params } : {}) })
    } catch {
      /* 通知失败不致命：真正的失败会在后续 request 上暴露 */
    }
  }

  /**
   * 调用一个工具。
   *
   * MCP 的返回是 `content` 数组（可能是 text / image / resource），
   * 这里只取 text 部分拼起来 —— 模型能读的就是文本。
   * 非文本内容明确标注出来，而不是静默丢掉：
   * 「这个工具返回了一张图，我看不到」比「返回空」有用得多。
   */
  async callTool(name: string, args: Record<string, unknown>): Promise<string> {
    if (this.state.status !== 'ready') {
      throw new Error(`MCP 服务器「${this.config.name}」未就绪（${this.state.detail}）`)
    }
    const result = (await this.request('tools/call', { name, arguments: args })) as {
      content?: Array<{ type?: string; text?: string }>
      isError?: boolean
    }

    const parts: string[] = []
    for (const item of result?.content || []) {
      if (item?.type === 'text' && typeof item.text === 'string') parts.push(item.text)
      else if (item?.type === 'image') parts.push('[图片内容，文本界面无法显示]')
      else if (item?.type) parts.push(`[${item.type} 类型的内容，暂不支持显示]`)
    }
    const body = parts.join('\n').trim() || '（工具没有返回内容）'
    // isError 是协议字段，表示「工具自己报告失败」
    return result?.isError ? `工具报告失败：${body}` : body
  }

  /** 停掉子进程并清空状态 */
  stop(): void {
    this.kill()
    this.setState('stopped', '未启动', [])
  }

  private kill(): void {
    const child = this.child
    this.child = null
    if (!child) return
    try {
      child.kill()
    } catch {
      /* 已经退出了 */
    }
    for (const [, p] of this.pending) {
      clearTimeout(p.timer)
      p.reject(new Error('连接已关闭'))
    }
    this.pending.clear()
  }
}
