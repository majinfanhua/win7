import { useEffect, useRef } from 'react'
import * as monaco from 'monaco-editor'
import { useAppStore, WELCOME_PATH } from '../store/useAppStore'

/**
 * 编辑器面板。
 * 用一个 editor 实例 + 切 tab 时 setValue，而不是每个 tab 一个 model：
 * 教学场景下同时打开的文件很少，简单实现更不容易出错。
 */
export default function EditorPane(): JSX.Element {
  const tabs = useAppStore((s) => s.tabs)
  const activePath = useAppStore((s) => s.activePath)
  const setActive = useAppStore((s) => s.setActive)
  const closeTab = useAppStore((s) => s.closeTab)
  const setContent = useAppStore((s) => s.setContent)
  const editorConfig = useAppStore((s) => s.config?.editor)

  const hostRef = useRef<HTMLDivElement | null>(null)
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null)
  const currentPathRef = useRef<string>('')
  /** 程序性 setValue 时抑制 onDidChange，避免把切换 tab 误判为编辑 */
  const suppressRef = useRef(false)

  const active = tabs.find((t) => t.path === activePath) || null

  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    const editor = monaco.editor.create(host, {
      value: '',
      language: 'plaintext',
      theme: 'vs-dark',
      automaticLayout: true,
      scrollBeyondLastLine: false,
      renderWhitespace: 'none',
      smoothScrolling: false,
      fontSize: 14,
      tabSize: 2,
      wordWrap: 'on',
      minimap: { enabled: false }
    })
    editorRef.current = editor

    const sub = editor.onDidChangeModelContent(() => {
      if (suppressRef.current) return
      const path = currentPathRef.current
      if (path) setContent(path, editor.getValue())
    })

    return () => {
      sub.dispose()
      editor.dispose()
      editorRef.current = null
      currentPathRef.current = ''
    }
  }, [setContent])

  // 切换 tab：写入内容与语言
  useEffect(() => {
    const editor = editorRef.current
    if (!editor || !active) return
    if (currentPathRef.current === active.path) return

    currentPathRef.current = active.path
    suppressRef.current = true
    editor.setValue(active.content)
    const model = editor.getModel()
    if (model) monaco.editor.setModelLanguage(model, active.language)
    suppressRef.current = false
    editor.setScrollTop(0)
  }, [active])

  // 编辑器选项跟随设置
  useEffect(() => {
    const editor = editorRef.current
    if (!editor || !editorConfig) return
    editor.updateOptions({
      fontSize: editorConfig.fontSize,
      tabSize: editorConfig.tabSize,
      wordWrap: editorConfig.wordWrap ? 'on' : 'off',
      minimap: { enabled: editorConfig.minimap }
    })
  }, [editorConfig])

  return (
    <div className="main" style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
      <div className="tabs">
        {tabs.map((tab) => (
          <div
            key={tab.path}
            className={`tab${tab.path === activePath ? ' active' : ''}`}
            onClick={() => setActive(tab.path)}
          >
            <span>
              {tab.name}
              {tab.dirty ? ' •' : ''}
            </span>
            {tab.path !== WELCOME_PATH && (
              <button
                className="close"
                onClick={(e) => {
                  e.stopPropagation()
                  closeTab(tab.path)
                }}
              >
                ×
              </button>
            )}
          </div>
        ))}
      </div>
      <div className="editor-host" ref={hostRef} />
    </div>
  )
}
