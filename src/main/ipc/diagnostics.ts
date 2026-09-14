import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { app, ipcMain, shell } from 'electron'
import { IPC, type DoctorCheck, type DoctorReport, type RuntimeInfo } from '../../shared/types'
import { getConfigPath } from '../config'
import { getLogFilePath, logger } from '../logger'
import { detectPlatform, type PlatformProfile } from '../platform-compat'

interface CompatState {
  softwareRendering: boolean
  notes: string[]
  platform: PlatformProfile | null
}

const compat: CompatState = { softwareRendering: false, notes: [], platform: null }

export function setCompatState(state: CompatState): void {
  compat.softwareRendering = state.softwareRendering
  compat.notes = state.notes
  compat.platform = state.platform
}

export function getRuntimeInfo(): RuntimeInfo {
  const p = compat.platform || detectPlatform()
  return {
    appVersion: app.getVersion(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    v8: process.versions.v8,
    platform: process.platform,
    arch: process.arch,
    osRelease: p.release,
    osName: p.name,
    osTier: p.tier,
    osBuild: p.build,
    osSupport: p.support,
    osSupportNote: p.supportNote,
    softwareRendering: compat.softwareRendering,
    compatNotes: compat.notes,
    userDataPath: app.getPath('userData'),
    logsPath: path.dirname(getLogFilePath()),
    locale: app.getLocale()
  }
}

function fileExists(p: string): boolean {
  try {
    return fs.existsSync(p)
  } catch {
    return false
  }
}

function system32(name: string): string {
  const root = process.env.SystemRoot || 'C:\\Windows'
  return path.join(root, 'System32', name)
}

function dirWritable(dir: string): boolean {
  try {
    fs.mkdirSync(dir, { recursive: true })
    const probe = path.join(dir, `.probe-${process.pid}`)
    fs.writeFileSync(probe, 'ok')
    fs.unlinkSync(probe)
    return true
  } catch {
    return false
  }
}

/**
 * 环境体检。
 * 目标：真机上出现启动失败 / 白屏时，用户只需把这份报告发回来就能定位问题。
 */
export function buildDoctorReport(): DoctorReport {
  const runtime = getRuntimeInfo()
  const p = compat.platform || detectPlatform()
  const checks: DoctorCheck[] = []

  // 1. 系统与支持等级
  const supportStatus = p.support === 'full' ? 'pass' : p.support === 'incidental' ? 'warn' : 'fail'
  checks.push({
    id: 'os',
    label: '操作系统',
    status: process.platform === 'win32' ? supportStatus : 'warn',
    detail: `${p.name}（内核 ${p.release}）· ${p.supportNote || '非目标平台，仅用于开发调试'}`
  })

  // 2. 架构：产物必须与系统位数一致
  checks.push({
    id: 'arch',
    label: '运行架构',
    status: 'pass',
    detail: `${process.arch}（32 位系统必须使用 ia32 包）`
  })

  if (process.platform === 'win32') {
    // 3. VC++ 运行库：Win7 上最常见的启动失败原因
    const missingVc = ['msvcp140.dll', 'vcruntime140.dll'].filter((n) => !fileExists(system32(n)))
    checks.push({
      id: 'vcruntime',
      label: 'VC++ 2015-2022 运行库',
      status: missingVc.length ? 'fail' : 'pass',
      detail: missingVc.length
        ? `缺少 ${missingVc.join(', ')}，请安装 vc_redist.x86.exe / vc_redist.x64.exe`
        : '已就绪'
    })

    // 4. 通用 C 运行库（Win7 需要 KB2999226）
    const ucrt = fileExists(system32('ucrtbase.dll'))
    checks.push({
      id: 'ucrt',
      label: '通用 C 运行库（KB2999226）',
      status: ucrt ? 'pass' : 'warn',
      detail: ucrt ? '已就绪' : '未检测到 ucrtbase.dll，Win7 建议安装 KB2999226'
    })

    // 5. D3D11 决定能否走硬件加速
    const d3d11 = fileExists(system32('d3d11.dll'))
    checks.push({
      id: 'd3d',
      label: 'Direct3D 11',
      status: d3d11 ? 'pass' : 'warn',
      detail: d3d11 ? '可用于硬件加速' : '未检测到 d3d11.dll，应保持软件渲染'
    })

    // 6. 安装路径字符集
    const appPath = app.getAppPath()
    const asciiPath = /^[\x20-\x7e]*$/.test(appPath)
    checks.push({
      id: 'path-ascii',
      label: '安装路径字符集',
      status: asciiPath ? 'pass' : 'warn',
      detail: asciiPath ? appPath : `路径含非 ASCII 字符，建议改到纯英文路径：${appPath}`
    })
  }

  // 7. 图形策略
  checks.push({
    id: 'gpu',
    label: '渲染模式',
    status: 'pass',
    detail: compat.softwareRendering ? '软件渲染（老系统兼容）' : '硬件加速'
  })

  // 8-10. 写入权限
  checks.push({
    id: 'userdata',
    label: '用户数据目录可写',
    status: dirWritable(app.getPath('userData')) ? 'pass' : 'fail',
    detail: app.getPath('userData')
  })
  checks.push({
    id: 'logs',
    label: '日志目录可写',
    status: dirWritable(path.dirname(getLogFilePath())) ? 'pass' : 'fail',
    detail: getLogFilePath()
  })
  checks.push({ id: 'config', label: '配置文件', status: 'pass', detail: getConfigPath() })

  // 11. 内存
  const freeMb = os.freemem() / 1024 / 1024
  checks.push({
    id: 'memory',
    label: '可用内存',
    status: freeMb > 512 ? 'pass' : 'warn',
    detail: `空闲 ${freeMb.toFixed(0)} MB / 共 ${(os.totalmem() / 1024 / 1024).toFixed(0)} MB`
  })

  // 12. 运行形态
  checks.push({
    id: 'package',
    label: '运行形态',
    status: 'pass',
    detail: app.isPackaged ? '已打包（asar）' : '开发模式（未打包）'
  })

  logger.info('doctor', `体检完成，共 ${checks.length} 项`)
  return { runtime, checks, generatedAt: new Date().toISOString() }
}

export function registerDiagnosticsIpc(): void {
  ipcMain.handle(IPC.appRuntime, () => getRuntimeInfo())
  ipcMain.handle(IPC.appDoctor, () => buildDoctorReport())
  ipcMain.handle(IPC.appOpenLogs, async () => {
    const dir = path.dirname(getLogFilePath())
    const err = await shell.openPath(dir)
    return err || dir
  })
}
