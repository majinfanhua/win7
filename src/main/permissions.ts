import {
  PERMISSION_LABELS,
  PERMISSION_MODES,
  type ApprovalRequest,
  type PermissionMode
} from '../shared/types'
import { logger } from './logger'
import { classify, displayPath, isInside, resolveAgainst, type ClassifyResult } from './paths'

/**
 * 权限模式与越界审批。
 *
 * ## 概念分层（这一层是这次改造的核心）
 *
 *   **工具是工具，模式是模式，模式控制工具的边界。**
 *
 *   - 工具（tools/）：AI 手里有哪些能力。工具本身没有边界概念 ——
 *     readFile 就是读一个文件，它不知道「该不该」。
 *   - 模式（这里）：决定工具能伸到哪儿。同一个 readFile，在对话模式下
 *     只能读工作区，在完全允许模式下能读任何地方。
 *
 * 所以边界判定**不在工具里**，工具只问一句 `guardPath()`；结论由这里给。
 * 这样以后加模式不用动工具代码，加工具也不用重复写权限逻辑。
 *
 * ## 三种模式
 *
 *   - **对话模式（chat）**：默认。工作区 + 临时区之内随便做；越界要用户授权。
 *   - **计划模式（plan）**：只能看，不能改。AI 先给出计划，用户点「开始执行」
 *     之后才放行写入。这是「先规划再开发」的硬门禁 —— 不是靠提示词求它听话。
 *   - **完全允许模式（full）**：不做任何检查，全局可操作。给「我知道我在干什么」
 *     的场景用（比如批量重构整个磁盘上的项目）。
 *
 * ## 审批为什么在主进程
 *
 * 越界请求必须由**真正要动文件的那一方**发起并等待，否则渲染层可以
 * （被绕过或出 bug 时）先答应再干活，审批就变成装饰。所以主进程持 pending 表，
 * 渲染层只负责显示与回传选择。
 */

export type { PermissionMode }
export type { ApprovalRequest }

/** 当前模式。默认对话模式 —— 最安全也最符合直觉的起点 */
let mode: PermissionMode = 'chat'

/** 当前模式。工具层与设置界面都读它 */
export function getPermissionMode(): PermissionMode {
  return mode
}

export function setPermissionMode(next: PermissionMode): void {
  const value = PERMISSION_MODES.includes(next) ? next : 'chat'
  if (value === mode) return
  mode = value
  /*
   * 换模式就清掉越界授权与「已批执行」标记。
   *
   * 不清的话会出现权限残留：学生在完全允许模式下批过 D:\other，
   * 切回对话模式后那个目录仍然免检 —— 模式形同虚设。
   * 换模式本来就该是一次「重新划界」，从干净状态开始才符合预期。
   */
  clearApprovals()
  executingSessions.clear()
  logger.info(
    'permission',
    `权限模式：${PERMISSION_LABELS[mode]}（已清空越界授权与执行批准）`
  )
}

/* ------------------------------------------------------------------ *
 * 计划模式的「允许执行」标记
 * ------------------------------------------------------------------ */

/**
 * 用户点了「开始执行」的会话。
 *
 * 按会话记而不是全局：学生在 A 会话里批了计划，切到 B 会话（还没给计划）
 * 不该继承那个批准 —— 否则「先规划」这道门禁在第二个会话就失效了。
 */
const executingSessions = new Set<string>()

export function markExecuting(sessionId: string): void {
  if (sessionId) executingSessions.add(sessionId)
  logger.info('permission', `会话 ${sessionId || '(无)'} 已批准执行计划`)
}

export function clearExecuting(sessionId: string): void {
  executingSessions.delete(sessionId)
}

export function isExecuting(sessionId: string): boolean {
  return executingSessions.has(sessionId)
}

/**
 * 计划模式下是否已经放开写入。
 *
 * 没传 sessionId（后台任务、归档总结这类）视为**未批准** ——
 * 那些路径本来也不该写用户的工作区。
 */
export function planAllowsWrite(sessionId: string): boolean {
  return isExecuting(sessionId)
}

/* ------------------------------------------------------------------ *
 * 越界审批
 * ------------------------------------------------------------------ */

export type ApprovalChoice = 'once' | 'dir' | 'deny'

interface Pending {
  resolve: (choice: ApprovalChoice) => void
  timer: NodeJS.Timeout
  scopeDir: string
}

const pending = new Map<string, Pending>()

/**
 * 本会话内已授权的目录。
 *
 * 「允许此目录」之后不再重复问 —— 否则 AI 在一个目录里读十个文件
 * 就要弹十次框，用户很快就会学会无脑点允许，审批反而失去意义。
 */
const allowedDirs = new Set<string>()

export function clearApprovals(): void {
  allowedDirs.clear()
  for (const [, item] of pending) {
    clearTimeout(item.timer)
    item.resolve('deny')
  }
  pending.clear()
}

export function allowedDirCount(): number {
  return allowedDirs.size
}

/**
 * 审批的超时。
 *
 * 超时必须**拒绝**而不是放行 —— 无人值守时（CI 自检、后台归档）
 * 没有渲染层来回话，放行等于把边界悄悄拆了。
 * 60 秒是「用户看到了但还没点」与「其实没人」之间的折中。
 */
const APPROVAL_TIMEOUT_MS = 60_000

/** 谁来把请求送到界面。主进程启动时注入，避免这里 import electron 造成环 */
type Sender = (req: ApprovalRequest) => void
let sender: Sender | null = null

export function setApprovalSender(fn: Sender | null): void {
  sender = fn
}

/**
 * 发起一次审批并等结果。
 *
 * 没有 sender（窗口还没建好）时直接拒绝：宁可让 AI 报一个可读的错，
 * 也不能在无人确认的情况下越界。
 */
export async function requestApproval(
  req: Omit<ApprovalRequest, 'id'>
): Promise<ApprovalChoice> {
  if (!sender) {
    logger.warn('permission', `无审批通道，拒绝越界访问: ${req.target}`)
    return 'deny'
  }
  const id = `ap-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  return new Promise<ApprovalChoice>((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(id)
      logger.warn('permission', `审批超时，按拒绝处理: ${req.target}`)
      resolve('deny')
    }, APPROVAL_TIMEOUT_MS)
    pending.set(id, { resolve, timer, scopeDir: req.scopeDir })
    sender?.({ ...req, id })
  })
}

/** 渲染层回传选择。返回是否命中一个在等的请求 */
export function resolveApproval(id: string, choice: ApprovalChoice): boolean {
  const item = pending.get(id)
  if (!item) return false
  clearTimeout(item.timer)
  pending.delete(id)
  if (choice === 'dir') allowedDirs.add(item.scopeDir)
  item.resolve(choice)
  return true
}

/** 仅供自检与诊断：当前有多少个在等的审批 */
export function pendingApprovalCount(): number {
  return pending.size
}

/**
 * 越界判定 + 审批的唯一入口。工具只调这一个函数。
 *
 * 返回值是**解析后的绝对路径**，可以直接拿去 fs 操作。
 * 拒绝时抛错 —— 工具层统一把错误文本回灌给模型（见 tools/index.ts），
 * 模型因此能自己换一条路（比如改用工作区内的文件），比静默失败好得多。
 *
 * @param sessionId 用于计划模式的「已批计划」判定
 * @param write true 表示这是写操作（计划模式下要额外挡）
 */
export async function guardPath(
  target: string,
  opts: { sessionId?: string; write?: boolean; action?: string } = {}
): Promise<string> {
  const sessionId = opts.sessionId || ''
  const info: ClassifyResult = classify(target)

  // 没有任何可用根：既没打开项目、临时区也没初始化好
  if (info.boundary === 'none') {
    throw new Error(
      '还没有可用的工作目录。请先打开一个项目文件夹，或稍后重试（临时工作区尚未就绪）。'
    )
  }

  /*
   * 计划模式的硬门禁。
   *
   * 放在路径判定**之前**：计划模式下连工作区内的写入也不允许 ——
   * 这正是「先规划、经我同意再动手」的含义。只挡写不挡读，
   * 否则 AI 连项目结构都看不到，计划无从谈起。
   */
  if (opts.write && mode === 'plan' && !planAllowsWrite(sessionId)) {
    throw new Error(
      '当前是计划模式：只能查看，不能修改。请先给出完整计划并等用户点击「开始执行」再动手。'
    )
  }

  if (info.boundary === 'inside') return info.resolved

  // 越界。完全允许模式下不做任何检查
  if (mode === 'full') {
    logger.warn('permission', `完全允许模式，直接放行越界访问: ${info.resolved}`)
    return info.resolved
  }

  // 已授权过的目录直接放行
  for (const dir of allowedDirs) {
    if (isInside(dir, info.resolved)) return info.resolved
  }

  const action = opts.action || `${opts.write ? '修改' : '读取'} ${displayPath(info.resolved)}`

  const choice = await requestApproval({
    action,
    target: info.resolved,
    scopeDir: info.scopeDir
  })

  if (choice === 'deny') {
    throw new Error(
      `用户拒绝了对工作区之外的访问：${info.resolved}。` +
        '请不要重试这个路径；需要的话请让用户先把文件放进当前项目。'
    )
  }
  if (choice === 'dir') allowedDirs.add(info.scopeDir)
  logger.info('permission', `用户允许${choice === 'once' ? '一次' : '此目录'}：${info.resolved}`)
  return info.resolved
}

/** 让 classify 的结果能直接用于展示与测试 */
export function describeBoundary(target: string): { resolved: string; inside: boolean } {
  const info = classify(target)
  return { resolved: info.resolved, inside: info.boundary === 'inside' }
}

export { resolveAgainst }
