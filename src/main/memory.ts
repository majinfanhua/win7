import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { app } from 'electron'
import { redactSecrets, scanSecrets } from '../shared/secret-scan'
import { logger } from './logger'

/**
 * 持久记忆：一份用户能直接打开看的 Markdown。
 *
 * ## 为什么是 Markdown 文件而不是数据库
 *
 * 记忆这种东西最怕「用户不知道它记了什么」。存进 SQLite 或向量库之后，
 * 用户对它的唯一接口就是这个应用的界面 —— 而界面总会漏掉一些东西
 * （比如某条记忆的原文、为什么这么记）。存成 Markdown 的好处是：
 *   - 用户可以用记事本打开、直接改、直接删
 *   - 出问题时能一眼看出「它记错了什么」，而不是面对一个黑盒
 *   - 换机器时拷一个文件夹就是完整迁移
 *
 * 这个思路来自 OpenClaw：**工作区里的纯文本文件是唯一真相**，
 * 索引 / 向量只是加速手段，丢了也能从文本重建。
 *
 * ## 两个文件的分工
 *
 *   - `MEMORY.md`     长期记忆，精选过的、跨会话仍然成立的（用户是谁、
 *                     他的偏好、项目的关键约定）。AI 主动写
 *   - `YYYY-MM-DD.md` 当天流水，随手记。攒多了由 AI（或用户）整理进 MEMORY.md
 *
 * 分开的理由：如果只有一个文件，AI 每次「记住一件事」都要重写整份记忆，
 * 而重写有风险（模型改写时可能丢掉旧内容）。流水文件只追加，
 * 不存在丢掉旧内容的可能；精选文件才需要改写，而它改动的频率低得多。
 *
 * ## 为什么记忆不进 system prompt
 *
 * 记忆是**频繁变化**的内容。放进 system prompt 的话，AI 每记一件事，
 * 下次请求的前缀就变了，整个会话的 prompt 缓存全部失效 ——
 * 而这个应用的对话通常很长，重新计算缓存的代价远大于记忆带来的好处。
 *
 * 所以记忆只通过工具暴露（memoryGet / memoryWrite）：工具调用与结果
 * 出现在对话的**末尾**，前面稳定的部分照样命中缓存。
 * 这与「设置项可以随便改、改了缓存失效无所谓」是两件事 ——
 * 设置一天改不了几次，记忆一次对话里可能改好几次。
 */

/** 单个记忆文件的字节上限。超了就拒绝继续追加，逼用户整理 */
const MEMORY_MAX_BYTES = 256 * 1024

/** 长期记忆的文件名。全大写是为了在文件管理器里一眼看到 */
export const LONG_TERM_FILE = 'MEMORY.md'

export function memoryDir(): string {
  return path.join(app.getPath('userData'), 'memory')
}

export function longTermPath(): string {
  return path.join(memoryDir(), LONG_TERM_FILE)
}

/**
 * 当天流水文件名。
 *
 * 日期由调用方传入而不是在这里取 `new Date()`：
 * 这样这个模块的输入完全由参数决定，测试与「补记昨天的内容」都好写。
 */
export function dailyPath(day: string): string {
  const safe = /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : new Date().toISOString().slice(0, 10)
  return path.join(memoryDir(), `${safe}.md`)
}

/** 本地时区 YYYY-MM-DD。与 usage.ts 的算法一致（同一天的记忆不该分到两天里） */
export function today(at: Date = new Date()): string {
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`
}

async function readIfExists(target: string): Promise<string | null> {
  try {
    return await fsp.readFile(target, 'utf8')
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code !== 'ENOENT') logger.warn('memory', `读取记忆失败 ${target}: ${String(err)}`)
    return null
  }
}

/**
 * 追加写。
 *
 * 用 appendFile 而不是「读出来 + 拼上 + 整份覆盖」：
 * 后者在两次操作之间丢一行就永久丢了，而记忆是只增不减的东西，
 * 丢一行的代价很高。appendFile 在多数文件系统上对小于一页的写入是原子的。
 *
 * 上限检查在写之前做：超过上限就抛错，让模型知道「该整理了」，
 * 而不是默默写失败 —— 静默失败会让模型以为记住了。
 */
async function appendTo(target: string, block: string, header: string): Promise<void> {
  await fsp.mkdir(path.dirname(target), { recursive: true })
  const existing = await readIfExists(target)
  const base = existing === null ? `${header}\n` : existing
  if (Buffer.byteLength(base, 'utf8') + Buffer.byteLength(block, 'utf8') > MEMORY_MAX_BYTES) {
    throw new Error(
      `${path.basename(target)} 已经达到 ${Math.round(MEMORY_MAX_BYTES / 1024)} KB 上限，` +
        '请先把它整理精简一下（合并重复的、删掉过期的），再继续追加。'
    )
  }
  await fsp.appendFile(target, block, 'utf8')
}

/**
 * 写一条记忆。
 *
 * ## 敏感信息在这里拦
 *
 * 记忆是**长期保留**的，而且以后每次对话都可能被读出来发给模型。
 * 所以一段密钥一旦进来，就等于永久泄露 + 持续外发。
 * 这不是「建议不要」，是必须拦住 —— 见 shared/secret-scan.ts 的设计说明。
 *
 * 拒绝而不是脱敏：脱敏会让模型以为「记下了但不显示」，
 * 而它其实该做的是**换个方式记**（记「用户配了某个 key」而不是记值）。
 */
export async function writeMemory(input: {
  content: string
  /** long = 长期记忆，daily = 当天流水。默认 daily */
  target?: 'long' | 'daily'
  day?: string
  at?: Date
}): Promise<{ ok: true; path: string; text: string }> {
  const content = (input.content || '').trim()
  if (!content) throw new Error('要记的内容是空的。')

  const scan = scanSecrets(content)
  if (scan.hits.length > 0) {
    // 错误信息里**不带原文**，否则密钥就跟着错误信息进了对话上下文
    throw new Error(
      `检测到 ${scan.labels.join('、')}，已拒绝写入长期记忆。` +
        '这类内容会一直留在磁盘上，并且以后每次对话都可能被发出去。' +
        '请只记「用户配置了某个服务的密钥」这件事，不要记具体的值。'
    )
  }

  const at = input.at || new Date()
  const target = input.target === 'long' ? 'long' : 'daily'
  const stamp = `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`

  if (target === 'long') {
    const file = longTermPath()
    await appendTo(
      file,
      `- ${content}\n`,
      '# 长期记忆\n\n<!-- AI 长期记住的事。可以自己编辑：删掉不想要的、改掉记错的。 -->\n'
    )
    logger.info('memory', `写入长期记忆（${content.length} 字）`)
    return { ok: true, path: file, text: `已记入长期记忆（${path.basename(file)}）。` }
  }

  const day = input.day || today(at)
  const file = dailyPath(day)
  await appendTo(file, `- ${stamp} ${content}\n`, `# ${day}\n`)
  logger.info('memory', `写入当日记忆 ${day}（${content.length} 字）`)
  return { ok: true, path: file, text: `已记入 ${day} 的流水（${path.basename(file)}）。` }
}

/**
 * 读记忆。
 *
 * `target`：
 *   - long  只读长期记忆
 *   - daily 只读某天的流水（默认今天）
 *   - all   长期记忆 + 今天流水（最常用：开始对话时先看一遍）
 *
 * 返回脱敏后的内容。
 *
 * ## 为什么要脱敏「读」
 *
 * 用户完全可以自己打开 MEMORY.md 手写一段密钥进去 —— 写入时的扫描
 * 拦不住手写。而读出来的内容会进对话上下文、被发到中转站。
 * 所以读这条路上再扫一次。这是**唯一**能兜住手写内容的关口。
 */
export async function readMemory(input: {
  target?: 'long' | 'daily' | 'all'
  day?: string
}): Promise<{ text: string; paths: string[]; redacted: number }> {
  const target = input.target || 'all'
  const day = input.day || today()
  const wanted: string[] = []
  if (target === 'long' || target === 'all') wanted.push(longTermPath())
  if (target === 'daily' || target === 'all') wanted.push(dailyPath(day))

  const parts: string[] = []
  const paths: string[] = []
  let redacted = 0

  for (const file of wanted) {
    const content = await readIfExists(file)
    if (content === null) continue
    paths.push(file)
    const safe = redactSecrets(content)
    redacted += safe.redacted
    parts.push(`===== ${path.basename(file)} =====\n${safe.text.trimEnd()}`)
  }

  if (parts.length === 0) {
    return {
      text:
        '目前没有任何记忆。这是正常的 —— 值得长期记住的事（用户的偏好、' +
        '项目的关键约定）才需要写进来，随手可查的东西不用记。',
      paths: [],
      redacted: 0
    }
  }

  let text = parts.join('\n\n')
  if (redacted > 0) {
    text += `\n\n（读取时隐去了 ${redacted} 处疑似密钥的内容。原文仍在文件里，如需处理请提醒用户自行删除。）`
  }
  return { text, paths, redacted }
}

/** 记忆文件的概览，用于设置页与工具里的「有哪些记忆」 */
export async function listMemory(): Promise<
  Array<{ name: string; path: string; bytes: number; updatedAt: string }>
> {
  const dir = memoryDir()
  try {
    const names = await fsp.readdir(dir)
    const out: Array<{ name: string; path: string; bytes: number; updatedAt: string }> = []
    for (const name of names) {
      if (!name.endsWith('.md')) continue
      const full = path.join(dir, name)
      try {
        const stat = await fsp.stat(full)
        out.push({
          name,
          path: full,
          bytes: stat.size,
          updatedAt: stat.mtime.toISOString()
        })
      } catch {
        /* 单个文件读不到就跳过 */
      }
    }
    // 长期记忆排最前（它最重要），其余按名字倒序（日期新的在前）
    return out.sort((a, b) => {
      if (a.name === LONG_TERM_FILE) return -1
      if (b.name === LONG_TERM_FILE) return 1
      return b.name.localeCompare(a.name)
    })
  } catch {
    return []
  }
}

/** 记忆目录是否存在（首次使用时不存在，设置页据此显示「还没有记忆」） */
export function memoryDirExists(): boolean {
  try {
    return fs.statSync(memoryDir()).isDirectory()
  } catch {
    return false
  }
}
