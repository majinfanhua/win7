import fs from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import { logger } from './logger'

/**
 * 命令解释器的定位。
 *
 * 单独一个模块，因为有两处要用它，而它们不该互相依赖：
 *   - capabilities.ts —— 探测「这台机器能不能执行命令」
 *   - tools/exec.ts  —— 真的去执行
 * 探测与执行对同一个问题的答案必须是同一个，写两份早晚会跑偏。
 *
 * ## 为什么默认是 cmd.exe，而不是 PowerShell
 *
 * 最初这里只找 powershell.exe，理由是「Win7 裸机只有 cmd.exe，PowerShell 要装
 * WMF 升级才有 5.1」。**那个理由站不住**：
 *   - cmd.exe 在**所有** Windows 上都有，且不需要任何假设，是最稳的基线
 *   - Win7 SP1 其实自带 PowerShell 2.0，但 2.0 与现代语法差得多
 *     （没有 `??`、没有 `-Parallel`、`ConvertFrom-Json` 行为不同），
 *     而 `[Console]::OutputEncoding` 在 2.0 上根本不生效 —— 拿它当基线反而更脆
 *   - python / node 装好后会自己写进 PATH，`cmd` 里直接敲 `python` 就能找到，
 *     不需要 PowerShell 那套 `-EncodedCommand` 机制
 *
 * 结论：**cmd.exe 是基线，PowerShell 有则作为增强**。
 * 这样 Win7 / Win10 / Win11 走同一条路径，不再有「这台机器有没有 PowerShell」
 * 的分支，Win7 也从 6 个工具变成 10 个。
 */

/** 找 cmd.exe。Windows 上它一定在，找不到说明环境异常 */
export function cmdPath(): string | null {
  if (process.platform !== 'win32') return null
  const root = process.env['SystemRoot'] || process.env['windir'] || 'C:\\Windows'
  const candidate = path.join(root, 'System32', 'cmd.exe')
  try {
    if (fs.existsSync(candidate)) return candidate
  } catch {
    /* 权限等异常当不存在处理 */
  }
  // 兜底：System32 被重定向或路径异常时，仍让系统自己去 PATH 里找
  return 'cmd.exe'
}

/**
 * 找 powershell.exe（可选增强，找不到不影响命令能力）。
 *
 * 不用 `where` 去探，直接查文件：探一次就够，且不依赖 PATH
 * （校园机器的 PATH 常被改得很奇怪）。
 */
export function powershellPath(): string | null {
  if (process.platform !== 'win32') return null
  const root = process.env['SystemRoot'] || process.env['windir'] || 'C:\\Windows'
  const candidates = [
    path.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    // 32 位进程在 64 位系统上 System32 会被重定向，这个位置兜底
    path.join(root, 'SysWOW64', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  ]
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return candidate
    } catch {
      /* 权限等异常当不存在处理 */
    }
  }
  return null
}

/** 这台机器能不能执行命令 —— capabilities.ts 与 exec.ts 共用这一个答案 */
export function shellAvailable(): boolean {
  return cmdPath() !== null
}

/** 一句话描述当前解释器，进日志与设置页 */
export function describeShell(): string {
  const cmd = cmdPath()
  if (!cmd) return '不可用（非 Windows）'
  const ps = powershellPath()
  return ps ? `cmd.exe（另有 PowerShell: ${ps}）` : 'cmd.exe'
}

/* ------------------------------------------------------------------ *
 * 临时脚本文件
 * ------------------------------------------------------------------ */

/**
 * 脚本落盘的目录。
 *
 * 放在 userData 下而不是系统 temp：教室机器的 %TEMP% 常被清理策略扫，
 * 而且杀软对「往 temp 写 .cmd 再执行」这个行为格外敏感。
 * userData 是我们自己的目录，已经证明可写（config.json 就写在那里）。
 */
function scriptDir(): string {
  return path.join(app.getPath('userData'), 'tmp-scripts')
}

let seq = 0

export interface ScriptFile {
  /** 临时 .cmd 文件的绝对路径 */
  file: string
  /** 删掉它。执行结束或超时后一定要调，否则越攒越多 */
  cleanup: () => void
}

/**
 * 把一段命令写成临时 .cmd 文件。
 *
 * ## 为什么是文件，而不是 `cmd /c "命令"`
 *
 * 直接用 `cmd /c "..."` 有三个坑，写文件一次全避开：
 *   1. **引号转义**：Node 拼参数是 C 运行时那套，cmd 有自己的解析规则，
 *      引号 / `%` / `^` 混在一起时两边对不上，会出现「在终端能跑、在这里跑不了」
 *   2. **% 变量**：cmd 会在解析阶段展开 `%VAR%`，脚本里的百分号会被提前吃掉
 *   3. **命令行长度**：CreateProcess 上限 32767 字符
 *
 * 写文件后执行的是 `cmd /c "路径"`，路径是我们自己生成的（无空格无特殊字符），
 * 根本没有需要转义的东西。
 *
 * ## chcp 65001
 *
 * 中文 Windows 的 cmd 默认代码页是 936（GBK），而 Node 按 UTF-8 解字节 ——
 * 学生 `print("你好")` 会看到满屏 `����`。
 * `chcp 65001 >nul` 把控制台切到 UTF-8，**Win7 就支持**（2000 起就有）。
 * 它必须在脚本第一行，晚于任何输出就没用了。
 *
 * `>nul` 是必须的：chcp 自己会打印一行「Active code page: 65001」，
 * 不吞掉的话它会混进结果里，模型会以为那是命令输出。
 */
export function writeScriptFile(command: string): ScriptFile {
  const dir = scriptDir()
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `run-${process.pid}-${++seq}.cmd`)

  // \r\n 换行：cmd 对 LF-only 的 .cmd 文件在某些情况下会解析异常
  const body = ['@echo off', 'chcp 65001 >nul', command, ''].join('\r\n')
  fs.writeFileSync(file, body, 'utf8')

  const cleanup = (): void => {
    try {
      fs.rmSync(file, { force: true })
    } catch {
      /* 删不掉不影响结果，残留文件在下次启动时会被清 */
    }
  }
  return { file, cleanup }
}

/**
 * 清掉上次运行留下的临时脚本。
 *
 * 异常退出（崩溃、拔电源、任务管理器结束进程）时 cleanup 跑不到，
 * 攒久了会在 userData 里堆一堆 run-*.cmd。启动时扫一次最省事。
 */
export function sweepScriptDir(): void {
  const dir = scriptDir()
  try {
    if (!fs.existsSync(dir)) return
    let removed = 0
    for (const name of fs.readdirSync(dir)) {
      if (!/^run-\d+-\d+\.cmd$/.test(name)) continue
      try {
        fs.rmSync(path.join(dir, name), { force: true })
        removed++
      } catch {
        /* 被占用就留着，下次再说 */
      }
    }
    if (removed > 0) logger.info('shell', `已清理 ${removed} 个上次残留的临时脚本`)
  } catch {
    /* 清理失败不影响启动 */
  }
}
