import { useCallback, useEffect, useRef, useState } from 'react'
import type { AppConfig } from '@shared/types'
import AiPanel, { type AiPanelHandle } from './components/AiPanel'
import SettingsPage from './components/SettingsPage'
import Sidebar from './components/Sidebar'
import EditorPane from './components/EditorPane'
import { useAppStore } from './store/useAppStore'
import { useIsMobile } from './hooks/useMedia'
import { useSplitter } from './hooks/useSplitter'
import { applyTheme, readTheme, type Theme } from './theme'

/** 当前只有两个视图。以后加文件树 / 编辑器时，这里换成路由表即可 */
type View = 'chat' | 'settings'

/**
 * 顶栏显示的模型名。
 *
 * 读真实配置而不是写死字符串 —— 以前这里硬编码了 'deepseek-v4-flash'，
 * 在设置里换了模型，顶栏纹丝不动，还带个点不动的下拉箭头。
 */
function modelLabel(config: AppConfig | null): string {
  const model = config?.ai.model?.trim()
  return model || '未配置模型'
}

/**
 * 双击分割条时回到的默认比例。
 *
 * 语义是**左侧（编辑器）占内容区的比例**。
 * 0.62 让编辑器略大 —— 代码是主角，对话是间歇用的右栏。
 *
 * 以前顶栏还有「改 / 均 / 问」三个一键预设，已经去掉：
 * 分割条本身就能拖，键盘也能调（←/→），三个按钮占着顶栏位置
 * 却只覆盖三个点，实用性不如双击复位这一个动作。
 */
const DEFAULT_SPLIT = 0.62

/**
 * 两栏布局：左侧导航（含文件树）/ 右侧内容区。
 *
 * 内容区横向分成「编辑器」与「对话」，中间有可拖拽的竖向分割条。
 * 编辑器在左、对话在右 —— 和 Cursor / Windsurf 一致：写代码时眼睛在左边，
 * 提问是间歇动作，放右栏不挡住代码。
 *
 * 拖拽的实现在 hooks/useSplitter.ts，那里只改 CSS 变量不 setState ——
 * 每帧 setState 会让 Monaco 在拖动时明显卡顿。
 */
export default function App(): JSX.Element {
  const ready = useAppStore((s) => s.ready)
  const init = useAppStore((s) => s.init)
  const config = useAppStore((s) => s.config)
  const runtime = useAppStore((s) => s.runtime)
  const workspace = useAppStore((s) => s.workspace)
  const startNewSession = useAppStore((s) => s.startNewSession)
  const openWorkspace = useAppStore((s) => s.openWorkspace)
  const chatOpen = useAppStore((s) => s.config?.explorer.chatOpen ?? true)
  const setChatOpen = useAppStore((s) => s.setChatOpen)

  const [view, setView] = useState<View>('chat')
  const [theme, setTheme] = useState<Theme>(() => readTheme())
  const [navCollapsed, setNavCollapsed] = useState(false)
  /**
   * 对话区占中间栏的比例（0~1）。
   *
   * 存在 store 里而不是组件 state：它要跟着配置落盘（重启恢复上次拖到的位置），
   * 而且 useSplitter 需要它在拖动结束后提交。
   *
   * 只存比值不存像素：窗口大小变化时按比例缩放最自然，
   * 存像素的话最大化窗口后编辑器还是原来那么矮。
   */
  const split = useAppStore((s) => s.split)
  const setSplit = useAppStore((s) => s.setSplit)
  /**
   * 内容区实测宽度。
   *
   * 拖动时要靠它把像素增量换算成比例增量。现在是左右分，所以量的是宽度；
   * 折叠侧栏会改变这个值，所以用 ResizeObserver 而不是监听 window.resize。
   */
  const [stageWidth, setStageWidth] = useState(0)
  const stageRef = useRef<HTMLElement | null>(null)
  /** 由 App 持有 ref，用于「新对话」时清空聊天区 */
  const aiRef = useRef<AiPanelHandle | null>(null)

  const isMobile = useIsMobile()

  const splitter = useSplitter({
    axis: 'vertical',
    containerSize: stageWidth,
    value: split,
    onChange: setSplit,
    // 编辑器最窄 28%（再窄 Monaco 的代码就折行折得没法看），
    // 对话最窄 22%（低于这个宽度消息气泡会挤成一条）
    min: 0.28,
    max: 0.78
  })

  useEffect(() => {
    const el = stageRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver((entries) => {
      const box = entries[0]?.contentRect
      if (box) setStageWidth(box.width)
    })
    ro.observe(el)
    setStageWidth(el.getBoundingClientRect().width)
    return () => ro.disconnect()
  }, [])

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

  // 窄屏默认把两侧收起来，否则中间内容区只剩一条缝
  useEffect(() => {
    if (isMobile) setNavCollapsed(true)
  }, [isMobile])

  const openSettings = useCallback(() => setView('settings'), [])
  const backToChat = useCallback(() => setView('chat'), [])

  const onNewSession = useCallback(() => {
    startNewSession()
    aiRef.current?.reset()
    setView('chat')
  }, [startNewSession, aiRef])

  /**
   * 主进程菜单发过来的动作。
   *
   * 以前整条 onMenu 都没人接 —— 菜单里的「设置…」「打开日志目录」和 Ctrl+, 都是摆设。
   * new-session 是新加的，对应左侧的「新对话」。
   */
  useEffect(() => {
    return window.api.onMenu((action) => {
      if (action === 'settings') {
        setView('settings')
      } else if (action === 'open-logs') {
        void window.api.openLogs()
      } else if (action === 'undo-ai') {
        void useAppStore.getState().undoLast()
      } else if (action === 'new-session') {
        onNewSession()
      }
    })
  }, [onNewSession])

  // Esc 退出设置页；对话区的输入框自己有 Esc 处理，不冲突（它 stopPropagation）
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && view === 'settings') setView('chat')
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [view])

  /**
   * 磁盘上的文件变了（AI 工具写的、或外部程序改的）→ 编辑器自动重载。
   *
   * 这是「AI 改完文件编辑器还显示旧代码」这个问题的修复点。
   * 订阅放在 App 这一层而不是 EditorPane：即使编辑器没挂载（在设置页），
   * 文件树和日志也需要知道有变化。
   */
  useEffect(() => {
    return window.api.onFileChanged((event) => {
      void useAppStore.getState().handleFileChanged(event)
    })
  }, [])

  /**
   * 关窗前把编辑器状态与当前会话立刻落盘。
   *
   * 两者都有防抖，直接关窗会丢掉最后几百毫秒的操作 ——
   * 而「刚打开一个文件就关掉应用」恰好是很常见的动作。
   * 用 beforeunload 而不是组件卸载：卸载不保证一定会跑。
   */
  useEffect(() => {
    const onUnload = (): void => {
      const store = useAppStore.getState()
      store.persistSession()
      void store.flushEditorSession()
    }
    window.addEventListener('beforeunload', onUnload)
    return () => window.removeEventListener('beforeunload', onUnload)
  }, [])

  const nextTheme: Theme = theme === 'dark' ? 'light' : 'dark'
  const inSettings = view === 'settings'

  return (
    <div className="app" data-app-ready={ready ? '1' : '0'}>
      <div className="shell">
        <Sidebar
          collapsed={navCollapsed}
          onToggle={() => setNavCollapsed((v) => !v)}
          onOpenSettings={openSettings}
          onNewSession={onNewSession}
        />

        <div className="main">
          <header className="topbar">
            {/*
              面包屑：项目名 / 模型名。
              点一下去设置页 —— 以前它带个 ▾ 箭头却点不动（点了是开工作区），
              看着像可以切换模型。要么让它真的能改，要么不装那个箭头；
              这里选后者：模型统一在设置页改，指过去就好。
            */}
            <button
              className="crumb"
              title={workspace ? `${workspace}\n点击去设置里切换模型` : '还没有选择项目'}
              onClick={openSettings}
            >
              <FolderIcon />
              <span className="crumb-text">
                {workspace ? workspace.split(/[\\/]/).filter(Boolean).pop() : '未打开项目'}
              </span>
              <span className="crumb-sep">/</span>
              <span className={`crumb-model${config?.ai.model ? '' : ' is-empty'}`}>
                {modelLabel(config)}
              </span>
            </button>

            {/* 开工作区单独一个按钮，不和面包屑混在一起 */}
            <button
              className="bar-btn"
              title="打开文件夹（Ctrl+O）"
              aria-label="打开文件夹"
              onClick={() => void openWorkspace()}
            >
              <OpenFolderIcon />
            </button>

            <span className="spacer" />

            <button
              className="bar-btn"
              title={nextTheme === 'dark' ? '切换到深色' : '切换到浅色'}
              onClick={() => setTheme(nextTheme)}
            >
              {theme === 'dark' ? <SunIcon /> : <MoonIcon />}
            </button>

            <button
              className={`bar-btn${inSettings ? ' active' : ''}`}
              aria-label="设置"
              aria-current={inSettings ? 'page' : undefined}
              title="设置（Ctrl+,）"
              onClick={openSettings}
            >
              <GearIcon />
            </button>

            {/*
              收起/展开对话栏。
              以前这个按钮控制右侧文件树，但文件树已经并进左侧导航了 ——
              现在它控制对话栏：写代码时把对话收起来，能多出 30% 给编辑器。
            */}
            <button
              className={`bar-btn${chatOpen ? ' active' : ''}`}
              title={chatOpen ? '收起对话栏' : '展开对话栏'}
              aria-pressed={chatOpen}
              onClick={() => void setChatOpen(!chatOpen)}
            >
              <PanelIcon />
            </button>
          </header>

          <main
            ref={stageRef}
            className={`stage${inSettings ? ' stage-page' : ''}`}
            /*
              两侧宽度用 calc 从 --split 算出来。
              拖动时 useSplitter 直接改 documentElement 上的 --split，
              这里就跟着变，React 完全不参与 —— 这是拖动流畅的关键。
              松手后 React 状态更新，把 --split 清掉，回落到下面这个默认值。
            */
            style={
              inSettings
                ? undefined
                : ({ '--split': String(split) } as React.CSSProperties)
            }
          >
            {!inSettings && (
              <div className="editor-dock">
                <EditorPane />
              </div>
            )}

            {/*
              竖向分割条。

              它必须排在编辑器与对话「之间」—— 位置由 DOM 顺序决定，
              放最后它就会被挤到容器最右边（实测错位 454px），
              因为前面两栏的宽度加起来已经占满了。
              设置页是全宽单栏，这时不要；对话栏收起时也没有可调的对象。
            */}
            {!inSettings && chatOpen && (
              <div
                className={`splitter is-vertical${splitter.dragging ? ' is-dragging' : ''}`}
                role="separator"
                aria-orientation="vertical"
                aria-label="调整编辑器与对话的宽度"
                aria-valuenow={Math.round(split * 100)}
                aria-valuemin={28}
                aria-valuemax={78}
                tabIndex={0}
                title="拖动调整宽度（双击重置）"
                onPointerDown={splitter.onPointerDown}
                onKeyDown={splitter.onKeyDown}
                onDoubleClick={() => setSplit(DEFAULT_SPLIT)}
              >
                <span className="splitter-grip" aria-hidden="true" />
              </div>
            )}

            {/*
              对话面板始终挂载，只靠 CSS 藏起来（.view 默认 display:none）。
              写成条件渲染的话，去设置页转一圈回来聊天记录就没了 ——
              而「改完设置接着问刚才那个问题」恰恰是最常见的动线。
              注意：即使在设置页，这个 div 也要留在 DOM 里（自检会查 .composer 是否还在）。
            */}
            <div
              className={`view${inSettings ? '' : ' is-active'}`}
              data-chat-closed={chatOpen ? undefined : '1'}
            >
              <AiPanel ref={aiRef} onOpenSettings={openSettings} />
            </div>

            {inSettings &&
              (config ? (
                <SettingsPage initial={config} onBack={backToChat} />
              ) : (
                <div className="settings-page">
                  <div className="page-scroll">
                    <div className="page-body">
                      <div className="muted">正在加载配置…</div>
                    </div>
                  </div>
                </div>
              ))}
          </main>
        </div>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ *
 * 图标
 * ------------------------------------------------------------------ */

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
      <path d="M20.5 14.6A8.6 8.6 0 0 1 9.4 3.5a8.7 8.7 0 1 0 11.1 11.1Z" fill="currentColor" />
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

function FolderIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
      <path
        d="M3.5 6.5A1.5 1.5 0 0 1 5 5h4l1.6 2h8.4A1.5 1.5 0 0 1 20.5 8.5v9A1.5 1.5 0 0 1 19 19H5a1.5 1.5 0 0 1-1.5-1.5v-11Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function OpenFolderIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
      <g fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round">
        <path d="M3.5 6.5A1.5 1.5 0 0 1 5 5h4l1.6 2h8.4A1.5 1.5 0 0 1 20.5 8.5v9A1.5 1.5 0 0 1 19 19H5a1.5 1.5 0 0 1-1.5-1.5v-11Z" />
        <path d="M9 13h6M12 10.5v5" strokeLinecap="round" />
      </g>
    </svg>
  )
}

function PanelIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
      <rect x="3.5" y="4.5" width="17" height="15" rx="2.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <path d="M14.5 4.5v15" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  )
}
