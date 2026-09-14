import React from 'react'
import ReactDOM from 'react-dom/client'
import * as monaco from 'monaco-editor'
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
 */
window.__SELFTEST__ = async () => {
  const checks: Record<string, unknown> = {}

  checks.root = Boolean(document.getElementById('root'))
  checks.reactMounted = Boolean(document.querySelector('[data-app-ready="1"]'))
  checks.domNodes = document.querySelectorAll('*').length
  checks.title = document.title
  checks.apiReady = typeof window.api === 'object'

  // 等 Monaco 真正实例化（最多 10 秒）
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline && !document.querySelector('.monaco-editor')) {
    await new Promise((resolve) => setTimeout(resolve, 120))
  }
  checks.monacoMounted = Boolean(document.querySelector('.monaco-editor'))
  checks.monacoVersion = (monaco as unknown as { version?: string }).version || 'unknown'

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
