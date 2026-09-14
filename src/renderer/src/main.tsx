import React from 'react'
import ReactDOM from 'react-dom/client'
import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker'
import jsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker'
import cssWorker from 'monaco-editor/esm/vs/language/css/css.worker?worker'
import htmlWorker from 'monaco-editor/esm/vs/language/html/html.worker?worker'
import tsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker'
import App from './App'
import './styles/global.css'

/**
 * Monaco 的 Web Worker 必须显式注入，否则语言服务失效
 * （编辑器仍能显示，但没有补全与语法校验）。
 * Electron 下页面跑在 file:// 协议，worker 由 Vite 打包成独立 chunk 后按相对路径加载。
 */
interface MonacoEnv {
  getWorker(moduleId: string, label: string): Worker
}

;(self as unknown as { MonacoEnvironment: MonacoEnv }).MonacoEnvironment = {
  getWorker(_moduleId: string, label: string): Worker {
    if (label === 'json') return new jsonWorker()
    if (label === 'css' || label === 'scss' || label === 'less') return new cssWorker()
    if (label === 'html' || label === 'handlebars' || label === 'razor') return new htmlWorker()
    if (label === 'typescript' || label === 'javascript') return new tsWorker()
    return new editorWorker()
  }
}

const container = document.getElementById('root')
if (!container) throw new Error('未找到 #root 挂载点')

ReactDOM.createRoot(container).render(
  React.createElement(React.StrictMode, null, React.createElement(App))
)

/**
 * 自检入口：主进程 --self-test 时调用。
 * 不是检查“页面有没有返回”，而是检查 React 挂载、Monaco 实例化、IPC 通道可用。
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

  // preload 的 contextBridge 注入时机也不保证早于页面脚本
  checks.apiReady = await waitFor(() => typeof window.api === 'object', 5_000)

  // Monaco 实例化最重，软件渲染下更慢
  checks.monacoMounted = await waitFor(
    () => Boolean(document.querySelector('.monaco-editor')),
    25_000
  )
  // monaco-editor 的 ESM 入口不导出 version，不猜，改为报可观测的实例数
  checks.monacoEditors = document.querySelectorAll('.monaco-editor').length

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

  const ok = Boolean(
    checks.root && checks.reactMounted && checks.apiReady && checks.monacoMounted && checks.ipc
  )
  return { ok, checks }
}
