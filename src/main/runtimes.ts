import type { DetectedRuntime } from '../shared/types'
import { logger } from './logger'
import { runCommand } from './tools/exec'

/**
 * 探测本机装了哪些开发运行时（python / node / git…）。
 *
 * ## 为什么要做这件事
 *
 * 学生机上的环境差异极大：有的装了 python、有的只装了 node、
 * 有的什么都没装。而 AI 在跑命令前**必须知道有什么可用** ——
 * 否则它只能靠试错：先 `python hello.py`，失败，再 `node hello.js`，再失败。
 * 每一次试错都是一轮完整的对话往返，烧 token 也烧时间。
 *
 * 所以把这些探测结果写进 system prompt，AI 一次就能选对解释器。
 *
 * ## 为什么用 `where` 而不是直接查文件
 *
 * python / node 的安装路径五花八门（Program Files、用户目录、conda、
 * scoop…），硬编码几个候选路径必然漏。而 `where` 走的是 PATH ——
 * 安装程序会把路径写进 PATH，这正是「装了就能找到」的机制。
 * （cmd 内置的 `where` 从 Windows 7 起就有，不需要额外安装。）
 *
 * ## 代价与取舍
 *
 * 探测要起 6 个进程，冷启动时在机械盘上可能要一两秒。所以：
 *   - **只在需要时跑**（打开体检报告 / 首次构建 system prompt），不放在启动路径上
 *   - 结果缓存到进程结束 —— 学生装完 python 重开应用即可，不需要热更新
 *
 * 每个探测都带超时：某个程序卡住（比如 python 启动时在跑 sitecustomize）
 * 不能让整个体检挂住。
 */

/** 一次探测的结果缓存。探测有成本，同一进程里只做一次 */
let cached: DetectedRuntime[] | null = null

/** 单个探测的超时。程序正常时都在 1 秒内返回 */
const PROBE_TIMEOUT_MS = 5_000

/**
 * 要探测的运行时。
 *
 * `args` 是「打印版本号」的参数，各家不一样：
 *   - python / node / git 都是 `--version`
 *   - java 是 `-version`（单个横杠，且打到 stderr）—— 这是历史遗留，
 *     写错了会得到「无法识别的选项」而不是版本号
 *   - pip 用 `--version` 但它是模块，得用 `python -m pip`
 */
const PROBES: Array<{ name: string; args: string; note: string }> = [
  { name: 'python', args: '--version', note: '可以跑 .py 脚本' },
  { name: 'node', args: '--version', note: '可以跑 .js 脚本与 npm' },
  { name: 'npm', args: '--version', note: '可以装依赖、跑项目脚本' },
  { name: 'git', args: '--version', note: '可以查看改动历史（本项目不用它做撤销）' },
  { name: 'java', args: '-version', note: '可以编译运行 .java' },
  { name: 'gcc', args: '--version', note: '可以编译 C 程序' }
]

/**
 * 探测一个程序。
 *
 * 用 `where` 先确认它在不在，再问版本 —— 两步而不是一步（直接问版本然后
 * 看退出码）的理由：程序**存在但启动失败**（缺 DLL、路径里有中文）与
 * **根本不存在**是两种情况，前者值得在报告里区分出来，
 * 否则学生会看到「没装 python」而他明明装了。
 */
async function probeOne(probe: {
  name: string
  args: string
  note: string
}): Promise<DetectedRuntime | null> {
  const cwd = process.env['USERPROFILE'] || process.env['SystemRoot'] || '.'
  try {
    const found = await runCommand(`where ${probe.name}`, { cwd, timeoutMs: PROBE_TIMEOUT_MS })
    if (found.exitCode !== 0 || !found.output.trim()) return null
    // where 可能返回多行（PATH 里有多个版本），取第一个
    const located = found.output
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('信息:') && !line.startsWith('INFO:'))[0]
    if (!located) return null

    const versioned = await runCommand(`${probe.name} ${probe.args}`, {
      cwd,
      timeoutMs: PROBE_TIMEOUT_MS
    })
    // java -version 打到 stderr，而 exec 把 stdout/stderr 合并了，所以不用区分
    const version = versioned.output.trim().split('\n')[0]?.trim() || ''
    return { name: probe.name, version, path: located, note: probe.note }
  } catch {
    // 单个程序探测失败不该影响其他的
    return null
  }
}

/**
 * 探测全部运行时（带缓存）。
 *
 * 并行跑：6 个进程串行在机械盘上要好几秒，并行通常 1 秒内出结果。
 */
export async function detectRuntimes(): Promise<DetectedRuntime[]> {
  if (cached) return cached
  if (process.platform !== 'win32') {
    // 非 Windows 上这套 `where` 探测不成立（Linux 是 `which`）。
    // 开发机不跑命令类工具，所以直接返回空 —— 不假装探测过
    cached = []
    return cached
  }
  const results = await Promise.all(PROBES.map((probe) => probeOne(probe)))
  cached = results.filter((item): item is DetectedRuntime => item !== null)
  logger.info(
    'runtime',
    cached.length
      ? `已探测到运行时: ${cached.map((item) => `${item.name}(${item.version || '版本未知'})`).join('、')}`
      : '未探测到任何开发运行时'
  )
  return cached
}

/**
 * 拼一段给模型看的运行时清单。
 *
 * 写进 system prompt，让 AI 一次选对解释器，而不是靠试错。
 * 没探测到任何东西时返回空串 —— 不要写「本机没有任何运行时」，
 * 那句话会让模型以为连 python 都不能装，反而限制了它的建议。
 */
export function describeRuntimesForModel(runtimes: DetectedRuntime[]): string {
  if (runtimes.length === 0) return ''
  const lines = runtimes.map((item) => {
    const version = item.version ? `（${item.version}）` : ''
    return `- ${item.name}${version}：${item.note}`
  })
  return (
    '本机可用的开发环境（已探测，直接用它，不要靠试错）：\n' +
    lines.join('\n') +
    '\n跑命令时请从上面这些里选，并且命令用英文。'
  )
}
