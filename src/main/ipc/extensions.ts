import { shell, ipcMain } from 'electron'
import { IPC } from '../../shared/types'
import { logger } from '../logger'
import { ensureSkillsDir, listSkills, readSkill, userSkillsDir } from '../skills'
import { mcpStates, reconnectMcp } from '../mcp/manager'
import type { McpServerStatus } from '../../shared/types'

/**
 * 把内部状态摊平成界面要的形状。
 *
 * 抽出来是因为 status 与 reconnect 两个 handler 都要同样的映射 ——
 * 复制两份的话，以后加一个字段（比如「最后错误时间」）会漏掉一处，
 * 表现为「点了重连之后那一栏少一个字段」。
 */
function mcpStatusList(): McpServerStatus[] {
  return mcpStates().map(({ config, state }) => ({
    id: config.id,
    name: config.name,
    command: config.command,
    args: config.args,
    status: state.status,
    detail: state.detail,
    tools: state.tools.map((t) => t.name)
  }))
}

/**
 * 技能与 MCP 的 IPC。
 *
 * 放在一个文件里，因为两者在界面上是同一类东西（「给 AI 扩展能力」），
 * 而且都很薄 —— 只是把主进程已有的函数暴露出去，不含业务逻辑。
 *
 * 校验一律交给被调用的模块（skills.ts / mcp/manager.ts）：
 * 在 IPC 层再判一次会出现两处规则，迟早不一致。
 */

export function registerExtensionIpc(): void {
  /* ---------------- 技能 ---------------- */

  ipcMain.handle(IPC.skillsList, () => listSkills())

  ipcMain.handle(IPC.skillsRead, async (_e, id: string) => {
    const result = await readSkill(id)
    // 读不到时返回文本而不是抛错：设置页要把这句话显示给用户看，
    // 抛错的话界面只能显示一个笼统的「读取失败」，丢掉了「有哪些可用」这个关键信息
    return result.text
  })

  ipcMain.handle(IPC.skillsOpenDir, async (): Promise<boolean> => {
    // 目录可能还没建过（用户第一次点），先确保存在再打开
    await ensureSkillsDir()
    const dir = userSkillsDir()
    const message = await shell.openPath(dir)
    if (message) {
      logger.warn('skill', `无法打开技能目录 ${dir}: ${message}`)
      throw new Error(message)
    }
    logger.info('skill', `已打开技能目录: ${dir}`)
    return true
  })

  /* ---------------- MCP ---------------- */

  ipcMain.handle(IPC.mcpStatus, () => mcpStatusList())

  ipcMain.handle(IPC.mcpReconnect, async (_e, id: string) => {
    await reconnectMcp(id)
    return mcpStatusList()
  })
}
