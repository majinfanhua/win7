import fs from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import { DEFAULT_CONFIG, type AppConfig } from '../shared/types'
import { logger } from './logger'

let cached: AppConfig | null = null
let configPath = ''

function resolveConfigPath(): string {
  if (!configPath) configPath = path.join(app.getPath('userData'), 'config.json')
  return configPath
}

/** 只做顶层 section 合并，旧配置文件缺字段时自动补默认值 */
function normalize(raw: unknown): AppConfig {
  const input = (raw && typeof raw === 'object' ? raw : {}) as Partial<AppConfig>
  return {
    ai: { ...DEFAULT_CONFIG.ai, ...(input.ai || {}) },
    editor: { ...DEFAULT_CONFIG.editor, ...(input.editor || {}) },
    legacyGraphics: { ...DEFAULT_CONFIG.legacyGraphics, ...(input.legacyGraphics || {}) },
    lastWorkspace: typeof input.lastWorkspace === 'string' ? input.lastWorkspace : ''
  }
}

/**
 * 在 app ready 之前也要能拿到配置（图形开关依赖它），
 * 所以这里自己拼 userData 路径而不依赖 app.getPath 的就绪时机。
 */
export function initConfig(): AppConfig {
  const file = resolveConfigPath()
  try {
    cached = normalize(JSON.parse(fs.readFileSync(file, 'utf8')))
    logger.info('config', `已加载配置: ${file}`)
  } catch (err) {
    cached = normalize({})
    const code = (err as NodeJS.ErrnoException)?.code
    if (code && code !== 'ENOENT') logger.warn('config', `配置解析失败，已回退默认值: ${String(err)}`)
  }
  return cached
}

export function getConfig(): AppConfig {
  return cached || initConfig()
}

export function setConfig(patch: Partial<AppConfig>): AppConfig {
  const next = normalize({ ...getConfig(), ...patch })
  cached = next
  try {
    const file = resolveConfigPath()
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify(next, null, 2), 'utf8')
  } catch (err) {
    logger.error('config', `配置写入失败: ${String(err)}`)
  }
  return next
}

export function getConfigPath(): string {
  return resolveConfigPath()
}
