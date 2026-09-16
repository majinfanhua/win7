import fsp from 'node:fs/promises'
import path from 'node:path'
import { app, ipcMain } from 'electron'
import {
  IPC,
  SESSION_MESSAGES_MAX,
  SESSION_MESSAGE_CHARS_MAX,
  type SessionEntry,
  type StoredMessage,
  type StoredSession
} from '../../shared/types'
import { getConfig, setConfig, upsertSession } from '../config'
import { atomicWriteFile } from '../atomic-file'
import { logger } from '../logger'

/**
 * 会话记录：索引进 config.json，正文单独落盘。
 *
 * 两层的分工：
 *   - 索引（标题/时间/条数/工作区）→ config.json，左侧列表每次启动都要整份读，必须小
 *   - 正文（消息列表）→ userData/sessions/<id>.json，只有点开某条会话时才读
 *
 * 为什么正文不用 jsonl 追加：追加写到一半崩掉会留下半行坏 JSON，
 * 下次读整个文件就废了，还得写恢复逻辑。整份覆写虽然每次都写全文，
 * 但配合原子替换（写 .tmp 再 rename）永远不会读到半截文件，
 * 而一个会话撑到几 MB 是很罕见的情况 —— 用简单换可靠，划算。
 */

function sessionsDir(): string {
  return path.join(app.getPath('userData'), 'sessions')
}

/**
 * 会话 id → 文件名。
 *
 * id 由渲染进程生成（`s-<时间戳>-<随机>`），理论上安全，但仍然过一道白名单：
 * 万一哪天 id 被换成带 `../` 的字符串，这里就是唯一能拦住路径穿越的地方。
 */
function fileFor(id: string): string {
  const safe = id.replace(/[^a-zA-Z0-9_-]/g, '')
  if (!safe) throw new Error('无效的会话 id')
  return path.join(sessionsDir(), `${safe}.json`)
}

/**
 * 落盘前的瘦身。
 *
 * 单条消息截到 SESSION_MESSAGE_CHARS_MAX：偶尔会把整个文件粘进提问，
 * 不截的话一个会话文件能到几十 MB，而这类超长消息回看时也没人会读完。
 * 只保留最近 SESSION_MESSAGES_MAX 条 —— 滚动删除比拒绝保存体验好，
 * 使用者不会因为「存太多」而突然存不进去。
 */
function trimMessages(messages: StoredMessage[]): StoredMessage[] {
  const cleaned = messages
    .filter((m) => m && typeof m.text === 'string')
    .map((m) => ({
      role: m.role,
      text: m.text.length > SESSION_MESSAGE_CHARS_MAX ? m.text.slice(0, SESSION_MESSAGE_CHARS_MAX) : m.text,
      at: typeof m.at === 'string' ? m.at : new Date().toISOString()
    }))
  return cleaned.length > SESSION_MESSAGES_MAX ? cleaned.slice(cleaned.length - SESSION_MESSAGES_MAX) : cleaned
}

/**
 * 读磁盘上的旧正文，只用于继承归档状态。
 * 与 sessionLoad 的区别：这个不 trim 消息（我们只要那两个字段），
 * 而且读失败安静返回 null —— 它只是个「有没有」的查询。
 */
async function readStored(id: string): Promise<StoredSession | null> {
  try {
    const parsed = JSON.parse(await fsp.readFile(fileFor(id), 'utf8')) as StoredSession
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

export function registerSessionIpc(): void {
  ipcMain.handle(IPC.sessionList, (): SessionEntry[] => getConfig().recentSessions)

  ipcMain.handle(
    IPC.sessionTouch,
    (_e, input: { id: string; title: string; workspace: string; messageCount: number }): SessionEntry[] => {
      const id = typeof input?.id === 'string' ? input.id.trim() : ''
      if (!id) throw new Error('会话 id 不能为空')
      const next = upsertSession(getConfig().recentSessions, {
        id,
        title: typeof input?.title === 'string' ? input.title : '',
        workspace: typeof input?.workspace === 'string' ? input.workspace : '',
        messageCount: Number(input?.messageCount) || 0
      })
      setConfig({ recentSessions: next })
      return next
    }
  )

  ipcMain.handle(IPC.sessionRemove, async (_e, id: string): Promise<SessionEntry[]> => {
    const next = getConfig().recentSessions.filter((item) => item.id !== id)
    setConfig({ recentSessions: next })
    // 正文一起删。只删索引会留下永远读不到的孤儿文件，攒久了白占磁盘
    try {
      await fsp.rm(fileFor(id), { force: true })
    } catch (err) {
      logger.warn('session', `删除会话正文失败 ${id}: ${String(err)}`)
    }
    logger.info('session', `已删除会话记录: ${id}`)
    return next
  })

  /**
   * 读会话正文。
   *
   * 所有异常都收敛成 null 而不是抛出去：文件可能因为磁盘清理、
   * 手动删除、上个版本格式不同而读不了，这时左侧列表还是应该能点，
   * 点开看到空对话，而不是弹一个报错框。
   */
  ipcMain.handle(IPC.sessionLoad, async (_e, id: string): Promise<StoredSession | null> => {
    try {
      const raw = await fsp.readFile(fileFor(id), 'utf8')
      const parsed = JSON.parse(raw) as StoredSession
      if (!parsed || !Array.isArray(parsed.messages)) return null
      return { ...parsed, id, messages: trimMessages(parsed.messages) }
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code !== 'ENOENT') logger.warn('session', `读取会话正文失败 ${id}: ${String(err)}`)
      return null
    }
  })

  /**
   * 写会话正文。
   *
   * 先写 `.tmp` 再 rename：rename 在同一文件系统内是原子的，
   * 所以要么读到旧的完整文件，要么读到新的完整文件，不存在中间态。
   * 直接 writeFile 覆盖的话，写到一半断电就会留下一个截断的 JSON。
   */
  ipcMain.handle(IPC.sessionSave, async (_e, session: StoredSession): Promise<boolean> => {
    const id = typeof session?.id === 'string' ? session.id.trim() : ''
    if (!id) throw new Error('会话 id 不能为空')

    /*
     * 归档状态必须**从磁盘上的旧文件继承**，不接受渲染层传进来的值。
     *
     * 界面每次落盘都送一份完整 StoredSession，而它关心的是 messages，
     * 不关心归档。如果这里只重建上面几个字段，用户在归档之后随便说一句话，
     * 落盘就会把归档标记抹掉 —— 现象是「归档的会话自己变回未归档」，
     * 而梗概还在 archive.json 里，两边从此对不上。
     *
     * 顺序：先读旧文件，再拼 payload。读不到（新会话）就是没有归档状态。
     */
    const previous = await readStored(id)

    const payload: StoredSession = {
      id,
      title: typeof session.title === 'string' ? session.title : '',
      workspace: typeof session.workspace === 'string' ? session.workspace : '',
      updatedAt: new Date().toISOString(),
      messages: trimMessages(Array.isArray(session.messages) ? session.messages : []),
      ...(previous?.archivedAt ? { archivedAt: previous.archivedAt } : {}),
      ...(previous?.summary ? { summary: previous.summary } : {})
    }

    const target = fileFor(id)
    try {
      await atomicWriteFile(target, JSON.stringify(payload))
      return true
    } catch (err) {
      logger.error('session', `保存会话正文失败 ${id}: ${String(err)}`)
      throw err
    }
  })
}
