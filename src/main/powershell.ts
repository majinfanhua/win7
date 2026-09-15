import fs from 'node:fs'
import path from 'node:path'

/**
 * 命令解释器的定位。
 *
 * 单独一个模块，是因为有两处要用它，而它们不该互相依赖：
 *   - capabilities.ts —— 探测「这台机器能不能执行命令」
 *   - tools/exec.ts  —— 真的去执行
 * 探测与执行对同一个问题的答案必须是同一个，写两份早晚会跑偏。
 */

/**
 * 找 powershell.exe。
 *
 * 不用 `where` 命令去探，直接查文件：探一次就够了，而且不依赖 PATH
 * （校园机器的 PATH 常被改得很奇怪）。
 *
 * 返回 null 有三种情况，对调用方是同一个结论「这台机器没有可用的命令解释器」：
 * 非 Windows、Win7 裸机（只有 cmd.exe）、Win10 精简版缺组件。
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
