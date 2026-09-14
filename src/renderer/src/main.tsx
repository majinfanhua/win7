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

  const ok = Boolean(
    checks.root &&
      checks.reactMounted &&
      checks.topbar &&
      checks.composer &&
      checks.apiReady &&
      checks.ipc &&
      !checks.devApiStub
  )
  return { ok, checks }
}
