import fs from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import { DEFAULT_CONFIG, type AppConfig, type CapabilityMode } from '../shared/types'
import { logger } from './logger'

let cached: AppConfig | null = null
let configPath = ''

function resolveConfigPath(): string {
  if (!configPath) configPath = path.join(app.getPath('userData'), 'config.json')
  return configPath
}

const CAPABILITY_MODES: CapabilityMode[] = ['auto', 'conservative', 'full']

/**
 * 配置标准化。
 *
 * ⚠️ 这里是**白名单式**的：只合并下面列出的 section。
 * 新增顶层 section 必须同时加到这里，否则每次读取都会被静默吞掉
 * —— 表现为「设置里改完、重启就没了」，而且不报任何错。
 *
 * 另外 setConfig 的顶层是浅合并，所以每个 section 内部在这里做完整补齐，
 * 保证只传一半字段进来也不会丢其他字段。
 */
function normalize(raw: unknown): AppConfig {
  const input = (raw && typeof raw === 'object' ? raw : {}) as Partial<AppConfig>
  const rawCap = (input.capability || {}) as Partial<AppConfig['capability']>
  const mode = CAPABILITY_MODES.includes(rawCap.mode as CapabilityMode)
    ? (rawCap.mode as CapabilityMode)
    : DEFAULT_CONFIG.capability.mode
  const disabled = Array.isArray(rawCap.disabled)
    ? rawCap.disabled.filter((x): x is string => typeof x === 'string')
    : DEFAULT_CONFIG.capability.disabled

  return {
    ai: { ...DEFAULT_CONFIG.ai, ...(input.ai || {}) },
    editor: { ...DEFAULT_CONFIG.editor, ...(input.editor || {}) },
    legacyGraphics: { ...DEFAULT_CONFIG.legacyGraphics, ...(input.legacyGraphics || {}) },
    capability: { mode, disabled },
    lastWorkspace: typeof input.lastWorkspace === 'string' ? input.lastWorkspace : ''
  }
}

/**
 * 在 app ready 之前也要能拿到配置（图形开关依赖它）。
 * app.getPath('userData') 在 ready 之前即可用，且 index.ts 的 main() 最前面
 * 已用 app.setPath('userData') 固定了目录名，所以这里取到的路径是确定的。
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
