/**
 * 打包入口守卫。
 *
 * 项目约定：只通过 GitHub Actions 打包，开发环境不做 Windows 打包。
 * 原因：交叉打包会拉取目标平台的 Electron 二进制与打包工具链，
 * 既慢又容易和 CI 产物不一致，测试结论没有意义。
 *
 * 本地验证请用：npm run build（构建） / npm run smoke（无头启动自检）
 * 确需本地打包时显式设置 ALLOW_LOCAL_DIST=1。
 */
const inCi = Boolean(process.env.CI)
const allowed = Boolean(process.env.ALLOW_LOCAL_DIST)

if (!inCi && !allowed) {
  console.error('')
  console.error('[dist] 已阻止在开发环境中打包。')
  console.error('[dist] 本项目约定只通过 GitHub Actions 打包。')
  console.error('[dist] 本地验证请用：npm run build / npm run smoke')
  console.error('[dist] 如确需本地打包，请设置环境变量 ALLOW_LOCAL_DIST=1')
  console.error('')
  process.exit(1)
}
