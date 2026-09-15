import { logger } from '../logger'
import { startPowerShell, type ExecHandle, type ExecOutcome } from './exec'
import { JOB_MAX_MS, JOB_MAX_RUNNING } from './limits'

/**
 * 后台任务注册表。
 *
 * 存在的意义只有一个：跑「不会马上结束」的命令时不要把对话卡住 ——
 * 一次 npm install 可能要几分钟，而 runCommand 是有超时的，等它就是在烧时间。
 * 模型拿到任务号后可以继续做别的事，需要时用 jobPoll 查。
 *
 * 两条刻意的取舍：
 *   1. 任务只活在主进程内存里，不落盘。应用退出 = 任务结束。
 *      学生机重启后还挂着一堆孤儿进程，比丢一个任务号难收拾得多。
 *   2. 有硬上限（JOB_MAX_MS）。卡死的进程不会因为「模型忘了查」就永远跑下去。
 */

/** 已完成的任务最多保留几条（供模型回头查输出） */
const MAX_FINISHED = 20
/** 已完成任务的保留时长，过期就清掉 */
const FINISHED_TTL_MS = 10 * 60 * 1000

interface JobRecord {
  id: string
  command: string
  cwd: string
  startedAt: number
  handle: ExecHandle
  /** null 表示还在跑 */
  outcome: ExecOutcome | null
}

const jobs = new Map<string, JobRecord>()
let seq = 0

/** 对外的一份快照，工具层拿去拼文案 */
export interface JobView {
  id: string
  command: string
  cwd: string
  running: boolean
  exitCode: number | null
  timedOut: boolean
  killed: boolean
  truncated: boolean
  elapsedMs: number
  /** 距上一次收到输出过了多久，用于判断是不是卡住了 */
  idleMs: number
  output: string
}

/**
 * 清理已完成的任务。
 * 两道：先按时间过期，再按条数截断 —— 只按条数的话，
 * 短时间跑十几个任务会把有用的记录顶掉；只按时间的话，数量本身就不受控。
 */
function prune(): void {
  const now = Date.now()
  for (const [id, job] of jobs) {
    if (job.outcome && now - job.startedAt > FINISHED_TTL_MS) jobs.delete(id)
  }
  const finished = [...jobs.values()]
    .filter((job) => job.outcome)
    .sort((a, b) => a.startedAt - b.startedAt)
  while (finished.length > MAX_FINISHED) {
    const victim = finished.shift()
    if (victim) jobs.delete(victim.id)
  }
}

function runningCount(): number {
  let count = 0
  for (const job of jobs.values()) if (!job.outcome) count++
  return count
}

function view(job: JobRecord): JobView {
  const running = !job.outcome
  const now = Date.now()
  return {
    id: job.id,
    command: job.command,
    cwd: job.cwd,
    running,
    exitCode: job.outcome ? job.outcome.exitCode : null,
    timedOut: job.outcome ? job.outcome.timedOut : false,
    killed: job.outcome ? job.outcome.killed : false,
    truncated: job.handle.truncated(),
    elapsedMs: job.outcome ? job.outcome.durationMs : now - job.startedAt,
    idleMs: now - job.handle.lastOutputAt(),
    output: job.handle.output()
  }
}

/** 启动一个后台任务，立刻返回任务号 */
export function startJob(command: string, cwd: string): JobView {
  prune()
  const running = runningCount()
  if (running >= JOB_MAX_RUNNING) {
    throw new Error(
      `已有 ${running} 个后台任务在跑（上限 ${JOB_MAX_RUNNING} 个）。` +
        '请先用 jobPoll 看看它们是不是还在跑，不需要的用 jobKill 终止后再开新的。'
    )
  }

  const id = `job-${++seq}`
  const handle = startPowerShell(command, { cwd, timeoutMs: JOB_MAX_MS })
  const record: JobRecord = { id, command, cwd, startedAt: Date.now(), handle, outcome: null }
  jobs.set(id, record)

  logger.info('tool', `jobRun: ${id} 已启动（cwd=${cwd}）: ${command.slice(0, 200)}`)

  // 结束回调只负责把结果记下来。这里不 await：startJob 必须立刻返回任务号
  void handle.wait().then((outcome) => {
    record.outcome = outcome
    logger.info(
      'tool',
      `jobRun: ${id} 已结束（退出码 ${outcome.exitCode}，用时 ${(outcome.durationMs / 1000).toFixed(1)}s${
        outcome.timedOut ? '，超时被杀' : outcome.killed ? '，已终止' : ''
      }）`
    )
  })

  return view(record)
}

/** 查一个任务；任务号不存在（或已过期被清掉）返回 null */
export function pollJob(id: string): JobView | null {
  prune()
  const job = jobs.get(id)
  return job ? view(job) : null
}

export interface KillResult {
  ok: boolean
  message: string
  view?: JobView
}

/** 终止一个还在跑的任务（连同它启动的子进程） */
export function killJob(id: string): KillResult {
  const job = jobs.get(id)
  if (!job) return { ok: false, message: `没有编号为 ${id} 的任务（可能已经结束并被清理了）` }
  if (job.outcome) {
    return {
      ok: false,
      message: `任务 ${id} 已经结束了（退出码 ${job.outcome.exitCode}），不需要终止`,
      view: view(job)
    }
  }
  job.handle.kill()
  logger.info('tool', `jobKill: ${id} 已终止`)
  return { ok: true, message: `已终止任务 ${id}（连同它启动的子进程）` }
}

/**
 * 退出前清场。
 * 不杀的话，学生关掉编辑器后 python.exe / node.exe 会继续占着端口与 CPU，
 * 下次启动就变成「端口被占用」这种完全查不到原因的故障。
 */
export function killAllJobs(): number {
  let count = 0
  for (const job of jobs.values()) {
    if (job.outcome) continue
    job.handle.kill()
    count++
  }
  if (count > 0) logger.info('tool', `退出前已终止 ${count} 个后台任务`)
  return count
}
