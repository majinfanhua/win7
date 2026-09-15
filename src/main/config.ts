import fs from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import {
  DEFAULT_CONFIG,
  EDITOR_TABS_MAX,
  RECENT_SESSIONS_MAX,
  RECENT_WORKSPACES_MAX,
  SESSION_TITLE_MAX,
  SPLIT_MAX,
  SPLIT_MIN,
  type AppConfig,
  type CapabilityMode,
  type EditorSession,
  type OpenTab,
  type SessionEntry,
  type WorkspaceEntry
} from '../shared/types'
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
    explorer: { ...DEFAULT_CONFIG.explorer, ...(input.explorer || {}) },
    lastWorkspace: typeof input.lastWorkspace === 'string' ? input.lastWorkspace : '',
    recentWorkspaces: normalizeWorkspaces(input.recentWorkspaces),
    recentSessions: normalizeSessions(input.recentSessions),
    editorSession: normalizeEditorSession(input.editorSession)
  }
}

/**
 * 编辑器会话收敛。
 *
 * 这里不做「文件是否存在」的过滤 —— 那是落盘时（editorSessionSet）干的，
 * 因为启动时工作区可能还没恢复，此时拿不到正确的路径上下文。
 * 这里只保证类型对、split 在安全范围内。
 */
function normalizeEditorSession(raw: unknown): EditorSession {
  const input = (raw && typeof raw === 'object' ? raw : {}) as Partial<EditorSession>
  const tabs: OpenTab[] = Array.isArray(input.tabs)
    ? input.tabs
        .filter((tab): tab is OpenTab => Boolean(tab && typeof tab.path === 'string'))
        .slice(0, EDITOR_TABS_MAX)
        .map((tab) => ({
          path: tab.path,
          line: Math.max(1, Number(tab.line) || 1),
          column: Math.max(1, Number(tab.column) || 1)
        }))
    : []

  const wanted = typeof input.activePath === 'string' ? input.activePath : ''
  const activePath = tabs.some((tab) => tab.path === wanted) ? wanted : (tabs[0]?.path ?? '')

  // 夹到安全范围：0 会让编辑器彻底看不见，大于 1 会把对话区挤没
  const rawSplit = Number(input.split)
  const split = Number.isFinite(rawSplit)
    ? Math.min(SPLIT_MAX, Math.max(SPLIT_MIN, rawSplit))
    : DEFAULT_CONFIG.editorSession.split

  return { tabs, activePath, split }
}

/**
 * 最近工作区列表收敛。
 *
 * 老版本 config.json 里没有这个字段（多数机器上装的还是旧包），
 * 所以这里必须能吃下 undefined / 非数组 / 数组里混了脏对象三种情况，
 * 而不是直接信任 JSON.parse 的结果 —— 脏数据会让左侧边栏渲染时崩掉。
 */
function normalizeWorkspaces(raw: unknown): WorkspaceEntry[] {
  if (!Array.isArray(raw)) return []
  const out: WorkspaceEntry[] = []
  const seen = new Set<string>()
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const entry = item as Partial<WorkspaceEntry>
    const p = typeof entry.path === 'string' ? entry.path.trim() : ''
    if (!p || seen.has(p)) continue
    seen.add(p)
    out.push({
      path: p,
      name: typeof entry.name === 'string' && entry.name ? entry.name : baseName(p),
      lastOpenedAt: typeof entry.lastOpenedAt === 'string' ? entry.lastOpenedAt : ''
    })
    if (out.length >= RECENT_WORKSPACES_MAX) break
  }
  return out
}

/** 最近会话列表收敛，规则同上 */
function normalizeSessions(raw: unknown): SessionEntry[] {
  if (!Array.isArray(raw)) return []
  const out: SessionEntry[] = []
  const seen = new Set<string>()
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const entry = item as Partial<SessionEntry>
    const id = typeof entry.id === 'string' ? entry.id.trim() : ''
    if (!id || seen.has(id)) continue
    seen.add(id)
    const title = typeof entry.title === 'string' ? entry.title : ''
    out.push({
      id,
      title: title || '（未命名会话）',
      workspace: typeof entry.workspace === 'string' ? entry.workspace : '',
      updatedAt: typeof entry.updatedAt === 'string' ? entry.updatedAt : '',
      messageCount: typeof entry.messageCount === 'number' && entry.messageCount > 0 ? entry.messageCount : 0
    })
    if (out.length >= RECENT_SESSIONS_MAX) break
  }
  return out
}

function baseName(target: string): string {
  const parts = target.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] || target
}

/** 把一条会话插到列表最前面（已存在则更新），并截到上限 */
export function upsertSession(
  list: SessionEntry[],
  input: { id: string; title: string; workspace: string; messageCount: number }
): SessionEntry[] {
  const title = input.title.trim().slice(0, SESSION_TITLE_MAX) || '（未命名会话）'
  const next: SessionEntry = {
    id: input.id,
    title,
    workspace: input.workspace,
    updatedAt: new Date().toISOString(),
    messageCount: input.messageCount
  }
  return [next, ...list.filter((item) => item.id !== input.id)].slice(0, RECENT_SESSIONS_MAX)
}

/** 把一条工作区插到列表最前面（已存在则更新），并截到上限 */
export function upsertWorkspace(list: WorkspaceEntry[], dir: string): WorkspaceEntry[] {
  const resolved = path.resolve(dir)
  const next: WorkspaceEntry = {
    path: resolved,
    name: baseName(resolved),
    lastOpenedAt: new Date().toISOString()
  }
  return [next, ...list.filter((item) => path.resolve(item.path) !== resolved)].slice(
    0,
    RECENT_WORKSPACES_MAX
  )
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
