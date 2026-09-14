import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { installDevApiStub } from './dev-api-stub'
import { applyTheme, readTheme } from './theme'
import './styles/global.css'

/**
 * 必须放在 render 之前：App 的 useEffect 一跑就会调 window.api。
 * Electron 里 preload 已注入真实 api，这个函数会直接返回 false，什么也不做；
 * 只有「用普通浏览器打开 dev server」时才会真的装上桩。
 */
installDevApiStub()

// 主题要在首次渲染前落到 <html> 上，否则浅色主题会先闪一下深色
applyTheme(readTheme())

/*
 * 当前版本界面里没有编辑器，所以 Monaco 的 worker 注入也一并去掉了
 * —— 那 5 个 worker import 会把渲染包从几百 KB 涨到 6 MB。
 *
 * 以后恢复 EditorPane 时，把下面这段和对应的 worker import 一起加回来，
 * 否则编辑器能显示，但没有补全与语法校验：
 *
 *   import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker'
 *   ...（json / css / html / ts）
 *   ;(self as unknown as { MonacoEnvironment: MonacoEnv }).MonacoEnvironment = {
 *     getWorker: (_id, label) => ...
 *   }
 */

const container = document.getElementById('root')
if (!container) throw new Error('未找到 #root 挂载点')

ReactDOM.createRoot(container).render(
  React.createElement(React.StrictMode, null, React.createElement(App))
)

/**
 * 自检入口：主进程 --self-test 时调用。
 * 不是检查“页面有没有返回”，而是检查 React 挂载、对话界面渲染、IPC 通道可用。
 *
 * 关键点：这些事都是异步完成的，而 __SELFTEST__ 是在 did-finish-load 那一刻被调用的，
 * 那时 React 18 并发渲染还没提交、store.init() 还没回来。所以不能瞬时采样，
 * 每一项都要等（waitFor），否则自检会随机失败。
 */
window.__SELFTEST__ = async () => {
  const checks: Record<string, unknown> = {}

  const waitFor = async (predicate: () => boolean, timeoutMs: number): Promise<boolean> => {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (predicate()) return true
      await new Promise((resolve) => setTimeout(resolve, 120))
    }
    return predicate()
  }

  checks.root = Boolean(document.getElementById('root'))

  // App.tsx 在 store.init()（含 IPC 往返）完成后才把 data-app-ready 置为 1
  checks.reactMounted = await waitFor(
    () => Boolean(document.querySelector('[data-app-ready="1"]')),
    20_000
  )
  checks.domNodes = document.querySelectorAll('*').length
  checks.title = document.title

  // 界面真的渲染出来了：顶栏 + 对话输入区
  checks.topbar = Boolean(document.querySelector('.topbar'))
  checks.composer = Boolean(document.querySelector('.composer'))
  checks.theme = document.documentElement.dataset.theme || ''

  // preload 的 contextBridge 注入时机也不保证早于页面脚本；
  // 浏览器预览模式下这个值来自 dev 桩，不能算通过
  checks.apiReady = await waitFor(() => typeof window.api === 'object', 5_000)

  // 验证 IPC 通道真的能通
  try {
    const runtime = await window.api.runtime()
    checks.ipc = true
    checks.osName = runtime.osName
    checks.osTier = runtime.osTier
    checks.softwareRendering = runtime.softwareRendering
    checks.chrome = runtime.chrome
  } catch (err) {
    checks.ipc = false
    checks.ipcError = String(err)
  }

  // 浏览器预览模式下 api / ipc 都来自 dev 桩，是假的，不能当成真实环境通过自检
  checks.devApiStub = Boolean(window.__DEV_API_STUB__)

  /*
   * 工具能力。
   *
   * 它同时决定两件事：AI 拿到的工具表、设置界面显示什么。
   * 算错了不会报错，只会静默地“AI 不会用工具”或“设置页写着空的”，
   * 所以这里必须断言，不能靠肉眼看日志。
   */
  // checks 是 Record<string, unknown>，后续要参与运算的基准值先存在局部变量里
  let baseEffectiveCount = 0
  let baseMode = ''
  try {
    const caps = await window.api.capabilities()
    baseEffectiveCount = caps.effective.length
    baseMode = caps.mode
    checks.capabilityProfile = caps.profile
    checks.capabilityMode = caps.mode
    checks.capabilityOverridden = caps.overridden
    checks.capabilityDetected = caps.detected
    checks.capabilityEffective = caps.effective
    checks.capabilityEffectiveCount = caps.effective.length
    // 被拦下的每一项都要有原因，否则用户看到“少了一个”却不知道为啥
    checks.capabilityFiltered = caps.filtered.map((item) => `${item.name}: ${item.reason}`)
    // 每个生效的工具都要有中文名，否则设置界面会漏出英文标识
    checks.capabilityLabelsComplete = caps.effective.every((name) => Boolean(caps.labels[name]))
    checks.capabilityReasonsComplete = caps.filtered.every((item) => Boolean(item.reason))
    // 生效与未启用应当不重不漏地覆盖全部工具
    checks.capabilityPartitionOk =
      caps.effective.length + caps.filtered.length === Object.keys(caps.labels).length
    checks.capabilityOk =
      caps.effective.length > 0 &&
      checks.capabilityLabelsComplete &&
      checks.capabilityReasonsComplete &&
      checks.capabilityPartitionOk &&
      caps.notes.length > 0
  } catch (err) {
    checks.capabilityOk = false
    checks.capabilityError = String(err)
  }

  /*
   * 设置那一层得单独验。
   *
   * --capability-profile 只能验探测，验不了「设置改了到底生不生效」。
   * 而设置这条路有两个容易静默出错的地方：
   *   1. normalize() 是白名单式的 —— 新增的顶层 section 没加进去，
   *      改完存盘、重启就没了，而且不报错；
   *   2. setConfig(patch) 顶层是浅合并 —— 少传一个字段会把整个 section 替掉。
   * 两个坑都不会抛异常，只会“设置页显示成功但 AI 还是用不了工具”，
   * 所以必须真写一次、真读一次。
   *
   * 自检跑在带 -selftest 后缀的独立 userData 里，改配置不会影响正常使用；
   * 但不管成败都要恢复，否则下次自检的起点就变了。
   */
  try {
    const before = await window.api.getConfig()

    // 挑一个确定会生效的保守设置：只放开文件读写，并单独关掉一个
    await window.api.setConfig({
      capability: { mode: 'conservative', disabled: ['readFile'] }
    })
    const changed = await window.api.capabilities()

    // 读回来的配置也要真的变了 —— 这一条同时盖住 normalize() 白名单陷阱
    const persisted = (await window.api.getConfig()).capability
    checks.capabilitySavedMode = persisted.mode
    checks.capabilitySavedDisabled = persisted.disabled
    checks.capabilitySettingsPersisted =
      persisted.mode === 'conservative' && persisted.disabled.includes('readFile')

    checks.capabilityModeApplied = changed.mode === 'conservative'
    checks.capabilityDisabledApplied = !changed.effective.includes('readFile')
    checks.capabilityDisabledReason =
      changed.filtered.find((item) => item.name === 'readFile')?.reason || ''
    // 保守模式不放开命令类工具（它们现在还没实现，所以换个角度验：
    // 生效集必须真的变小了，否则说明设置没起作用）
    checks.capabilityShrank = changed.effective.length < baseEffectiveCount

    // 恢复现场
    await window.api.setConfig({ capability: before.capability })
    const restored = await window.api.capabilities()
    checks.capabilityRestored =
      restored.mode === baseMode && restored.effective.length === baseEffectiveCount

    checks.capabilitySettingsOk =
      checks.capabilitySettingsPersisted &&
      checks.capabilityModeApplied &&
      checks.capabilityDisabledApplied &&
      checks.capabilityShrank &&
      checks.capabilityRestored
  } catch (err) {
    checks.capabilitySettingsOk = false
    checks.capabilitySettingsError = String(err)
  }

  /*
   * 设置页的进出。
   *
   * 设置从弹窗改成了独立页面，而“改成页面”最容易坏的地方不是样式，是导航：
   * 点了没反应、进去了出不来、或者切页时把对话面板卸载掉（聊天记录全丢）。
   * 这三件事人工点一遍也能发现，但等发到学生机上才发现就太晚了。
   */
  try {
    const openBtn = document.querySelector('.topbar [aria-label="设置"]') as HTMLElement | null
    checks.settingsButtonFound = Boolean(openBtn)
    openBtn?.click()

    checks.settingsPageOpened = await waitFor(
      () => Boolean(document.querySelector('.settings-page')),
      5_000
    )
    // 对话面板必须还在 DOM 里（只是被 CSS 藏起来），否则回来聊天记录就没了
    checks.chatPanelKeptMounted = Boolean(document.querySelector('.composer'))

    const backBtn = document.querySelector(
      '.settings-page [aria-label="返回"]'
    ) as HTMLElement | null
    checks.settingsBackButtonFound = Boolean(backBtn)
    backBtn?.click()

    checks.settingsPageClosed = await waitFor(
      () => !document.querySelector('.settings-page'),
      5_000
    )

    checks.settingsNavOk =
      checks.settingsButtonFound &&
      checks.settingsPageOpened &&
      checks.chatPanelKeptMounted &&
      checks.settingsBackButtonFound &&
      checks.settingsPageClosed
  } catch (err) {
    checks.settingsNavOk = false
    checks.settingsNavError = String(err)
  }

  const ok = Boolean(
    checks.root &&
      checks.reactMounted &&
      checks.topbar &&
      checks.composer &&
      checks.apiReady &&
      checks.ipc &&
      checks.capabilityOk &&
      checks.capabilitySettingsOk &&
      checks.settingsNavOk &&
      !checks.devApiStub
  )
  return { ok, checks }
}
