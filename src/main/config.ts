import fs from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import {
  DEFAULT_CONFIG,
  EDITOR_TABS_MAX,
  EXPLORER_SORT_BY,
  RECENT_SESSIONS_MAX,
  RECENT_WORKSPACES_MAX,
  SESSION_TITLE_MAX,
  SPLIT_MAX,
  SPLIT_MIN,
  type AppConfig,
  type CapabilityMode,
  type EditorSession,
  type ExplorerSortBy,
  type OpenTab,
  type SessionEntry,
  type WorkspaceEntry
} from '../shared/types'
import { AI_NAME_MAX, HABITS_MAX, USER_NAME_MAX } from '../shared/system-doc'
import { logger } from './logger'

let cached: AppConfig | null = null
let configPath = ''

function resolveConfigPath(): string {
  if (!configPath) configPath = path.join(app.getPath('userData'), 'config.json')
  return configPath
}

const CAPABILITY_MODES: CapabilityMode[] = ['auto', 'conservative', 'full']

/**
 * explorer 段的白名单校验。
 *
 * 这一段有两个字段是「取值必须在集合里」的枚举，历史坑就在这儿：
 * normalize 只做 `{ ...DEFAULT, ...input }` 展开的话，config.json 里塞了
 * 一个非法值（手改过、或旧版本留下的）会被原样带进内存，
 * 界面按它查表查不到，表现为「排序/展开状态莫名其妙不对」，还不报错。
 * 所以这里显式收敛一次。
 */
function normalizeExplorer(raw: unknown): AppConfig['explorer'] {
  const input = (raw && typeof raw === 'object' ? raw : {}) as Partial<AppConfig['explorer']>
  const sortBy = EXPLORER_SORT_BY.includes(input.sortBy as ExplorerSortBy)
    ? (input.sortBy as ExplorerSortBy)
    : DEFAULT_CONFIG.explorer.sortBy
  return {
    ...DEFAULT_CONFIG.explorer,
    ...input,
    showHidden: Boolean(input.showHidden),
    treeOpen: input.treeOpen === undefined ? DEFAULT_CONFIG.explorer.treeOpen : Boolean(input.treeOpen),
    chatOpen: input.chatOpen === undefined ? DEFAULT_CONFIG.explorer.chatOpen : Boolean(input.chatOpen),
    sortBy
  }
}

/**
 * ai 段的收敛。
 *
 * 除了补齐默认值，还夹住三个「会进 prompt」的字段的长度。
 * 界面已经限了 maxLength，但界面不是安全边界 —— 手改 config.json
 * 或者从 devtools 调 setConfig 都能绕过去。夹紧的成本是零。
 *
 * 这里**不做 trim 之外的加工**：用户在设置里看到什么，就该进 prompt 什么。
 * 尤其是 habits，换行和缩进是用户表达「分几条」的方式，压平了反而难读。
 */
function normalizeAi(raw: unknown): AppConfig['ai'] {
  const input = (raw && typeof raw === 'object' ? raw : {}) as Partial<AppConfig['ai']>
  const str = (value: unknown, fallback: string): string => (typeof value === 'string' ? value : fallback)
  return {
    ...DEFAULT_CONFIG.ai,
    ...input,
    baseUrl: str(input.baseUrl, DEFAULT_CONFIG.ai.baseUrl),
    apiKey: str(input.apiKey, DEFAULT_CONFIG.ai.apiKey),
    model: str(input.model, DEFAULT_CONFIG.ai.model),
    temperature: Number.isFinite(Number(input.temperature))
      ? Number(input.temperature)
      : DEFAULT_CONFIG.ai.temperature,
    systemPrompt: str(input.systemPrompt, DEFAULT_CONFIG.ai.systemPrompt),
    aiName: str(input.aiName, '').trim().slice(0, AI_NAME_MAX),
    userName: str(input.userName, '').trim().slice(0, USER_NAME_MAX),
    habits: str(input.habits, '').slice(0, HABITS_MAX),
    extraHeaders:
      input.extraHeaders && typeof input.extraHeaders === 'object' ? input.extraHeaders : {},
    supportsVision: Boolean(input.supportsVision),
    contextWindow: Math.max(0, Number(input.contextWindow) || 0),
    maxOutputTokens: Math.max(0, Number(input.maxOutputTokens) || 0)
  }
}

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
    ai: normalizeAi(input.ai),
    editor: { ...DEFAULT_CONFIG.editor, ...(input.editor || {}) },
    legacyGraphics: { ...DEFAULT_CONFIG.legacyGraphics, ...(input.legacyGraphics || {}) },
    capability: { mode, disabled },
    explorer: normalizeExplorer(input.explorer),
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
      messageCount: typeof entry.messageCount === 'number' && entry.messageCount > 0 ? entry.messageCount : 0,
      // archived 只在为 true 时才带上：老配置里没有这个字段，
      // 写成 archived: false 会让 config.json 每次保存都多出一堆无用字段
      ...(entry.archived ? { archived: true } : {})
    })
    if (out.length >= RECENT_SESSIONS_MAX) break
  }
  return out
}

function baseName(target: string): string {
  const parts = target.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] || target
}

/**
 * 把一条会话插到列表最前面（已存在则更新），并截到上限。
 *
 * `archived` 要**从旧条目上继承**：归档过的会话如果用户又回去接着聊，
 * touch 一次就把它变回「未归档」的话，它已经生成的总结就变成了孤儿
 * （索引里有、列表里说不归档），界面上会显示成「归档了但没有总结」。
 * 所以这里只更新标题/时间/条数，归档状态原样带过来。
 */
export function upsertSession(
  list: SessionEntry[],
  input: { id: string; title: string; workspace: string; messageCount: number }
): SessionEntry[] {
  const title = input.title.trim().slice(0, SESSION_TITLE_MAX) || '（未命名会话）'
  const previous = list.find((item) => item.id === input.id)
  const next: SessionEntry = {
    id: input.id,
    title,
    workspace: input.workspace,
    updatedAt: new Date().toISOString(),
    messageCount: input.messageCount,
    ...(previous?.archived ? { archived: true } : {})
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
