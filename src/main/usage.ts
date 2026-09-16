import fs from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import {
  USAGE_KEEP_DAYS,
  USAGE_MODELS_MAX,
  type UsageBucket,
  type UsageByDay,
  type UsageByModel,
  type UsageStats
} from '../shared/types'
import { logger } from './logger'

/**
 * token 用量统计。
 *
 * ## 设计取舍
 *
 * ### 1. 逐日聚合，不存每一条请求
 *
 * 「每一条请求都记下来」能画出很细的图，但代价是文件会无限增长，
 * 而且用户真正想知道的问题只有三个：
 *   - 今天用了多少（会不会把额度聊爆）
 *   - 这一周的趋势（是不是越来越费）
 *   - 缓存命中率高不高（省钱手段有没有生效）
 * 这三个问题按天聚合就够答了。所以内存里只保留 `days[YYYY-MM-DD]`，
 * 一天一个桶，文件大小与使用时长无关（恒定几十行）。
 *
 * ### 2. 估算值与实际值分开记
 *
 * 中转站不回 usage 时，代码会按字数估算。这类数字误差可能有几倍，
 * 混进总数会让「今天 12.3 万 token」这个看起来精确的数字其实一半是猜的。
 * 所以每个桶都带 `estimatedRequests`，界面可以标注「其中 N 次为估算」。
 *
 * ### 3. 写盘用「防抖 + 原子替换」
 *
 * 一次对话会产生好几次 HTTP 往返，每次都要落盘的话，
 * 一个长对话会写几十次几百字节的小文件。用 2 秒防抖合并成一次。
 * 代价是「刚聊完就断电」会丢最后两秒的统计 —— 这个功能不是账本，
 * 丢一点无所谓，不值得为它同步写盘。
 *
 * ### 4. 写失败只记日志，不影响对话
 *
 * 统计是**旁路**。磁盘满了、文件被占用，都不该让用户发不出消息。
 * 所有写路径都吞掉异常。
 */

/** 逐日数据。key 是 YYYY-MM-DD（本地时区） */
type DayMap = Record<string, UsageBucket>

/** 按模型累计（不按天拆）。够回答「哪个模型最费」 */
type ModelMap = Record<string, UsageBucket>

interface UsageFile {
  version: 1
  /** 全部历史合计，避免每次启动都要把所有天加起来 */
  days: DayMap
  models: ModelMap
}

let cache: UsageFile | null = null
let flushTimer: NodeJS.Timeout | null = null

/** 合并写盘的防抖窗口 */
const FLUSH_DEBOUNCE_MS = 2_000

function usagePath(): string {
  return path.join(app.getPath('userData'), 'usage.json')
}

/**
 * 本地时区的 YYYY-MM-DD。
 *
 * 用本地时区而不是 UTC：用户看「今天用了多少」时的「今天」
 * 是他手表上的今天。用 UTC 的话，晚上 8 点之后在东八区会被算成第二天，
 * 统计页会显示成「今天 0」而实际上刚聊了一大段。
 */
export function dayKey(at: Date = new Date()): string {
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`
}

function emptyBucket(): UsageBucket {
  return { requests: 0, estimatedRequests: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0 }
}

/** 收敛一个从磁盘读来的桶：字段可能缺失、可能是负数、可能是字符串 */
function normalizeBucket(raw: unknown): UsageBucket {
  const input = (raw && typeof raw === 'object' ? raw : {}) as Partial<UsageBucket>
  const num = (value: unknown): number => {
    const n = Number(value)
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0
  }
  return {
    requests: num(input.requests),
    estimatedRequests: num(input.estimatedRequests),
    promptTokens: num(input.promptTokens),
    completionTokens: num(input.completionTokens),
    cachedTokens: num(input.cachedTokens)
  }
}

function load(): UsageFile {
  if (cache) return cache
  try {
    const raw = JSON.parse(fs.readFileSync(usagePath(), 'utf8')) as Partial<UsageFile>
    const days: DayMap = {}
    for (const [key, value] of Object.entries(raw.days || {})) {
      // 只认形状对的 key，避免脏数据把统计页搞成 NaN
      if (/^\d{4}-\d{2}-\d{2}$/.test(key)) days[key] = normalizeBucket(value)
    }
    const models: ModelMap = {}
    for (const [key, value] of Object.entries(raw.models || {})) {
      if (key) models[key] = normalizeBucket(value)
    }
    cache = { version: 1, days, models }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code && code !== 'ENOENT') logger.warn('usage', `用量统计读取失败，已从零开始: ${String(err)}`)
    cache = { version: 1, days: {}, models: {} }
  }
  return cache
}

/**
 * 落盘。原子替换：写 .tmp 再 rename。
 * 直接覆写的话，写到一半断电会留下坏 JSON，
 * 而坏 JSON 会让下次启动把**全部历史**丢掉（load 的 catch 从零开始）。
 *
 * 用同步写而不是 atomic-file.ts 里的异步版本：这个函数是从
 * `app.on('before-quit')` 里调的，那个时机里 Promise 不保证能跑完，
 * 异步写有概率被进程退出打断 —— 而「退出前把最后两秒写下去」
 * 正是这个函数存在的唯一理由。写的是一个几百字节的文件，阻塞可以忽略。
 *
 * tmp 名字带 pid 与时间戳：开发时同时跑 dev 与打包版（两个进程）
 * 时不会用同一个临时文件互相覆盖。
 */
function flushNow(): void {
  if (!cache) return
  const target = usagePath()
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(tmp, JSON.stringify(cache), 'utf8')
    fs.renameSync(tmp, target)
  } catch (err) {
    try {
      fs.rmSync(tmp, { force: true })
    } catch {
      /* 清理失败无所谓 */
    }
    logger.warn('usage', `用量统计写入失败（不影响对话）: ${String(err)}`)
  }
}

function scheduleFlush(): void {
  if (flushTimer) return
  flushTimer = setTimeout(() => {
    flushTimer = null
    flushNow()
  }, FLUSH_DEBOUNCE_MS)
  // 不阻止进程退出：统计丢最后两秒可以接受，卡住退出不可以
  flushTimer.unref?.()
}

/**
 * 记一次请求的用量。
 *
 * 由 ai.ts 在每轮 HTTP 往返结束后调用。`usage.source === 'estimate'`
 * 时同时累加 estimatedRequests。
 */
export function recordUsage(input: {
  model: string
  promptTokens: number
  completionTokens: number
  cachedTokens: number
  estimated: boolean
  at?: Date
}): void {
  try {
    const file = load()
    const day = dayKey(input.at)
    const bump = (bucket: UsageBucket): void => {
      bucket.requests += 1
      if (input.estimated) bucket.estimatedRequests += 1
      bucket.promptTokens += Math.max(0, Math.floor(input.promptTokens) || 0)
      bucket.completionTokens += Math.max(0, Math.floor(input.completionTokens) || 0)
      bucket.cachedTokens += Math.max(0, Math.floor(input.cachedTokens) || 0)
    }

    if (!file.days[day]) file.days[day] = emptyBucket()
    bump(file.days[day])

    const model = input.model.trim() || '（未指定模型）'
    if (!file.models[model]) file.models[model] = emptyBucket()
    bump(file.models[model])

    prune(file)
    scheduleFlush()
  } catch (err) {
    // 统计永远不该影响对话
    logger.warn('usage', `用量统计记录失败（不影响对话）: ${String(err)}`)
  }
}

/** 丢掉过期数据。只在写入时顺手做，不需要单独的定时任务 */
function prune(file: UsageFile): void {
  const keys = Object.keys(file.days).sort()
  if (keys.length > USAGE_KEEP_DAYS) {
    for (const key of keys.slice(0, keys.length - USAGE_KEEP_DAYS)) delete file.days[key]
  }
}

function sumBuckets(items: UsageBucket[]): UsageBucket {
  const out = emptyBucket()
  for (const item of items) {
    out.requests += item.requests
    out.estimatedRequests += item.estimatedRequests
    out.promptTokens += item.promptTokens
    out.completionTokens += item.completionTokens
    out.cachedTokens += item.cachedTokens
  }
  return out
}

/**
 * 读统计。
 *
 * `week` 用「最近 7 个自然日（含今天）」而不是「最近 7 条记录」：
 * 用户问的是「这周用了多少」，中间哪天没用也该算在 7 天里。
 */
export function readUsage(): UsageStats {
  const file = load()
  const allDays = Object.keys(file.days).sort()
  const today = dayKey()

  // 最近 7 天：从今天往前数 7 个日期，缺的天补 0
  const weekKeys: string[] = []
  const cursor = new Date()
  for (let i = 0; i < 7; i++) {
    weekKeys.push(dayKey(cursor))
    cursor.setDate(cursor.getDate() - 1)
  }
  const week = sumBuckets(weekKeys.map((key) => file.days[key]).filter(Boolean))

  const days: UsageByDay[] = weekKeys
    .slice()
    .reverse()
    .map((day) => ({ day, ...(file.days[day] || emptyBucket()) }))

  const models: UsageByModel[] = Object.entries(file.models)
    .map(([model, bucket]) => ({ model, ...bucket }))
    .sort((a, b) => b.promptTokens + b.completionTokens - (a.promptTokens + a.completionTokens))
    .slice(0, USAGE_MODELS_MAX)

  return {
    today: { ...(file.days[today] || emptyBucket()) },
    week,
    total: sumBuckets(Object.values(file.days)),
    days,
    models,
    since: allDays[0] || ''
  }
}

/** 清空统计。用户在设置里点「清空」时调用 */
export function resetUsage(): UsageStats {
  cache = { version: 1, days: {}, models: {} }
  flushNow()
  logger.info('usage', '用量统计已清空')
  return readUsage()
}

/**
 * 退出前把还在防抖窗口里的数据写下去。
 * 不调这个的话，用户「聊完立刻关窗口」会丢掉最后一次记录。
 */
export function flushUsage(): void {
  if (flushTimer) {
    clearTimeout(flushTimer)
    flushTimer = null
  }
  flushNow()
}
