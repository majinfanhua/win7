import os from 'node:os'
import { app } from 'electron'
import { logger } from './logger'

export type OsTier = 'win7' | 'win8' | 'win10' | 'win11' | 'other'

/**
 * 支持等级
 * - full        承诺支持并纳入测试矩阵（Win7 SP1 / Win10）
 * - incidental  能跑但未列入测试矩阵（Win8/8.1）
 * - unsupported 不承诺（Win11 / 非 SP1 的 Win7 / 非 Windows）
 */
export type SupportLevel = 'full' | 'incidental' | 'unsupported'

export interface PlatformProfile {
  tier: OsTier
  name: string
  release: string
  build: number
  support: SupportLevel
  supportNote: string
  /** Win7/8/8.1：需要在图形层降级 */
  needsLegacyGraphics: boolean
}

function readSystemVersion(): string {
  if (process.platform !== 'win32') return os.release()
  try {
    // 返回真实内核版本（例如 Win7 SP1 = 6.1.7601），不受兼容性清单影响
    return process.getSystemVersion()
  } catch {
    return os.release()
  }
}

/**
 * 识别当前系统。
 * 打包产物只有一个（x64 / ia32 各一份），系统差异全部在这里做运行时自适应。
 */
export function detectPlatform(): PlatformProfile {
  const release = readSystemVersion()
  const parts = release.split('.').map((n) => Number.parseInt(n, 10) || 0)
  const key = `${parts[0]}.${parts[1]}`
  const build = parts[2] || 0

  let tier: OsTier = 'other'
  let name = `${process.platform} (${release})`

  if (key === '6.1') {
    tier = 'win7'
    name = 'Windows 7'
  } else if (key === '6.2' || key === '6.3') {
    tier = 'win8'
    name = key === '6.2' ? 'Windows 8' : 'Windows 8.1'
  } else if (key === '10.0') {
    if (build >= 22000) {
      tier = 'win11'
      name = 'Windows 11'
    } else {
      tier = 'win10'
      name = 'Windows 10'
    }
  } else if (key === '6.0') {
    name = 'Windows Vista'
  } else if (key === '5.1' || key === '5.2') {
    name = 'Windows XP'
  }

  const needsLegacyGraphics = tier === 'win7' || tier === 'win8'

  let support: SupportLevel = 'unsupported'
  let supportNote = ''

  if (tier === 'win10') {
    support = 'full'
    supportNote = '承诺支持'
  } else if (tier === 'win7') {
    if (build === 7601) {
      support = 'full'
      supportNote = '承诺支持（SP1）'
    } else {
      support = 'unsupported'
      supportNote = `内核 ${release} 不是 SP1，Electron 22 无法启动，请升级到 SP1`
    }
  } else if (tier === 'win8') {
    support = 'incidental'
    supportNote = 'Electron 22 可运行，但未列入测试矩阵'
  } else if (tier === 'win11') {
    support = 'unsupported'
    supportNote = '本项目不承诺支持 Win11（未纳入测试），遇到问题不修复'
  } else {
    supportNote = '非目标平台，仅用于开发调试'
  }

  return { tier, name, release, build, support, supportNote, needsLegacyGraphics }
}

export interface CompatOptions {
  softwareRendering: boolean
  /** 命令行 --force-gpu 强制开启硬件加速 */
  forceGpu: boolean
}

export interface CompatResult {
  softwareRendering: boolean
  notes: string[]
}

/**
 * 图形兼容策略。必须在 app ready 之前调用。
 *
 * Win7/8 上的三个已知坑：
 * 1. CalculateNativeWinOcclusion —— 遮挡计算不可靠，会把已显示窗口误判为被遮挡
 *    并暂停渲染，表现为黑屏。
 * 2. 默认 ANGLE 后端是 D3D11，老显卡或无 WDDM 1.1+ 的虚拟机会失败，
 *    降级到 D3D9 更稳。
 * 3. 部分老驱动在 GPU 合成路径上直接崩，需要整个软件渲染兜底。
 *
 * Win10 上不需要任何降级，保持硬件加速。
 */
export function applyPlatformCompat(profile: PlatformProfile, opts: CompatOptions): CompatResult {
  const notes: string[] = []

  if (process.platform !== 'win32') {
    return { softwareRendering: false, notes }
  }

  if (!profile.needsLegacyGraphics) {
    notes.push('硬件加速')
    logger.info('compat', `${profile.name}(${profile.release}) 图形策略: ${notes.join(' / ')}`)
    return { softwareRendering: false, notes }
  }

  app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion')
  notes.push('关闭窗口遮挡计算')

  const software = opts.softwareRendering && !opts.forceGpu
  if (software) {
    app.disableHardwareAcceleration()
    app.commandLine.appendSwitch('disable-gpu')
    app.commandLine.appendSwitch('disable-gpu-compositing')
    app.commandLine.appendSwitch('disable-direct-composition')
    notes.push('软件渲染（老显卡兼容）')
  } else {
    app.commandLine.appendSwitch('disable-gpu-compositing')
    app.commandLine.appendSwitch('use-angle', 'd3d9')
    notes.push('ANGLE 降级到 D3D9')
  }

  logger.info('compat', `${profile.name}(${profile.release}) 图形策略: ${notes.join(' / ')}`)
  return { softwareRendering: software, notes }
}
