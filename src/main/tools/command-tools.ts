import fsp from 'node:fs/promises'
import { assertInsideRoot, getWorkspaceRoot } from '../ipc/workspace'
import { logger } from '../logger'
import {
  clipForModel,
  normalizeTimeout,
  runCommand,
  type ExecOutcome
} from './exec'
import { killJob, pollJob, startJob, type JobView } from './jobs'
import { JOB_MAX_MS } from './limits'

/**
 * 命令类工具的实作：执行命令 + 后台任务三件套。
 *
 * 这一组只在 Windows 10 / 11 上出现（见 capabilities.ts 的 commandExec / backgroundJobs），
 * 所以这里的错误文案不必兼容 Win7 —— Win7 上模型根本看不到这些工具。
 * 但「full 模式强开」与「刚被关掉还没刷新上下文」两种情况仍可能真的调进来，
 * 所以每个入口都要能给出人能看懂的错误，而不是一堆内部异常。
 */

/* ------------------------------------------------------------------ *
 * 公共部分
 * ------------------------------------------------------------------ */

/** 工作目录：默认项目根目录，给了就必须在项目内 */
async function resolveCwd(raw: unknown): Promise<string> {
  const root = getWorkspaceRoot()
  if (!root) throw new Error('尚未打开工作区，无法确定命令的工作目录')
  const value = typeof raw === 'string' ? raw.trim() : ''
  if (!value) return root

  const target = assertInsideRoot(value)
  const stat = await fsp.stat(target).catch(() => null)
  if (!stat) throw new Error(`工作目录不存在：${target}`)
  if (!stat.isDirectory()) throw new Error(`工作目录不是文件夹：${target}`)
  return target
}

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`
}

/** 输出为空时也得说一句，否则模型会以为工具没干活 */
function outputBlock(text: string, emptyNote = '（命令没有产生任何输出）'): string {
  const body = text.trim()
  if (!body) return emptyNote
  return clipForModel(body)
}

/** 执行结果的共同头部：先说结论，再给输出 */
function resultHeader(outcome: ExecOutcome, timeoutMs: number): string {
  if (outcome.timedOut) {
    return (
      `结果：超过 ${seconds(timeoutMs)} 还没结束，已终止整棵进程树。\n` +
      '提示：需要跑很久的命令（安装依赖、跑测试）请改用 jobRun，不要用 runCommand 硬等。'
    )
  }
  if (outcome.exitCode === 0) {
    return `结果：成功（退出码 0，用时 ${seconds(outcome.durationMs)}）`
  }
  return (
    `结果：退出码 ${outcome.exitCode === null ? '未知（进程被异常终止）' : outcome.exitCode}` +
    `，用时 ${seconds(outcome.durationMs)}。退出码非 0 说明命令报错了，原因在下面的输出里。`
  )
}

function truncationNote(outcome: ExecOutcome): string {
  return outcome.truncated ? '\n（输出太长，已截断）' : ''
}

/* ------------------------------------------------------------------ *
 * runCommand
 * ------------------------------------------------------------------ */

export interface RunCommandArgs {
  command: string
  cwd?: string
  timeoutMs?: number
}

async function runCommandTool(args: RunCommandArgs): Promise<string> {
  const command = typeof args.command === 'string' ? args.command.trim() : ''
  if (!command) throw new Error('command 不能为空')

  const cwd = await resolveCwd(args.cwd)
  const timeoutMs = normalizeTimeout(args.timeoutMs)
  logger.info('tool', `runCommand（cwd=${cwd}，超时 ${timeoutMs}ms）: ${command.slice(0, 200)}`)

  const outcome = await runCommand(command, { cwd, timeoutMs })

  return [
    `【执行命令】${command}`,
    `工作目录：${cwd}`,
    resultHeader(outcome, timeoutMs),
    '----- 输出 -----',
    outputBlock(outcome.output) + truncationNote(outcome)
  ].join('\n')
}

/* ------------------------------------------------------------------ *
 * jobRun / jobPoll / jobKill
 * ------------------------------------------------------------------ */

export interface JobRunArgs {
  command: string
  cwd?: string
}

async function jobRunTool(args: JobRunArgs): Promise<string> {
  const command = typeof args.command === 'string' ? args.command.trim() : ''
  if (!command) throw new Error('command 不能为空')

  const cwd = await resolveCwd(args.cwd)
  const job = startJob(command, cwd)

  return [
    `【后台任务】${job.id} 已启动`,
    `命令：${command}`,
    `工作目录：${cwd}`,
    `后台任务最长跑 ${Math.round(JOB_MAX_MS / 60_000)} 分钟，到点会被强制终止。`,
    `接下来用 jobPoll（id="${job.id}"）查进度与输出，不需要了就 jobKill。`
  ].join('\n')
}

export interface JobPollArgs {
  id: string
}

/** 把一份任务快照拼成模型能直接读懂的文本 */
function describeJob(job: JobView): string {
  const lines: string[] = [`【后台任务】${job.id}`]
  lines.push(`命令：${job.command}`)

  if (job.running) {
    lines.push(`状态：还在跑（已 ${seconds(job.elapsedMs)}）`)
    if (job.idleMs > 30_000) {
      lines.push(
        `已经 ${seconds(job.idleMs)} 没有新输出了 —— 可能是在做耗时的工作，` +
          '也可能是卡在等待输入。实在不动就用 jobKill 终止。'
      )
    }
  } else if (job.timedOut) {
    lines.push(`状态：已结束 —— 超过时长上限被强制终止（共 ${seconds(job.elapsedMs)}）`)
  } else if (job.killed) {
    lines.push(`状态：已被终止（共 ${seconds(job.elapsedMs)}）`)
  } else if (job.exitCode === 0) {
    lines.push(`状态：已成功结束（退出码 0，共 ${seconds(job.elapsedMs)}）`)
  } else {
    lines.push(
      `状态：已结束，退出码 ${job.exitCode === null ? '未知' : job.exitCode}` +
        `（非 0 表示报错了，共 ${seconds(job.elapsedMs)}）`
    )
  }

  lines.push('----- 输出 -----')
  lines.push(
    outputBlock(job.output, job.running ? '（任务还没产生输出）' : '（命令没有产生任何输出）') +
      (job.truncated ? '\n（输出太长，已截断）' : '')
  )
  return lines.join('\n')
}

async function jobPollTool(args: JobPollArgs): Promise<string> {
  const id = typeof args.id === 'string' ? args.id.trim() : ''
  if (!id) throw new Error('id 不能为空，请填入 jobRun 返回的任务号')

  const job = pollJob(id)
  if (!job) {
    throw new Error(
      `找不到任务 ${id}。任务只在本次运行期间保留，结束太久会被清理；` +
        '如果确实还需要跑，请用 jobRun 重新启动。'
    )
  }
  return describeJob(job)
}

export interface JobKillArgs {
  id: string
}

async function jobKillTool(args: JobKillArgs): Promise<string> {
  const id = typeof args.id === 'string' ? args.id.trim() : ''
  if (!id) throw new Error('id 不能为空，请填入 jobRun 返回的任务号')

  const result = killJob(id)
  const head = result.ok ? `【终止任务】${result.message}` : `【终止任务】未执行：${result.message}`
  if (!result.view) return head
  return [head, '----- 终止时的输出 -----', outputBlock(result.view.output)].join('\n')
}

/** 供 dispatch 使用：名字 -> 实作 */
export const COMMAND_TOOL_HANDLERS: Record<string, (args: never) => Promise<string>> = {
  runCommand: runCommandTool as (args: never) => Promise<string>,
  jobRun: jobRunTool as (args: never) => Promise<string>,
  jobPoll: jobPollTool as (args: never) => Promise<string>,
  jobKill: jobKillTool as (args: never) => Promise<string>
}
