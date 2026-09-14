import { useEffect, useState } from 'react'
import AiPanel from './components/AiPanel'
import SettingsDialog from './components/SettingsDialog'
import { useAppStore } from './store/useAppStore'
import { applyTheme, readTheme, type Theme } from './theme'

/**
 * 当前版本只保留两块：对话 + AI 配置。
 * 文件树 / 编辑器 / 输出面板 / 环境体检都先不渲染（源码还在 components 里，随时可以加回来）。
 */
export default function App(): JSX.Element {
  const ready = useAppStore((s) => s.ready)
  const init = useAppStore((s) => s.init)
  const config = useAppStore((s) => s.config)
  const runtime = useAppStore((s) => s.runtime)

  const [settingsOpen, setSettingsOpen] = useState(false)
  const [theme, setTheme] = useState<Theme>(() => readTheme())

  useEffect(() => {
    void init()
  }, [init])

  useEffect(() => {
    applyTheme(theme)
  }, [theme])

  /**
   * Win7 上会走软件渲染，backdrop-filter（毛玻璃）在软件路径里很贵，
   * 所以把渲染模式挂到 html 上，CSS 里降级成纯色面板。
   */
  useEffect(() => {
    if (runtime) document.documentElement.dataset.perf = runtime.softwareRendering ? 'low' : 'high'
  }, [runtime])

  const nextTheme: Theme = theme === 'dark' ? 'light' : 'dark'

  return (
    <div className="app" data-app-ready={ready ? '1' : '0'}>
      <header className="topbar glass">
        <div className="brand">
          <span className="logo">AI</span>
          <span className="brand-name">教学助手</span>
        </div>
        <span className="spacer" />
        <button
          className="icon-btn"
          title={nextTheme === 'dark' ? '切换到深色' : '切换到浅色'}
          onClick={() => setTheme(nextTheme)}
        >
          {theme === 'dark' ? <SunIcon /> : <MoonIcon />}
          <span>{nextTheme === 'dark' ? '深色' : '浅色'}</span>
        </button>
        <button className="icon-btn" onClick={() => setSettingsOpen(true)}>
          <GearIcon />
          <span>设置</span>
        </button>
      </header>

      <main className="stage">
        <AiPanel onOpenSettings={() => setSettingsOpen(true)} />
      </main>

      {settingsOpen && config && (
        <SettingsDialog initial={config} onClose={() => setSettingsOpen(false)} />
      )}
    </div>
  )
}

function SunIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
      <circle cx="12" cy="12" r="4.2" fill="currentColor" />
      <g stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
        <path d="M12 2.6v2.2M12 19.2v2.2M2.6 12h2.2M19.2 12h2.2M5.4 5.4l1.6 1.6M17 17l1.6 1.6M18.6 5.4L17 7M7 17l-1.6 1.6" />
      </g>
    </svg>
  )
}

function MoonIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
      <path
        d="M20.5 14.6A8.6 8.6 0 0 1 9.4 3.5a8.7 8.7 0 1 0 11.1 11.1Z"
        fill="currentColor"
      />
    </svg>
  )
}

function GearIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
      <path
        fill="currentColor"
        d="M12 8.6a3.4 3.4 0 1 0 0 6.8 3.4 3.4 0 0 0 0-6.8Zm0 5.2a1.8 1.8 0 1 1 0-3.6 1.8 1.8 0 0 1 0 3.6Z"
      />
      <path
        fill="currentColor"
        d="m20.3 13.6.9-.7a.8.8 0 0 0 .2-1l-1.1-1.9a.8.8 0 0 0-.9-.4l-1.1.3a6.7 6.7 0 0 0-1.4-.8l-.2-1.2a.8.8 0 0 0-.8-.6h-2.2a.8.8 0 0 0-.8.6l-.2 1.2c-.5.2-1 .5-1.4.8l-1.1-.3a.8.8 0 0 0-.9.4l-1.1 1.9a.8.8 0 0 0 .2 1l.9.7a6.6 6.6 0 0 0 0 1.6l-.9.7a.8.8 0 0 0-.2 1l1.1 1.9c.2.3.6.5.9.4l1.1-.3c.4.3.9.6 1.4.8l.2 1.2c.1.4.4.6.8.6h2.2c.4 0 .7-.2.8-.6l.2-1.2c.5-.2 1-.5 1.4-.8l1.1.3c.4.1.7-.1.9-.4l1.1-1.9a.8.8 0 0 0-.2-1l-.9-.7c.1-.5.1-1.1 0-1.6Z"
        opacity=".55"
      />
    </svg>
  )
}
