import { useEffect, useRef } from 'react'
// 从收口模块取 monaco，而不是 `import * as monaco from 'monaco-editor'` ——
// 后者会把 82 种语言的语法定义全打进主包（详见 monaco-setup.ts 的说明）
import monaco from '../monaco-setup'
import { useAppStore } from '../store/useAppStore'

/**
 * 编辑器面板。
 *
 * 用一个 editor 实例 + 切标签时 setValue，而不是每个标签一个 model：
 * 同时打开的文件数量有限，简单实现更不容易出错。
 *
 * 与磁盘的同步分两个方向，都在这里收口：
 *   - 往上：光标位置回写 store，供切标签/重启恢复
 *   - 往下：store 里的 content 变了（AI 改的、外部改的）就 setValue
 * 第二个方向以前是缺的 —— AI 改完文件编辑器还显示旧代码，
 * 学生看到「AI 说改好了但代码没变」，那是致命的。
 */
export default function EditorPane(): JSX.Element {
  const tabs = useAppStore((s) => s.tabs)
  const activePath = useAppStore((s) => s.activePath)
  const setActive = useAppStore((s) => s.setActive)
  const closeTab = useAppStore((s) => s.closeTab)
  const setContent = useAppStore((s) => s.setContent)
  const setCursor = useAppStore((s) => s.setCursor)
  const saveActive = useAppStore((s) => s.saveActive)
  const undoLast = useAppStore((s) => s.undoLast)
  const editorConfig = useAppStore((s) => s.config?.editor)
  const workspace = useAppStore((s) => s.workspace)
  const openWorkspace = useAppStore((s) => s.openWorkspace)

  const hostRef = useRef<HTMLDivElement | null>(null)
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null)
  const currentPathRef = useRef<string>('')
  /** 程序性 setValue 时抑制 onDidChange，避免把切标签/外部重载误判为编辑 */
  const suppressRef = useRef(false)
  /** 上一次写进编辑器的内容，用来判断 store 里的 content 是不是真的变了 */
  const lastValueRef = useRef<string>('')

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
      if (!path) return
      lastValueRef.current = editor.getValue()
      setContent(path, lastValueRef.current)
    })

    // 光标变化就回写，供「关掉再打开回到原处」和重启恢复。
    // store 内部做了去重与防抖，不会每移动一格就写盘
    const cursorSub = editor.onDidChangeCursorPosition((e) => {
      const path = currentPathRef.current
      if (!path) return
      setCursor(path, e.position.lineNumber, e.position.column)
    })

    return () => {
      sub.dispose()
      cursorSub.dispose()
      editor.dispose()
      editorRef.current = null
      currentPathRef.current = ''
      lastValueRef.current = ''
    }
  }, [setContent, setCursor])

  /**
   * 切标签 / 外部内容变化时就写编辑器。
   *
   * 两种情况共用一个 effect：
   *   a) 切换标签 —— 路径变了，整篇换掉并回到上次的光标
   *   b) 同一个标签、内容变了 —— AI 或外部改了磁盘，静默刷新
   * 原来只处理了 (a)，所以 AI 改完文件编辑器不动。
   */
  useEffect(() => {
    const editor = editorRef.current
    if (!editor || !active) return

    const switched = currentPathRef.current !== active.path
    if (!switched && active.content === lastValueRef.current) return

    // 保留滚动位置：AI 只是改了中间几行时，把视图拽回顶部很打断思路
    const scrollTop = switched ? 0 : editor.getScrollTop()
    const cursor = editor.getPosition()

    currentPathRef.current = active.path
    suppressRef.current = true
    editor.setValue(active.content)
    const model = editor.getModel()
    if (model) monaco.editor.setModelLanguage(model, active.language)
    suppressRef.current = false
    lastValueRef.current = active.content

    if (switched) {
      // 恢复上次在这个文件里的光标，越界时 Monaco 会自己夹到文件末尾。
      // 显式传位置：这个方法不带参数时在部分版本上不会做任何事
      const pos = { lineNumber: active.line, column: active.column }
      editor.setPosition(pos)
      editor.revealPositionInCenterIfOutsideViewport(pos)
    } else if (cursor) {
      // 同一文件被外部改了：光标尽量停在原处，不跳走
      editor.setPosition(cursor)
    }
    editor.setScrollTop(scrollTop)
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

  /** Ctrl+S 存当前文件。编辑器聚焦时走这里，比依赖主进程菜单更快 */
  const onKeyDown = (e: React.KeyboardEvent): void => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
      e.preventDefault()
      void saveActive()
    }
  }

  const aiTouched = Boolean(active?.aiTouchedAt)

  return (
    <div className="editor-pane" onKeyDown={onKeyDown}>
      <div className="tabs">
        {tabs.map((tab) => (
          <div
            key={tab.path}
            className={`tab${tab.path === activePath ? ' active' : ''}`}
            title={tab.path}
            onClick={() => setActive(tab.path)}
          >
            <span className="tab-name">
              {tab.name}
              {tab.dirty ? ' •' : ''}
            </span>
            <button
              className="close"
              aria-label={`关闭 ${tab.name}`}
              onClick={(e) => {
                e.stopPropagation()
                closeTab(tab.path)
              }}
            >
              ×
            </button>
          </div>
        ))}
        {tabs.length === 0 && <div className="tab-placeholder" />}
      </div>

      {/*
        AI 改动横幅。
        这是「AI 改完文件」这件事在界面上唯一的显式痕迹 ——
        没有它，学生只能靠逐行比对来确认 AI 到底动了哪里。
      */}
      {aiTouched && active && (
        <div className="ai-banner">
          <span className="ai-banner-dot" />
          <span className="ai-banner-text">AI 修改了 {active.name}，已自动载入</span>
          <span className="spacer" />
          <button className="ghost btn-xs" onClick={() => void undoLast(active.path)}>
            撤销这次修改
          </button>
          <button className="ghost btn-xs" onClick={() => void saveActive()}>
            保留
          </button>
        </div>
      )}

      <div className={`editor-host${tabs.length === 0 ? ' is-empty' : ''}`} ref={hostRef}>
        {/* Monaco 挂在这里。空态是叠在它上面的一层，不卸载 Monaco 实例 ——
            卸载重建的开销比藏一层大得多 */}
        {tabs.length === 0 && (
          <div className="editor-empty">
            <div className="editor-empty-title">
              {workspace ? '从右侧文件树选一个文件打开' : '还没有打开项目'}
            </div>
            {!workspace && (
              <button className="btn-primary btn-sm" onClick={() => void openWorkspace()}>
                选择一个文件夹
              </button>
            )}
            <div className="editor-empty-hint">
              也可以直接问 AI，它读写的文件会自动在这里打开
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
