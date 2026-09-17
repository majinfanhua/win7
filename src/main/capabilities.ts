import type { CapabilityInfo, OsTier, ToolName, ToolRequirement } from '../shared/types'
import { detectPlatform } from './platform-compat'
import { getConfig } from './config'
import { logger } from './logger'
import { describeShell, shellAvailable } from './shell'
import {
  ALL_TOOLS,
  CROSS_OS_TOOLS,
  IMPLEMENTED_TOOLS,
  MEMORY_TOOLS,
  REQUIREMENT_LABELS,
  SKILL_TOOLS,
  TOOL_LABELS,
  TOOL_REQUIREMENTS
} from './tools/meta'

/**
 * 工具能力门控。
 *
 * 两层，职责分开：
 *   设置（config.capability）—— 愿意放开到哪，人改
 *   探测（本文件 probe）—— 这台机器实际能做到哪，只读
 *
 * 最终生效 = 设置上限 ∩ 本机探测 − disabled
 */

/** --capability-profile 的强制覆盖值，空串表示不覆盖 */
let overrideTier: OsTier | '' = ''

/**
 * CI 用：强制按某个系统等级计算能力集。
 * 背景：CI runner 是 Server 2022，探测结果永远是 win10，
 * 于是「Win7 下降级」那条分支永远不会被跑到，坏了也不知道。
 */
export function setCapabilityProfileOverride(raw: string): void {
  const value = (raw || '').trim() as OsTier
  const valid: OsTier[] = ['win7', 'win8', 'win10', 'win11', 'other']
  if (!value) return
  if (!valid.includes(value)) {
    logger.warn('capability', `未知的 --capability-profile 值「${raw}」，已忽略（可用：${valid.join(' / ')}）`)
    return
  }
  overrideTier = value
  cached = null
  logger.info('capability', `能力探测已被 --capability-profile=${value} 覆盖（仅供测试）`)
}

interface Detection {
  requirements: Record<ToolRequirement, boolean>
  notes: string[]
  profile: string
  tier: OsTier
}

/** 探测结果只算一次，缓存到进程生命周期（设置变了也不影响探测结果） */
let cached: Detection | null = null

function probe(): Detection {
  const platform = detectPlatform()
  const tier: OsTier = overrideTier || platform.tier
  const notes: string[] = []
  const requirements: Record<ToolRequirement, boolean> = {
    none: true,
    commandExec: false,
    backgroundJobs: false
  }

  // Windows 上 name 是「Windows 10」这样的短名，release 要另附；
  // 非 Windows 上 name 已经是「linux (6.8.0-…)」，再拼一次就会重复。
  const label = platform.name.includes(platform.release)
    ? platform.name
    : `${platform.name} (${platform.release})`

  const profile = overrideTier
    ? `${label} · 已被 --capability-profile=${overrideTier} 覆盖`
    : label

  /*
   * 命令执行能力：**探测 cmd.exe，而不是按系统等级一刀切**。
   *
   * 这里曾经是 `if (tier === 'win10' || tier === 'win11')` 才去找解释器，
   * 而 Win7 分支直接 `requirements.commandExec = false` ——
   * **根本没查 powershell.exe 在不在**。那个判断是错的：
   * cmd.exe 在所有 Windows 上都有，Win7 完全可以执行 python / node。
   * 代价是 Win7 用户白白少掉 4 个工具（执行命令 + 后台任务三件套）。
   *
   * 现在统一走「探测到就用」，Win7 / Win10 / Win11 同一条路径。
   * 非 Windows（开发机）仍然不可用 —— shell.ts 的 cmdPath() 会返回 null。
   */
  if (shellAvailable()) {
    requirements.commandExec = true
    requirements.backgroundJobs = true
    notes.push(`可用命令解释器：${describeShell()}`)
  } else if (process.platform === 'win32') {
    notes.push('未找到 cmd.exe，不启用命令执行（环境异常）')
  } else {
    notes.push(`${platform.name} 不是 Windows，不启用命令执行`)
  }

  return { requirements, notes, profile, tier }
}

function detection(): Detection {
  if (!cached) cached = probe()
  return cached
}

/**
 * 算出当前生效的工具表。
 * 每次调用都重新与设置求交，所以设置改完立即生效，不用重启。
 */
export function getCapabilityInfo(): CapabilityInfo {
  const d = detection()
  const cfg = getConfig()
  const { mode, disabled } = cfg.capability

  const allowed =
    mode === 'conservative'
      ? // 保守模式限制的是「能对我的代码做什么」。记忆与会话检索碰不到工作区，
        // 把它们也关掉只会让「保守模式」变成「阉割模式」，与它的本意无关。
        new Set<ToolName>([...CROSS_OS_TOOLS, ...MEMORY_TOOLS])
      : new Set<ToolName>(ALL_TOOLS)

  const effective: ToolName[] = []
  const filtered: Array<{ name: ToolName; reason: string }> = []

  for (const tool of ALL_TOOLS) {
    if (!IMPLEMENTED_TOOLS.includes(tool)) {
      filtered.push({ name: tool, reason: '尚未实现' })
      continue
    }
    if (!allowed.has(tool)) {
      filtered.push({ name: tool, reason: '设置未放开（保守模式）' })
      continue
    }
    /*
     * 技能开关。
     *
     * 单独一个开关而不是并进 disabled：技能是「用户写给 AI 的指令」，
     * 把它与「关掉某个文件工具」混在一起，设置界面里会看不出这条的特殊性。
     * 放在这里而不是工具层，是为了让模型**看不到**这些工具 ——
     * 看不到就不会调，比调了再报错干净。
     */
    if (SKILL_TOOLS.includes(tool) && !cfg.skills.enabled) {
      filtered.push({ name: tool, reason: '技能功能已在设置中关闭' })
      continue
    }
    if (disabled.includes(tool)) {
      filtered.push({ name: tool, reason: '已在设置中关闭' })
      continue
    }
    const requirement = TOOL_REQUIREMENTS[tool]
    // mode === 'full' 时故意跳过能力检查：这就是「人工兜底」的意义。
    // 真调用了不可用的工具，会在工具层拿到 TOOL_UNAVAILABLE 的可读错误。
    if (mode !== 'full' && !d.requirements[requirement]) {
      filtered.push({ name: tool, reason: `本机不支持（${REQUIREMENT_LABELS[requirement]}）` })
      continue
    }
    effective.push(tool)
  }

  return {
    profile: d.profile,
    detected: d.requirements,
    notes: d.notes,
    mode,
    effective,
    filtered,
    labels: TOOL_LABELS,
    overridden: Boolean(overrideTier)
  }
}

/** 启动日志用的一行摘要 */
export function describeCapability(info: CapabilityInfo): string {
  return `工具能力: mode=${info.mode} | 生效 ${info.effective.length} 个 [${info.effective.join(', ')}] | ${info.profile} | ${info.notes.join('；')}`
}
