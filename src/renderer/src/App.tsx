import { useEffect, useRef, useState } from 'react'
import FileTree from './components/FileTree'
import EditorPane from './components/EditorPane'
import AiPanel from './components/AiPanel'
import SettingsDialog from './components/SettingsDialog'
import DoctorDialog from './components/DoctorDialog'
import { useAppStore } from './store/useAppStore'

/** 底部输出面板：直接显示主进程转发过来的日志 */
function OutputPanel(): JSX.Element {
  const logs = useAppStore((s) => s.logs)
  const ref = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const el = ref.current
    if (el) el.scrollTop = el.scrollHeight
  }, [logs])

  return (
    <div className="output">
      <div className="panel-title">输出（主进程日志）</div>
      <div className="scroll logs" ref={ref}>
        {logs.length === 0 && <div>暂无日志</div>}
        {logs.map((line, index) => (
          <div key={`${line.time}-${index}`} className={line.level}>
            {`[${line.scope}] ${line.text}`}
          </div>
        ))}
      </div>
    </div>
  )
}

export default function App(): JSX.Element {
  const ready = useAppStore((s) => s.ready)
  const init = useAppStore((s) => s.init)
  const runtime = useAppStore((s) => s.runtime)
  const config = useAppStore((s) => s.config)
  const workspace = useAppStore((s) => s.workspace)
  const openWorkspace = useAppStore((s) => s.openWorkspace)
  const saveActive = useAppStore((s) => s.saveActive)
  const pushLog = useAppStore((s) => s.pushLog)
  const outputOpen = useAppStore((s) => s.outputOpen)
  const toggleOutput = useAppStore((s) => s.toggleOutput)

  const [settingsOpen, setSettingsOpen] = useState(false)
  const [doctorOpen, setDoctorOpen] = useState(false)

  useEffect(() => {
    void init()
  }, [init])

  // 主进程日志与菜单事件
  useEffect(() => {
    const offLog = window.api.onLog((line) => pushLog(line))
    const offMenu = window.api.onMenu((action) => {
      if (action === 'open-folder') void openWorkspace()
      else if (action === 'save') void saveActive()
      else if (action === 'settings') setSettingsOpen(true)
      else if (action === 'doctor') setDoctorOpen(true)
      else if (action === 'open-logs') void window.api.openLogs()
    })
    return () => {
      offLog()
      offMenu()
    }
  }, [openWorkspace, pushLog, saveActive])

  // 快捷键
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (!(e.ctrlKey || e.metaKey)) return
      const key = e.key.toLowerCase()
      if (key === 's') {
        e.preventDefault()
        void saveActive()
      } else if (key === ',') {
        e.preventDefault()
        setSettingsOpen(true)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [saveActive])

  const renderMode = runtime ? (runtime.softwareRendering ? '软件渲染' : '硬件加速') : '—'
  const osLabel = runtime ? `${runtime.osName} ${runtime.arch}` : '检测中…'

  return (
    <div className="app" data-app-ready={ready ? '1' : '0'}>
      <div className="toolbar">
        <button onClick={() => void openWorkspace()}>打开文件夹</button>
        <button onClick={() => void saveActive()}>保存</button>
        <button onClick={toggleOutput}>输出</button>
        <span className="spacer" />
        <span style={{ color: 'var(--text-3)', fontSize: 12 }}>AI 教学编辑器</span>
        <button onClick={() => setDoctorOpen(true)}>环境体检</button>
        <button onClick={() => setSettingsOpen(true)}>设置</button>
      </div>

      <div className="body">
        <FileTree />
        <div className="main">
          <EditorPane />
          {outputOpen && <OutputPanel />}
        </div>
        <AiPanel onOpenSettings={() => setSettingsOpen(true)} />
      </div>

      <div className="statusbar">
        <span>工作区：{workspace || '未打开'}</span>
        <span>系统：{osLabel}</span>
        <span>渲染：{renderMode}</span>
        <span>
          Electron {runtime?.electron || '—'} / Chromium {runtime?.chrome || '—'}
        </span>
      </div>

      {settingsOpen && config && <SettingsDialog initial={config} onClose={() => setSettingsOpen(false)} />}
      {doctorOpen && <DoctorDialog onClose={() => setDoctorOpen(false)} />}
    </div>
  )
}
