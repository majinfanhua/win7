import { spawn } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'
import { logger } from '../logger'
import { cmdPath, writeScriptFile } from '../shell'
import { RUN_TIMEOUT_DEFAULT_MS, RUN_TIMEOUT_MAX_MS } from './limits'

/**
 * 命令执行的底层。
 *
 * 只干一件事：把一段命令跑起来，并把输出收干净。
 * 工具层（command-tools.ts）与后台任务（jobs.ts）都从这里走 ——
 * 超时、进程树终止、输出编码、输出上限这四处每多写一遍就会多漏一处。
 *
 * ## 跑的是什么
 *
 * **cmd.exe**，语义就是「Windows 命令行」，不假装它是 Bash。
 *
 * 为什么不是 PowerShell：cmd 在**所有** Windows 上都有，不需要任何假设。
 * 一个学生装了 python / node，安装程序会把它们写进 PATH，
 * `cmd` 里直接敲 `python hello.py` 就能跑 —— 不需要 PowerShell 那套
 * `-EncodedCommand`。而 PowerShell 的版本差异（Win7 自带 2.0、
 * 现代语法要 5.1）反而是个负担。详见 src/main/shell.ts 的注释。
 *
 * 因此整组命令类工具在所有 Windows 上启用（见 src/main/capabilities.ts），
 * Win7 不再被砍掉这 4 个工具。
 */

/**
 * 一条命令的长度上限。
 *
 * 命令是写进临时 .cmd 文件再执行的，所以不受 CreateProcess 的 32767 字符
 * 限制；这里限的是「模型一次该塞多少东西进来」——超长的逻辑应该写成脚本文件，
 * 而不是塞进一次工具调用。
 */
const MAX_COMMAND_CHARS = 8_000

/** 单次执行最多保留多少字符输出（stdout 与 stderr 合并计） */
const MAX_OUTPUT_CHARS = 60_000

/** 回灌给模型的文本上限：太长的输出既烧 token 也没人看 */
const MODEL_TEXT_CHARS = 12_000
const MODEL_HEAD_CHARS = 4_000

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
export function startCommand(command: string, options: ExecOptions): ExecHandle {
  const script = (command || '').trim()
  if (!script) throw new Error('command 不能为空')
  if (script.length > MAX_COMMAND_CHARS) {
    throw new Error(
      `命令过长（${script.length} 字符，上限 ${MAX_COMMAND_CHARS}）。` +
        '请把脚本写到文件里（如 run.py / build.js），再执行那个文件。'
    )
  }

  const cmd = cmdPath()
  if (!cmd) {
    throw new Error(
      '本机没有可用的 cmd.exe，无法执行命令。' +
        '（命令执行只在 Windows 上启用；其他系统请改用直接读写文件的方式。）'
    )
  }

  /*
   * 命令写进临时 .cmd 文件再执行，而不是 `cmd /c "命令"`。
   *
   * 三个坑一次避开：引号转义（Node 是 C 运行时那套、cmd 是另一套）、
   * `%VAR%` 在解析阶段被提前展开、命令行 32767 字符上限。
   * 详细理由写在 shell.ts 的 writeScriptFile 注释里。
   *
   * chcp 65001（UTF-8）在那个文件的第一行 —— 中文 Windows 的 cmd
   * 默认是 936（GBK），不切的话学生 `print("你好")` 会看到满屏乱码。
   */
  const scriptFile = writeScriptFile(script)

  // /d 跳过 AutoRun 注册表项、/s 让 /c 后面的引号处理可预期
  const child = spawn(cmd, ['/d', '/s', '/c', scriptFile.file], {
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
      // 临时脚本用完就删。放在 settle 里而不是 close 回调里：
      // 超时被杀、spawn 失败这些路径都要走到这里，而它们未必触发 close
      scriptFile.cleanup()
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
export async function runCommand(command: string, options: ExecOptions): Promise<ExecOutcome> {
  return startCommand(command, options).wait()
}
