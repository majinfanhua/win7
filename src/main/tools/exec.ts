import { spawn } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'
import { logger } from '../logger'
import { powershellPath } from '../powershell'
import { RUN_TIMEOUT_DEFAULT_MS, RUN_TIMEOUT_MAX_MS } from './limits'

/**
 * 命令执行的底层。
 *
 * 只干一件事：把一段 PowerShell 脚本跑起来，并把输出收干净。
 * 工具层（command-tools.ts）与后台任务（jobs.ts）都从这里走 ——
 * 超时、进程树终止、输出编码、输出上限这四处每多写一遍就会多漏一处。
 *
 * 为什么跑的不是 bash：Win7 裸机只有 cmd.exe（PowerShell 要装 WMF 才有 5.1），
 * 真正的 bash 需要 WSL，而学生机不能假定有。所以语义就是「Windows 上的 PowerShell 脚本」，
 * 不假装它是 Bash。整组命令类工具也只在 Windows 10/11 上启用（见 src/main/capabilities.ts）。
 */

/**
 * 一条命令的长度上限。
 * CreateProcess 的命令行是 32767 字符，而 -EncodedCommand 是 base64（1.33 倍）+ 编码开销，
 * 这里留足余量；超长的脚本应该写成 .ps1 文件再执行。
 */
const MAX_COMMAND_CHARS = 8_000

/** 单次执行最多保留多少字符输出（stdout 与 stderr 合并计） */
const MAX_OUTPUT_CHARS = 60_000

/** 回灌给模型的文本上限：太长的输出既烧 token 也没人看 */
const MODEL_TEXT_CHARS = 12_000
const MODEL_HEAD_CHARS = 4_000

/**
 * 每次执行前先跑的几行。
 *
 * 最关键的是 OutputEncoding：中文 Windows 的默认输出代码页是 936（GBK），
 * 而 Node 按 UTF-8 解字节，不切就会得到满屏乱码 —— 学生会以为命令跑错了。
 * 拿 try/catch 包住是因为没有真实控制台句柄时这句会抛异常，
 * 但那不影响命令本身，不能因此让整条命令失败。
 */
const PREAMBLE = [
  "try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }",
  "$OutputEncoding = [System.Text.Encoding]::UTF8",
  "$ErrorActionPreference = 'Continue'",
  "$ProgressPreference = 'SilentlyContinue'"
].join('\n')

export interface ExecOutcome {
  /** 退出码；被超时或手动终止时为 null */
  exitCode: number | null
  /** 合并后的输出（stdout 在前、stderr 穿插在后） */
  output: string
  /** 是否因超时被强制终止 */
  timedOut: boolean
  /** 输出是否已达上限被截断 */
  truncated: boolean
  /** 是否由人工（jobKill）终止 */
  killed: boolean
  durationMs: number
}

export interface ExecHandle {
  /** 到目前为止的输出。任务在跑时也能拿到，后台任务就靠它做实时进度 */
  output(): string
  truncated(): boolean
  running(): boolean
  /** 最后一次收到输出的时间戳，用于判断任务是不是卡住了 */
  lastOutputAt(): number
  /** 立刻终止整棵进程树 */
  kill(): void
  /** 等进程结束。永远 resolve，不抛错 */
  wait(): Promise<ExecOutcome>
}

export interface ExecOptions {
  cwd: string
  /** 超过这个时间就杀掉整棵进程树；不传表示不限时 */
  timeoutMs?: number
}

/** 把模型给的 timeoutMs 夹到安全范围 */
export function normalizeTimeout(raw: unknown): number {
  const value = Math.floor(Number(raw) || 0)
  if (!value || value <= 0) return RUN_TIMEOUT_DEFAULT_MS
  return Math.max(1_000, Math.min(RUN_TIMEOUT_MAX_MS, value))
}

/** 超长文本只留头尾，中间标一句省略了多少 —— 报错通常在前几行或最后几行 */
export function clipForModel(text: string): string {
  if (text.length <= MODEL_TEXT_CHARS) return text
  const tailLength = MODEL_TEXT_CHARS - MODEL_HEAD_CHARS
  const omitted = text.length - MODEL_TEXT_CHARS
  return `${text.slice(0, MODEL_HEAD_CHARS)}\n…（中间省略 ${omitted} 字符）…\n${text.slice(text.length - tailLength)}`
}

/**
 * 启动一条命令。不等待，调用方自己决定是立刻等结果（runCommand）
 * 还是先收着、后面再查（jobRun）。
 */
export function startPowerShell(command: string, options: ExecOptions): ExecHandle {
  const script = (command || '').trim()
  if (!script) throw new Error('command 不能为空')
  if (script.length > MAX_COMMAND_CHARS) {
    throw new Error(
      `命令过长（${script.length} 字符，上限 ${MAX_COMMAND_CHARS}）。请把脚本先写到 .ps1 文件里，再执行那个文件。`
    )
  }

  const ps = powershellPath()
  if (!ps) {
    throw new Error(
      '本机没有可用的 powershell.exe，无法执行命令。' +
        '（Windows 7 裸机只有 cmd.exe，PowerShell 需要装 WMF 升级；本项目在 Win7 上不启用命令执行。）'
    )
  }

  /*
   * 用 -EncodedCommand 传脚本，而不是 -Command。
   *
   * Node 对参数里引号的转义是 C 运行时那一套（\" 之类），PowerShell 有自己的一套解析规则，
   * 引号、$、反引号混在一起时两边对不上，会出现「在终端里能跑、在这里跑不了」。
   * base64（UTF-16LE）传参把解析层整个绕开，也不再受命令行长度与字符集影响。
   */
  const encoded = Buffer.from(`${PREAMBLE}\n${script}`, 'utf16le').toString('base64')
  const args = [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-EncodedCommand',
    encoded
  ]

  const child = spawn(ps, args, {
    cwd: options.cwd,
    // 不弹控制台窗口：教室里突然冒出一个黑框比什么都吓人
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe']
  })

  const startedAt = Date.now()
  let output = ''
  let truncated = false
  let timedOut = false
  let killed = false
  let lastOutputAt = startedAt
  let closed = false
  let settled = false

  /*
   * 用 StringDecoder 而不是 chunk.toString('utf8')。
   * 一个中文在 UTF-8 里是 3 个字节，完全可能被切在两个 chunk 之间；
   * toString 会各自解出半个字符（变成 ），而 StringDecoder 会把尾巴留到下一块 ——
   * 学生看到的报错信息里满是问号时，根本没法判断到底是编码问题还是命令真报错了。
   */
  const decoder = new StringDecoder('utf8')

  const append = (chunk: Buffer): void => {
    lastOutputAt = Date.now()
    // 已经截断了就不再解码：大输出的命令（日志、编译）不值得为丢弃的内容烧 CPU
    if (truncated) return
    const text = decoder.write(chunk)
    if (output.length + text.length > MAX_OUTPUT_CHARS) {
      output += text.slice(0, Math.max(0, MAX_OUTPUT_CHARS - output.length))
      output += '\n…（输出超过上限，后续内容已丢弃）\n'
      truncated = true
      return
    }
    output += text
  }

  child.stdout?.on('data', append)
  child.stderr?.on('data', append)

  /**
   * 终止整棵进程树。
   *
   * 顺序不能反：先用 taskkill /T 从 powershell 的 PID 往下遍历，
   * 再考虑直接杀主进程。如果先 child.kill() 把 powershell 干掉，
   * 它启动的 python.exe / node.exe 就找不到爹了，taskkill 遍历不到它们，
   * 结果留下一堆占着端口与 CPU 的孤儿进程 —— 比不杀还难查。
   */
  let timeoutTimer: NodeJS.Timeout | null = null
  let fallbackTimer: NodeJS.Timeout | null = null

  const killTree = (): void => {
    if (closed) return
    if (process.platform === 'win32' && child.pid) {
      try {
        spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
          windowsHide: true,
          stdio: 'ignore'
        })
        // taskkill 正常在几十毫秒内结束；万一没生效（权限、杀软拦截），
        // 再兜一层直接杀主进程 —— 至少不让 powershell.exe 挂在那里
        fallbackTimer = setTimeout(() => {
          try {
            child.kill()
          } catch {
            /* ignore */
          }
        }, 1500)
        return
      } catch {
        /* taskkill 都拉不起来就只能直接杀主进程了 */
      }
    }
    try {
      child.kill()
    } catch {
      /* 已退出时 kill 会抛错，忽略 */
    }
  }

  if (options.timeoutMs && options.timeoutMs > 0) {
    timeoutTimer = setTimeout(() => {
      timedOut = true
      logger.warn('exec', `命令超时（${options.timeoutMs}ms），终止进程树: ${script.slice(0, 120)}`)
      killTree()
    }, options.timeoutMs)
  }

  const finished = new Promise<ExecOutcome>((resolve) => {
    const settle = (exitCode: number | null): void => {
      if (settled) return
      settled = true
      closed = true
      if (timeoutTimer) clearTimeout(timeoutTimer)
      if (fallbackTimer) clearTimeout(fallbackTimer)
      resolve({
        exitCode,
        output,
        timedOut,
        truncated,
        killed,
        durationMs: Date.now() - startedAt
      })
    }

    // spawn 本身失败（找不到文件、权限不够）也会走 error，这时 close 不一定来
    child.on('error', (err: Error) => {
      append(Buffer.from(`\n[无法启动] ${err.message}\n`, 'utf8'))
      settle(null)
    })
    child.on('close', (code: number | null) => settle(typeof code === 'number' ? code : null))
  })

  return {
    output: () => output,
    truncated: () => truncated,
    running: () => !closed,
    lastOutputAt: () => lastOutputAt,
    kill: () => {
      killed = true
      killTree()
    },
    wait: () => finished
  }
}

/** 启动一条命令并等它跑完。runCommand 用这个 */
export async function runPowerShell(command: string, options: ExecOptions): Promise<ExecOutcome> {
  return startPowerShell(command, options).wait()
}
