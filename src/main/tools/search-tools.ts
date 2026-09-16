import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { guardPath } from '../permissions'
import type { ToolContext } from './meta'
import { logger } from '../logger'
import { MAX_ENTRIES, MAX_LINE_CHARS, MAX_MATCHES, MAX_SCAN_BYTES, SKIP_DIRS } from './limits'

/**
 * 搜索类工具：Glob（按文件名找）与 Grep（按内容找）。
 *
 * ## 为什么自己实现匹配，不引库
 *
 * `Glob` 常规做法是引 minimatch / fast-glob，`Grep` 常规做法是引 ripgrep 二进制。
 * 两个都不引，理由不同：
 *
 *   - **fast-glob**：依赖链长（十几个包），启动时解析这些模块在 Win7 机械盘上是
 *     实打实的开销。教学项目的目录规模也用不上它的性能
 *   - **ripgrep**：每个平台一个 exe，包体积涨几 MB；更麻烦的是 Win7 上
 *     杀软对「解压出来的陌生 exe」误报率很高，学生机上一个报毒弹窗就劝退了
 *
 * 所以匹配逻辑自己写（`matchGlob` / `compileGlob`），只支持真正会用到的语法：
 * `*` `?` `**` 与字符集 `[...]`。不支持的语法（如 `{a,b}` 大括号展开）
 * 会在结果里明说 —— 静默当成字面量匹配会得到莫名其妙的结果。
 *
 * ## 为什么全是异步
 *
 * 遍历大目录用同步 API 会把主进程卡死：Win7 机械盘 + 杀软实时扫描下，
 * 一次同步遍历几万个文件足够让界面白掉几秒。全程 fsp.*。
 *
 * ## 遍历的共同约束
 *
 * 两个工具共用一套遍历骨架（`walk`），所以忽略规则、条目上限、字节上限
 * 只有一份 —— 分两处写早晚会跑偏（一个跳 node_modules 一个不跳）。
 */

export interface GlobArgs {
  pattern: string
  path?: string
}

export interface GrepArgs {
  pattern: string
  path?: string
  glob?: string
  ignoreCase?: boolean
}

/** 一次遍历的共享预算。防止「在大目录上跑一次搜索把内存吃光」 */
interface WalkBudget {
  /** 还剩多少个文件可访问 */
  filesLeft: number
  /** 还剩多少字节可读（只有 Grep 真的读内容，Glob 不消耗） */
  bytesLeft: number
  /** 是否因为预算耗尽提前停下 */
  exhausted: boolean
}

/**
 * 递归遍历目录，对每个文件调 `onFile`。
 *
 * 返回是否**完整走完**（false = 撞到上限提前停了）。调用方要把这个事实
 * 告诉模型 —— 否则模型会以为「没找到 = 不存在」，而实际是没搜完。
 */
async function walk(
  dir: string,
  budget: WalkBudget,
  onFile: (file: string) => Promise<void> | void
): Promise<void> {
  if (budget.exhausted) return
  let entries: fs.Dirent[]
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true })
  } catch {
    // 权限不足 / 目录刚被删。跳过它继续走别的，不因为一个目录让整次搜索失败
    return
  }

  // 目录优先 + 名称排序：结果稳定可比，学生两次搜索看到同样的顺序
  const sorted = entries
    .slice()
    .sort((a, b) => (a.name === b.name ? 0 : a.name.localeCompare(b.name, 'zh-Hans-CN')))

  for (const entry of sorted) {
    if (budget.exhausted) return
    const full = path.join(dir, entry.name)

    if (entry.isDirectory()) {
      // 重目录直接跳过，理由见 limits.ts 的 SKIP_DIRS
      if (SKIP_DIRS.has(entry.name)) continue
      await walk(full, budget, onFile)
      continue
    }
    if (!entry.isFile()) continue

    if (budget.filesLeft <= 0) {
      budget.exhausted = true
      return
    }
    budget.filesLeft--
    await onFile(full)
  }
}

/* ------------------------------------------------------------------ *
 * Glob 匹配
 * ------------------------------------------------------------------ */

/**
 * 把 glob 编译成正则。
 *
 * 支持的语法（覆盖实际会用到的全部）：
 *   `*`    匹配除路径分隔符外的任意字符
 *   `?`    匹配单个非分隔符字符
 *   `**`   跨目录匹配（`**​/` 前缀表示任意层级）
 *   `[...]` 字符集，支持 `[!...]` 取反
 *
 * 不支持的语法（如 `{a,b}` 大括号展开）**不会被静默当成字面量** ——
 * 见 `unsupportedSyntax()`，调用方会把这件事告诉模型。
 */
export function compileGlob(pattern: string): RegExp {
  // 统一分隔符：Windows 上是反斜杠，而模型写的通常是正斜杠
  const normalized = pattern.replace(/\\/g, '/')
  let re = ''
  let i = 0

  while (i < normalized.length) {
    const ch = normalized[i]
    if (ch === '*') {
      const isDouble = normalized[i + 1] === '*'
      if (isDouble) {
        // `**/` 匹配「任意层级，包括零层」，所以要吃掉后面的斜杠
        if (normalized[i + 2] === '/') {
          re += '(?:.*/)?'
          i += 3
          continue
        }
        re += '.*'
        i += 2
        continue
      }
      re += '[^/]*'
      i++
      continue
    }
    if (ch === '?') {
      re += '[^/]'
      i++
      continue
    }
    if (ch === '[') {
      const close = normalized.indexOf(']', i + 1)
      if (close === -1) {
        // 没有闭合的 `[` 当成字面量
        re += '\\['
        i++
        continue
      }
      let body = normalized.slice(i + 1, close)
      // `[!abc]` 是 glob 的取反写法，正则里是 `[^abc]`
      if (body.startsWith('!')) body = `^${body.slice(1)}`
      // 字符集里的 `\` 与 `]` 要转义，其余原样
      re += `[${body.replace(/\\/g, '\\\\')}]`
      i = close + 1
      continue
    }
    // 正则元字符转义
    re += ch.replace(/[.+^${}()|[\]]/g, '\\$&')
    i++
  }

  // 整串匹配（不是子串）。用 ^...$ 而不是 \b，因为路径里 `-` `.` 也算边界符
  return new RegExp(`^${re}$`, 'i')
}

/** 模型可能写出来、但我们不支持、且**必须告知**的语法 */
export function unsupportedSyntax(pattern: string): string | null {
  if (/[{}]/.test(pattern)) return '大括号展开（如 {a,b}）'
  if (/[+@?!]\(/.test(pattern)) return '扩展 glob 分组（如 @(a|b)）'
  return null
}

/**
 * 判断一个相对路径是否匹配 glob。
 *
 * 对「只有文件名、没有斜杠」的模式做特殊处理：`*.html` 应该匹配
 * `src/index.html`。这是几乎所有 glob 实现的约定，也是最符合直觉的行为 ——
 * 学生想找「所有 html」时不会愿意写 `**​/*.html`。
 */
export function matchGlob(relPath: string, pattern: string): boolean {
  const rel = relPath.replace(/\\/g, '/')
  const re = compileGlob(pattern)
  if (re.test(rel)) return true
  // 模式里没有斜杠时，再拿 basename 比一次
  if (!pattern.includes('/') && !pattern.includes('\\')) {
    return re.test(rel.slice(rel.lastIndexOf('/') + 1))
  }
  return false
}

/* ------------------------------------------------------------------ *
 * Glob 工具
 * ------------------------------------------------------------------ */

export async function globTool(args: GlobArgs, ctx: ToolContext = {}): Promise<string> {
  const pattern = typeof args.pattern === 'string' ? args.pattern.trim() : ''
  if (!pattern) throw new Error('pattern 不能为空，例如 **/*.html')

  const unsupported = unsupportedSyntax(pattern)
  if (unsupported) {
    throw new Error(
      `暂不支持 ${unsupported} 这种写法。本项目只支持 * ? ** 与 [abc] 字符集，` +
        '请换一种写法（例如把 {a,b} 拆成两次搜索）。'
    )
  }

  // 搜索是只读操作：写=false。搜索起点默认当前工作区根
  const root = await guardPath(args.path || '.', {
    sessionId: ctx.sessionId,
    action: `搜索起点 ${args.path || '(当前工作区)'}`
  })
  const stat = await fsp.stat(root).catch(() => null)
  if (!stat) throw new Error(`路径不存在：${root}`)
  if (!stat.isDirectory()) throw new Error(`${root} 不是目录，Glob 只能搜索目录`)

  const budget: WalkBudget = { filesLeft: MAX_ENTRIES, bytesLeft: MAX_SCAN_BYTES, exhausted: false }
  const hits: string[] = []

  await walk(root, budget, (file) => {
    const rel = path.relative(root, file)
    if (matchGlob(rel, pattern)) hits.push(rel.replace(/\\/g, '/'))
  })

  logger.info('tool', `glob: ${pattern} → ${hits.length} 个匹配（遍历上限${budget.exhausted ? '已触达' : '未触达'}）`)

  if (hits.length === 0) {
    return budget.exhausted
      ? `没找到匹配 ${pattern} 的文件，但**本次遍历已达上限**（检查了 ${MAX_ENTRIES} 个条目）——` +
          '可能还有没搜到的地方。可以缩小 path 范围后重试。'
      : `没有匹配 ${pattern} 的文件（已完整遍历 ${root}）。`
  }

  hits.sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'))
  const shown = hits.slice(0, MAX_MATCHES)
  const head =
    `在 ${root} 下找到 ${hits.length} 个匹配 ${pattern} 的文件` +
    (hits.length > shown.length ? `（只列出前 ${MAX_MATCHES} 个）` : '') +
    (budget.exhausted ? '（遍历已达上限，可能还有遗漏）' : '')
  return `${head}\n-----\n${shown.join('\n')}`
}

/* ------------------------------------------------------------------ *
 * Grep 工具
 * ------------------------------------------------------------------ */

/** 一个二进制文件的判定：前 8KB 里出现 NUL 字节 */
function looksBinary(buf: Buffer): boolean {
  const end = Math.min(buf.length, 8192)
  for (let i = 0; i < end; i++) if (buf[i] === 0) return true
  return false
}

export async function grepTool(args: GrepArgs, ctx: ToolContext = {}): Promise<string> {
  const pattern = typeof args.pattern === 'string' ? args.pattern.trim() : ''
  if (!pattern) throw new Error('pattern 不能为空，要搜的正则表达式')

  let re: RegExp
  try {
    // 不加 g 标志：我们用 test 逐行判断，带 g 会让 lastIndex 在行间残留
    re = new RegExp(pattern, args.ignoreCase ? 'i' : '')
  } catch (err) {
    throw new Error(`正则表达式不合法：${String(err)}`)
  }

  const root = await guardPath(args.path || '.', {
    sessionId: ctx.sessionId,
    action: `搜索起点 ${args.path || '(当前工作区)'}`
  })
  const stat = await fsp.stat(root).catch(() => null)
  if (!stat) throw new Error(`路径不存在：${root}`)

  const globFilter = typeof args.glob === 'string' ? args.glob.trim() : ''
  const budget: WalkBudget = { filesLeft: MAX_ENTRIES, bytesLeft: MAX_SCAN_BYTES, exhausted: false }
  const results: string[] = []
  let matchedFiles = 0
  let matchCount = 0
  let skippedBinary = 0

  const scanOne = async (file: string): Promise<void> => {
    if (matchCount >= MAX_MATCHES || budget.bytesLeft <= 0) {
      budget.exhausted = true
      return
    }
    const rel = path.relative(root, file)
    if (globFilter && !matchGlob(rel, globFilter)) return

    let text: string
    try {
      const buf = await fsp.readFile(file)
      if (looksBinary(buf)) {
        skippedBinary++
        return
      }
      budget.bytesLeft -= buf.length
      text = buf.toString('utf8')
    } catch {
      // 读不了（被占用、权限）就跳过，不因为一个文件让整次搜索失败
      return
    }

    const lines = text.split('\n')
    const fileHits: string[] = []
    for (let i = 0; i < lines.length; i++) {
      if (matchCount >= MAX_MATCHES) {
        budget.exhausted = true
        break
      }
      // 每行重置 lastIndex，防止带 g 的正则在多次 test 之间状态残留
      re.lastIndex = 0
      if (!re.test(lines[i])) continue
      matchCount++
      const shown = lines[i].length > MAX_LINE_CHARS ? `${lines[i].slice(0, MAX_LINE_CHARS)}…` : lines[i]
      fileHits.push(`${i + 1}: ${shown.trim()}`)
    }

    if (fileHits.length > 0) {
      matchedFiles++
      results.push(`【${rel.replace(/\\/g, '/')}】\n${fileHits.join('\n')}`)
    }
  }

  if (stat.isDirectory()) {
    await walk(root, budget, scanOne)
  } else {
    await scanOne(root)
  }

  logger.info(
    'tool',
    `grep: ${pattern} → ${matchCount} 处匹配 / ${matchedFiles} 个文件` +
      `（跳过二进制 ${skippedBinary}）`
  )

  if (matchedFiles === 0) {
    return budget.exhausted
      ? `没找到匹配 ${pattern} 的内容，但**本次搜索已达上限** —— 可能还有没搜到的地方，` +
          '可以缩小 path 范围或加 glob 过滤后重试。'
      : `没有匹配 ${pattern} 的内容（已完整搜索 ${root}）。`
  }

  const head =
    `在 ${root} 下匹配 ${pattern}：${matchedFiles} 个文件、共 ${matchCount} 处` +
    (budget.exhausted ? '（已达上限，结果可能不完整，建议缩小范围）' : '') +
    (skippedBinary > 0 ? `（跳过 ${skippedBinary} 个二进制文件）` : '')
  return `${head}\n-----\n${results.join('\n\n')}`
}
