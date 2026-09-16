import fsp from 'node:fs/promises'
import path from 'node:path'
import { app } from 'electron'
import { ARCHIVE_INDEX_FILE, type ArchivedSession, type StoredSession } from '../shared/types'
import { atomicWriteFile } from './atomic-file'
import { logger } from './logger'

/**
 * 归档索引的**存储层**。
 *
 * ## 为什么把这一层单独拆出来
 *
 * 原来的结构是 `archive.ts`（业务）里同时放着「读写索引文件」和「总结流程」。
 * 那导致一条循环 import：
 *
 *   archive.ts → tools/index.ts（要工具表来发总结请求）
 *              → tools/session-tools.ts（AI 用的 listSessions/readSession）
 *              → archive.ts（要归档索引）
 *
 * 这个环**目前是良性的** —— 所有跨模块调用都发生在函数体里（不是模块顶层），
 * 所以运行时拿到的是已经加载完的模块。但它是一颗定时炸弹：
 * 哪天有人在顶层写一句 `const X = listArchive()`，就会拿到半成品模块，
 * 报一个 `is not a function`，而且**只在特定加载顺序下复现**
 * （开发时可能一直不复现，打包后才炸）。
 *
 * 拆法很直接：会话工具只需要「读索引」，不需要「归档 + 总结」那套业务。
 * 把存储层抽成这个**叶子模块**（只依赖 atomic-file / logger / shared），
 * 环就断了。
 *
 * 这个约定在本项目里已有先例：tools/meta.ts 也是为了让能力探测不断环
 * 才不依赖任何工具实现的。
 */

function sessionsDir(): string {
  return path.join(app.getPath('userData'), 'sessions')
}

function indexFile(): string {
  return path.join(sessionsDir(), ARCHIVE_INDEX_FILE)
}

/** 会话 id → 正文文件的绝对路径。id 过白名单，防路径穿越 */
export function archiveBodyFile(id: string): string {
  const safe = id.replace(/[^a-zA-Z0-9_-]/g, '')
  if (!safe) throw new Error('无效的会话 id')
  return path.join(sessionsDir(), `${safe}.json`)
}

/** 收敛一条从磁盘读来的记录：字段可能缺、类型可能不对 */
function normalizeEntry(raw: unknown): ArchivedSession | null {
  if (!raw || typeof raw !== 'object') return null
  const entry = raw as Partial<ArchivedSession>
  const id = typeof entry.id === 'string' ? entry.id.trim() : ''
  if (!id) return null
  const attempts = Number(entry.attempts)
  return {
    id,
    title: typeof entry.title === 'string' && entry.title ? entry.title : '（未命名会话）',
    summary: typeof entry.summary === 'string' ? entry.summary : '',
    archivedAt: typeof entry.archivedAt === 'string' ? entry.archivedAt : '',
    workspace: typeof entry.workspace === 'string' ? entry.workspace : '',
    messageCount: Number(entry.messageCount) > 0 ? Math.floor(Number(entry.messageCount)) : 0,
    ...(Number.isFinite(attempts) && attempts > 0 ? { attempts: Math.floor(attempts) } : {})
  }
}

let cache: ArchivedSession[] | null = null

/**
 * 读归档索引（带内存缓存）。
 *
 * 读坏了就当空 —— 归档索引是「锦上添花」的资料，
 * 为了它让应用起不来是本末倒置。真读坏了日志里会留一条。
 */
export async function loadArchive(): Promise<ArchivedSession[]> {
  if (cache) return cache
  return readArchiveFromDisk()
}

/**
 * 绕过缓存直接读磁盘。
 *
 * **「读—改—写」必须用这一个，不能用上面那个。**
 * 缓存版本可能是一秒前的快照，拿它做「改」的基准会把并发期间
 * 别人加的条目一起覆盖掉。只有在锁里面、要写回磁盘之前读，
 * 才是安全的使用姿势。
 */
export async function readArchiveFromDisk(): Promise<ArchivedSession[]> {
  try {
    const raw = JSON.parse(await fsp.readFile(indexFile(), 'utf8')) as unknown
    const list = Array.isArray(raw) ? raw : []
    cache = list.map(normalizeEntry).filter((item): item is ArchivedSession => item !== null)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code && code !== 'ENOENT') logger.warn('archive', `归档索引读取失败，按空处理: ${String(err)}`)
    cache = []
  }
  return cache
}

/**
 * 写归档索引。原子替换 + 同路径串行。
 *
 * 串行这一步是**必需**的，不是保险：归档一条会话会「先写索引，
 * 再在后台总结」，而总结流程里还要再写一次索引。两条路径并发时
 * 会撞在同一个 .tmp 上，表现为一条 ENOENT 加一次静默的数据丢失。
 * 详见 atomic-file.ts 里那段推演。
 *
 * ⚠️ 调用方必须自己持有 `withLock('archive-index', ...)`。
 * 这个函数只保证「文件不半截」，不保证「改动不丢」——
 * 后者要靠「读—改—写」整体串行。
 */
export async function saveArchive(list: ArchivedSession[]): Promise<void> {
  cache = list
  await atomicWriteFile(indexFile(), JSON.stringify(list, null, 2))
}

/** 读会话正文。找不到返回 null，不抛错 */
export async function readArchiveBody(id: string): Promise<StoredSession | null> {
  try {
    const parsed = JSON.parse(await fsp.readFile(archiveBodyFile(id), 'utf8')) as StoredSession
    if (!parsed || !Array.isArray(parsed.messages)) return null
    return parsed
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code !== 'ENOENT') logger.warn('archive', `读取会话正文失败 ${id}: ${String(err)}`)
    return null
  }
}

/** 供工具与设置页使用：列归档 */
export async function listArchive(): Promise<ArchivedSession[]> {
  return loadArchive()
}
