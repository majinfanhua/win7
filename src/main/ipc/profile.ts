import { ipcMain, shell } from 'electron'
import { IPC, type ArchivedSession, type SystemDocState, type UsageStats } from '../../shared/types'
import { inspectSystemDoc, regenerateSystemDoc, systemDocPath } from '../system-doc'
import { readUsage, resetUsage, flushUsage } from '../usage'
import { archiveSession, listArchive, summarizePending, unarchiveSession } from '../archive'
import { getConfig } from '../config'
import { logger } from '../logger'

/**
 * 「AI 自己的东西」这一组 IPC：系统设定文件、用量统计、归档。
 *
 * 为什么单独一个文件而不是塞进 sessions.ts / ai.ts：
 * 这三件事服务的是**同一个界面区域**（设置里的「AI 设定 / 用量 / 归档」），
 * 而它们的数据源分散在主进程的四个模块里。放在一起，
 * 「设置页要什么」与「主进程给什么」的对应关系是一目了然的 ——
 * 找任何一个接口都只需要看这一个文件。
 *
 * 它们也都是**低频操作**（改设置、看统计、归档），
 * 没有流式对话那种性能要求，所以实现上优先选「好读」而不是「快」。
 */

export function registerProfileIpc(): void {
  /* ---------------- 系统设定（系统.md） ---------------- */

  ipcMain.handle(IPC.systemDocGet, (): Promise<SystemDocState> => inspectSystemDoc())

  ipcMain.handle(IPC.systemDocRegenerate, async (): Promise<SystemDocState> => {
    // 重新生成后快照必然过期：下次对话要读的是新内容
    const state = await regenerateSystemDoc()
    logger.info('profile', '用户手动重新生成了系统.md')
    return state
  })

  /**
   * 用系统默认程序打开 `系统.md`。
   *
   * 用 shell.openPath 而不是自己在应用里渲染：用户的诉求往往是
   * 「我要拿它去别处用」或者「我要仔细看看」—— 记事本能做的事
   * 比我们在设置页里塞一个只读预览框多得多（搜索、另存、对比）。
   * 代价是用户可能在里面编辑，那个已经被防住了（下次会话前覆盖）。
   */
  ipcMain.handle(IPC.systemDocOpen, async () => {
    const target = systemDocPath()
    const error = await shell.openPath(target)
    if (error) {
      logger.warn('profile', `打开系统.md 失败: ${error}`)
      throw new Error(`打不开文件：${error}`)
    }
    return true
  })

  /* ---------------- 用量统计 ---------------- */

  ipcMain.handle(IPC.usageStats, (): UsageStats => readUsage())

  ipcMain.handle(IPC.usageReset, (): UsageStats => {
    logger.info('profile', '用户清空了用量统计')
    return resetUsage()
  })

  /* ---------------- 归档会话 ---------------- */

  ipcMain.handle(IPC.sessionArchiveList, (): Promise<ArchivedSession[]> => listArchive())

  ipcMain.handle(IPC.sessionArchive, async (_e, id: string) => {
    const clean = typeof id === 'string' ? id.trim() : ''
    if (!clean) throw new Error('会话 id 不能为空')
    const entry = getConfig().recentSessions.find((item) => item.id === clean)
    const outcome = await archiveSession(clean, entry?.workspace || '', entry?.messageCount || 0)
    if (!outcome.ok) throw new Error(outcome.message)
    // 立刻返回索引（界面按它渲染），总结在后台继续
    return { message: outcome.message, entries: await listArchive() }
  })

  ipcMain.handle(IPC.sessionUnarchive, async (_e, id: string) => {
    const clean = typeof id === 'string' ? id.trim() : ''
    if (!clean) throw new Error('会话 id 不能为空')
    const outcome = await unarchiveSession(clean)
    if (!outcome.ok) throw new Error(outcome.message)
    return { message: outcome.message, entries: await listArchive() }
  })

  /**
   * 应用启动后补做没做完的总结。
   *
   * 延迟 8 秒再动：启动瞬间要建窗口、加载渲染进程、探测运行时，
   * 这时候插一个网络请求会跟它们抢资源，用户能感觉到「开机慢」。
   * 8 秒后界面已经画出来了，后台悄悄发一个请求没人会注意。
   *
   * 失败**不提示**用户：这是补做，不是他刚点的动作。
   * 提示只会变成一条看不懂的报错。
   */
}

/**
 * 启动时的后台补做。
 *
 * 单独导出而不是塞进 registerProfileIpc：注册 IPC 与「开机做一件后台事」
 * 是两个不同的时机，混在一个函数里会让 index.ts 的调用顺序变得不好读。
 */
export function scheduleArchiveCatchUp(): void {
  const timer = setTimeout(() => {
    void summarizePending().catch((err) => {
      logger.warn('profile', `启动补做总结失败: ${String(err)}`)
    })
  }, 8_000)
  timer.unref?.()
}

/** 退出前把没用完的统计写下去（防抖窗口里的那一份） */
export function flushProfile(): void {
  flushUsage()
}