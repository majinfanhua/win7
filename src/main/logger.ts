import fs from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import type { LogLevel, LogLine } from '../shared/types'

/** 内存环形缓冲区，供渲染进程「输出」面板拉取；同时落盘到 userData/logs */
const MAX_BUFFER = 800
const buffer: LogLine[] = []
let sink: ((line: LogLine) => void) | null = null
let logFilePath = ''

function now(): string {
  const d = new Date()
  const p = (n: number, w = 2): string => String(n).padStart(w, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`
}

/** 必须在 app ready 之前调用 */
export function initLogger(): string {
  const dir = path.join(app.getPath('userData'), 'logs')
  try {
    fs.mkdirSync(dir, { recursive: true })
  } catch {
    /* 磁盘只读等极端情况，降级为仅内存日志 */
  }
  logFilePath = path.join(dir, `main-${now().slice(0, 10)}.log`)
  return logFilePath
}

export function getLogFilePath(): string {
  return logFilePath
}

export function setLogSink(fn: ((line: LogLine) => void) | null): void {
  sink = fn
}

export function getRecentLogs(): LogLine[] {
  return buffer.slice()
}

export function log(level: LogLevel, scope: string, text: string): void {
  const line: LogLine = { time: now(), level, scope, text }
  buffer.push(line)
  if (buffer.length > MAX_BUFFER) buffer.splice(0, buffer.length - MAX_BUFFER)

  const flat = `[${line.time}] [${level.toUpperCase()}] [${scope}] ${text}`
  if (level === 'error') console.error(flat)
  else if (level === 'warn') console.warn(flat)
  else console.log(flat)

  if (logFilePath) {
    try {
      fs.appendFileSync(logFilePath, flat + '\n', 'utf8')
    } catch {
      /* 写不进去也不能让业务崩掉 */
    }
  }
  if (sink) {
    try {
      sink(line)
    } catch {
      /* ignore */
    }
  }
}

export const logger = {
  debug: (scope: string, text: string): void => log('debug', scope, text),
  info: (scope: string, text: string): void => log('info', scope, text),
  warn: (scope: string, text: string): void => log('warn', scope, text),
  error: (scope: string, text: string): void => log('error', scope, text)
}

/**
 * 崩溃与异常兜底。
 * Win7 上的失败往往表现为“进程静默退出”或“白屏”，没有这些钩子就无从定位。
 */
export function installCrashHandlers(): void {
  process.on('uncaughtException', (err) => {
    logger.error('crash', `uncaughtException: ${err?.stack || String(err)}`)
  })
  process.on('unhandledRejection', (reason) => {
    logger.error('crash', `unhandledRejection: ${reason instanceof Error ? reason.stack : String(reason)}`)
  })

  app.on('render-process-gone', (_e, _wc, details) => {
    logger.error('crash', `render-process-gone: reason=${details.reason} exitCode=${details.exitCode}`)
  })
  app.on('child-process-gone', (_e, details) => {
    logger.error(
      'crash',
      `child-process-gone: type=${details.type} reason=${details.reason} exitCode=${details.exitCode}`
    )
  })
  app.on('gpu-process-crashed', (_e, killed) => {
    logger.error('crash', `gpu-process-crashed: killed=${String(killed)}`)
  })
}
