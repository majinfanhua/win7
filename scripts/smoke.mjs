/**
 * 无头启动自检。
 *
 * 用本地构建产物跑一遍 --self-test：主进程启动 → 渲染进程加载 →
 * 页面内自检（React 挂载 / Monaco 实例化 / IPC 可用）→ 输出 JSON 并退出。
 *
 * Linux 上无 DISPLAY 时自动套 xvfb；CI 里同样用这个入口（见 .github/workflows/build.yml）。
 *
 * 支持追加参数，方便在本地复现 CI 的那几次不同配置的运行：
 *
 *   npm run smoke                                  # 默认档
 *   npm run smoke -- --capability-profile=win7     # 强制 Win7 能力档
 *   npm run smoke -- --software --self-test-out=t.json
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const entry = path.resolve('out/main/index.js')
if (!fs.existsSync(entry)) {
  console.error('[smoke] 未找到构建产物，请先执行：npm run build')
  process.exit(1)
}

const electronBin = path.resolve(
  'node_modules/electron/dist',
  process.platform === 'win32' ? 'electron.exe' : 'electron'
)
if (!fs.existsSync(electronBin)) {
  console.error('[smoke] 未找到 Electron 二进制，请先执行：npm install')
  process.exit(1)
}

// 追加参数直接透传给应用。
// 之所以需要它：CI 里跑了几次不同配置的自检（默认档 / Win7 档），
// 若本地不能照跑，那些分支就只能在 CI 上试错，改一行等一次流水线。
const extra = process.argv.slice(2)
const hasOut = extra.some((arg) => arg.startsWith('--self-test-out='))

const appArgs = ['.', '--self-test', ...(hasOut ? [] : ['--self-test-out=selftest.json']), ...extra]
// Linux 上 chrome-sandbox 通常不是 setuid-root（容器里、或普通用户解包都会这样），
// Chromium 会直接 FATAL 退出（setuid_sandbox_host.cc: SUID sandbox helper binary
// was found, but is not configured correctly）。这只是启动自检，降级关掉即可。
if (process.platform === 'linux') appArgs.push('--no-sandbox')

const useXvfb = process.platform === 'linux' && !process.env.DISPLAY
const command = useXvfb ? 'xvfb-run' : electronBin
const args = useXvfb ? ['-a', '--server-args=-screen 0 1440x900x24', electronBin, ...appArgs] : appArgs

console.log(`[smoke] 启动自检${useXvfb ? '（xvfb 无头模式）' : ''}…`)

const result = spawnSync(command, args, {
  stdio: 'inherit',
  timeout: 120_000,
  env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' }
})

if (result.error) {
  console.error(`[smoke] 启动失败：${result.error.message}`)
  process.exit(1)
}

const report = path.resolve(
  extra.find((arg) => arg.startsWith('--self-test-out='))?.slice('--self-test-out='.length) ||
    'selftest.json'
)
if (fs.existsSync(report)) {
  console.log('\n[smoke] 自检报告：')
  console.log(fs.readFileSync(report, 'utf8'))
}

if (result.status !== 0) {
  console.error(`\n[smoke] 自检未通过（退出码 ${result.status}）`)
  process.exit(result.status ?? 1)
}

console.log('\n[smoke] 通过')
