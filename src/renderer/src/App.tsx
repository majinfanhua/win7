import { useCallback, useEffect, useRef, useState } from 'react'
import type { AppConfig } from '@shared/types'
import { SPLIT_MAX, SPLIT_MIN } from '@shared/types'
import AiPanel, { type AiPanelHandle } from './components/AiPanel'
import DoctorDialog from './components/DoctorDialog'
import SettingsPage from './components/SettingsPage'
import Sidebar from './components/Sidebar'
import EditorPane from './components/EditorPane'
import ExplorerPanel from './components/file-tree/ExplorerPanel'
import PreviewPane, { canPreviewFile } from './components/PreviewPane'
import LogDrawer from './components/LogDrawer'
import { useAppStore } from './store/useAppStore'
import { useIsMobile } from './hooks/useMedia'
import { useSplitter } from './hooks/useSplitter'
import { applyTheme, readTheme, type Theme } from './theme'

/**
 * 内容区的视图。
 *
 * `explorer` 是「资源管理器」整页视图：与设置页同级，占满内容区，
 * 而不是在 .stage 里再加一栏 —— 那个布局用 `--split` 做宽度分割，
 * DOM 顺序「编辑器 → 分割条 → 对话」是踩过坑的契约，加栏会连锁破坏它。
 */
type View = 'chat' | 'settings' | 'explorer'

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
   * 环境体检弹层。
   *
   * DoctorDialog 与主进程的 buildDoctorReport()（12 项检查：VC++ 运行库 /
   * UCRT / D3D11 / 路径字符集…）早就写好了，但菜单里的「帮助 → 运行环境体检」
   * 一直没人接 —— 点了什么都不会发生。Win7 上最常见的启动失败恰好就是
   * 缺 VC++ 运行库，这份报告是学生唯一能自助定位的途径，所以必须接上。
   */
  const [doctorOpen, setDoctorOpen] = useState(false)
  /** 日志抽屉。主进程 pushLog 的内容以前没有任何地方显示（见 LogDrawer 注释） */
  const [logsOpen, setLogsOpen] = useState(false)
  /**
   * 内嵌预览面板的开关。
   *
   * 预览的目标跟着「当前激活的标签」走，不单独存一个路径 ——
   * 两份状态会分叉（切了标签而预览还停在上一个文件）。
   */
  const [previewOpen, setPreviewOpen] = useState(false)
  /**
   * 对话区占中间栏的比例（0~1）。
   *
   * 存在 store 里而不是组件 state：它要跟着配置落盘（重启恢复上次拖到的位置），
   * 而且 useSplitter 需要它在拖动结束后提交。
   *
   * 只存比值不存像素：窗口大小变化时按比例缩放最自然，
   * 存像素的话最大化窗口后编辑器还是原来那么矮。
   */
  const activePath = useAppStore((s) => s.activePath)
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

  /**
   * 预览面板占内容区的份额。
   *
   * 基础值 0.3，但要**保证对话栏至少还有 18% 的宽度** ——
   * split 拉到 0.78（上限）时，对话本来只剩 22%，
   * 再让出 30% 就只剩 15.4%，气泡会挤成一条（与 useSplitter 的
   * max=0.78 是同一个约束：18% 是消息还能读的下限）。
   *
   * 所以这里按「对话让出的部分不超过它自己的一半」来夹：
   * 宁可预览窄一点，也不能把对话挤到不可用。
   */
  const previewShare = (() => {
    if (!previewOpen) return 0
    const chatWidth = 1 - split
    // 对话最多让出一半宽度（即至少保留 50%）
    const maxByChat = Math.max(0, chatWidth * 0.5)
    return Math.min(0.3, maxByChat)
  })()

  const splitter = useSplitter({
    axis: 'vertical',
    containerSize: stageWidth,
    value: split,
    onChange: setSplit,
    /*
     * 上下限直接取共享常量，不写字面量。
     *
     * 界面与「落盘时夹取」用的必须是同一组值：以前这里是 0.28/0.78，
     * 而 shared/types 的 SPLIT_MIN/MAX 是 0.2/0.9 —— 拖到 0.25 时
     * 当次会话按越界处理、重启后又被原样读回来，同一次拖动两种表现。
     * 语义：编辑器最窄 28%（再窄 Monaco 折行折得没法看），
     * 对话最窄 22%（低于这个宽度消息气泡会挤成一条）。
     */
    min: SPLIT_MIN,
    max: SPLIT_MAX
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
  /**
   * 顶栏「资源管理器」按钮。
   *
   * 再点一次回到对话（当成开关），而不是切到别的页 ——
   * 用户点它时的意图基本都是「看一眼文件」，看完要回到代码那儿。
   */
  const toggleExplorer = useCallback(
    () => setView((v) => (v === 'explorer' ? 'chat' : 'explorer')),
    []
  )

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
   * doctor / about / show-logs 是后来补齐的：菜单里原本就有这几项，
   * 但 onMenu 不处理就等于点了没反应（比菜单里没有还糟）。
   */
  useEffect(() => {
    return window.api.onMenu((action) => {
      if (action === 'settings') {
        setView('settings')
      } else if (action === 'open-logs') {
        void window.api.openLogs()
      } else if (action === 'show-logs') {
        // 「查看日志」是应用内的抽屉，「打开日志目录」是交系统文件管理器 ——
        // 两个不同的意图，不能合成一个
        setLogsOpen(true)
      } else if (action === 'doctor') {
        setDoctorOpen(true)
      } else if (action === 'about') {
        // 「关于」= 设置页的关于分栏。设置页目前固定从 ai 分栏进，
        // 这里退而求其次打开设置页，比什么都不做要好
        setView('settings')
      } else if (action === 'undo-ai') {
        void useAppStore.getState().undoLast()
      } else if (action === 'new-session') {
        onNewSession()
      }
    })
  }, [onNewSession])

  // Esc 退出设置页 / 资源管理器 / 弹层；对话区的输入框与弹层自己有 Esc 处理，
  // 不冲突（它们都会 stopPropagation）
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      // 弹层优先：开着体检或日志时，Esc 先关它们，不要顺手把设置页也退了
      if (doctorOpen) {
        setDoctorOpen(false)
        return
      }
      if (logsOpen) {
        setLogsOpen(false)
        return
      }
      if (view === 'settings' || view === 'explorer') setView('chat')
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [view, doctorOpen, logsOpen])

  /**
   * 文件树右键「预览文件」→ 打开内嵌预览面板。
   *
   * 订阅 store 的时间戳而不是从 App 往下传回调：右键菜单在文件树组件里，
   * 而面板挂在 App，中间隔着 Sidebar / TreeNode 好几层。
   */
  const previewRequestAt = useAppStore((s) => s.previewRequestAt)
  useEffect(() => {
    if (!previewRequestAt) return
    setPreviewOpen(true)
    // 右键预览时如果停在设置页/资源管理器，得先回到对话视图 ——
    // 那两个视图下 .stage 是单栏的，预览面板不渲染
    setView((v) => (v === 'chat' ? v : 'chat'))
  }, [previewRequestAt])

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
   * 主进程的日志 → store 的 logs → 日志抽屉。
   *
   * 以前这条链是断的：主进程推 evtLog，但渲染层从来没订阅过。
   * 后果不只是少了调试信息 —— `handleFileChanged` 在「AI 改了文件但编辑器里
   * 有未保存改动」时唯一的动作就是 pushLog 一条 warn，那条 warn 没人显示，
   * 学生看到的是「什么都没发生」。所以这个订阅是那条安全警告的通道。
   */
  useEffect(() => {
    return window.api.onLog((line) => {
      useAppStore.getState().pushLog(line)
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
    const onUnload = (event: BeforeUnloadEvent): void => {
      const store = useAppStore.getState()
      store.persistSession()
      void store.flushEditorSession()

      /*
       * 还有未保存的改动时拦一次关窗。
       *
       * 这是 dirty 守卫的最后一道：前两道守的是「关标签」和「换项目」，
       * 但学生更常见的动作是直接点右上角 ×。少了这一道，
       * 「改了半小时没按 Ctrl+S 就关掉」等于全部白写。
       *
       * 用浏览器原生的 beforeunload 而不是自己弹框：Electron 里
       * preventDefault() 会走 Chromium 自己的「离开此网站？」对话框，
       * 它由浏览器进程弹出，不受渲染进程卡死影响 —— 而「渲染进程正忙」
       * 恰好是最需要这道守卫的时候。
       *
       * 不在这里做「自动保存」：那会把学生做到一半的代码写进磁盘，
       * 而磁盘上的版本可能是他有意保留的（比如配合 AI 撤销）。
       */
      if (store.tabs.some((tab) => tab.dirty)) {
        event.preventDefault()
        // 老 Chromium 需要 returnValue 才认；Chromium 108 已改用 preventDefault，
        // 但两个都写上不冲突
        event.returnValue = ''
      }
    }
    window.addEventListener('beforeunload', onUnload)
    return () => window.removeEventListener('beforeunload', onUnload)
  }, [])

  /**
   * Ctrl+Shift+E 切换资源管理器。
   *
   * 与 VS Code 一致，教师从别的编辑器迁过来不用重新学。
   * 只拦这一个组合：Ctrl+E 在 Monaco 里是「查找」，绝不能抢。
   */
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (!e.ctrlKey || !e.shiftKey || e.key.toLowerCase() !== 'e') return
      e.preventDefault()
      toggleExplorer()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [toggleExplorer])

  const nextTheme: Theme = theme === 'dark' ? 'light' : 'dark'
  const inSettings = view === 'settings'
  const inExplorer = view === 'explorer'

  return (
    <div className="app" data-app-ready={ready ? '1' : '0'}>
      <div className="shell">
        <Sidebar
          collapsed={navCollapsed}
          onOpenSettings={openSettings}
          onNewSession={onNewSession}
        />

        <div className="main">
          <header className="topbar">
            {/*
              侧栏折叠/展开。
              放在顶栏**最左侧**且两种状态都在同一个位置 ——
              以前这个按钮在侧栏自己头上，收起后它挤在 52px 的图标列里，
              和别的图标长得一样，学生找不到「把栏拉回来」的入口。
            */}
            <button
              className="bar-btn"
              aria-label={navCollapsed ? '展开侧栏' : '收起侧栏'}
              aria-expanded={!navCollapsed}
              title={navCollapsed ? '展开侧栏' : '收起侧栏'}
              onClick={() => setNavCollapsed((v) => !v)}
            >
              <SidebarIcon collapsed={navCollapsed} />
            </button>

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

            {/*
              资源管理器（整页视图）。
              左栏里那份文件树窄到看不全长文件名，这里给一个占满内容区的形态，
              两边共用同一份数据与同一套菜单，不会出现「这边能建、那边不能」。
            */}
            <button
              className={`bar-btn${view === 'explorer' ? ' active' : ''}`}
              aria-label="资源管理器"
              aria-current={view === 'explorer' ? 'page' : undefined}
              title="资源管理器（Ctrl+Shift+E）"
              onClick={toggleExplorer}
            >
              <ExplorerIcon />
            </button>

            <button
              className={`bar-btn${previewOpen ? ' active' : ''}`}
              aria-label="页面预览"
              aria-pressed={previewOpen}
              title={
                canPreviewFile(activePath)
                  ? '在右侧预览这个页面（保存或 AI 修改后自动刷新）'
                  : '预览（先在编辑器里打开一个 .html 文件）'
              }
              onClick={() => setPreviewOpen((v) => !v)}
            >
              <EyeIcon />
            </button>

            <button
              className="bar-btn"
              title={nextTheme === 'dark' ? '切换到深色' : '切换到浅色'}
              onClick={() => setTheme(nextTheme)}
            >
              {theme === 'dark' ? <SunIcon /> : <MoonIcon />}
            </button>

            <button
              className={`bar-btn${logsOpen ? ' active' : ''}`}
              aria-label="查看日志"
              aria-pressed={logsOpen}
              title="查看日志（最近的主进程与界面消息）"
              onClick={() => setLogsOpen((v) => !v)}
            >
              <ListIcon />
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
            className={`stage${inSettings || inExplorer ? ' stage-page' : ''}`}
            /*
              两侧宽度用 calc 从 --split 算出来。
              拖动时 useSplitter 直接改 documentElement 上的 --split，
              这里就跟着变，React 完全不参与 —— 这是拖动流畅的关键。
              松手后 React 状态更新，把 --split 清掉，回落到下面这个默认值。
            */
            style={
              inSettings || inExplorer
                ? undefined
                : ({
                    '--split': String(split),
                    /*
                     * 预览面板占的份额。
                     *
                     * ⚠️ 必须**从 --split 里切**，不能让预览另占一块宽度：
                     * 编辑器是 split、对话是 (1-split)，两者加起来正好 100%。
                     * 预览再要 30% 就顶到 130%，结果是横向滚动条 +
                     * 对话栏被挤出可视区。
                     *
                     * 所以这里把 previewShare 从两者按比例扣掉：
                     * 编辑器变 split*(1-share)，对话变 (1-split)*(1-share)，
                     * 总和 = (1-share) + share = 100%。比例关系保持不变，
                     * 拖动分割条的语义也就不用改。
                     */
                    '--preview-share': String(previewShare)
                  } as React.CSSProperties)
            }
          >
            {/*
              资源管理器整页视图。
              与设置页一样走 stage-page（单栏全宽），
              完全不参与 .stage 的 --split 宽度分割 —— 那条布局约束一行都不用碰。
            */}
            {inExplorer && <ExplorerPanel />}

            {!inSettings && !inExplorer && (
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
            {!inSettings && !inExplorer && chatOpen && (
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
              className={`view${inSettings || inExplorer ? '' : ' is-active'}`}
              data-chat-closed={chatOpen ? undefined : '1'}
            >
              <AiPanel ref={aiRef} onOpenSettings={openSettings} />
            </div>

            {previewOpen && !inSettings && !inExplorer && (
              <PreviewPane path={canPreviewFile(activePath) ? activePath : ''} onClose={() => setPreviewOpen(false)} />
            )}

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

          {/* 底部日志抽屉。挂在这里而不是 .stage 内部：它是一条横贯整个
              内容区的带子，不该参与 --split 的左右分栏 */}
          {logsOpen && <LogDrawer onClose={() => setLogsOpen(false)} />}
        </div>
      </div>

      {/*
        体检弹层与日志抽屉是「覆盖层」，放在 .shell 外面 ——
        它们是相对视口定位的 fixed 层，嵌在布局里会被祖先的
        overflow / transform 改变定位基准
      */}
      {doctorOpen && <DoctorDialog onClose={() => setDoctorOpen(false)} />}
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

function ExplorerIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
      <g fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round">
        <path d="M3.5 6.5A1.5 1.5 0 0 1 5 5h4l1.6 2h8.4A1.5 1.5 0 0 1 20.5 8.5v9A1.5 1.5 0 0 1 19 19H5a1.5 1.5 0 0 1-1.5-1.5v-11Z" />
        <path d="M3.8 11h16.4" strokeLinecap="round" opacity=".6" />
        <path d="M8 14.5h8M8 17h5" strokeLinecap="round" opacity=".6" />
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

/**
 * 侧栏开关。
 *
 * 两种状态用同一个图形的镜像（面板 + 一条竖线，竖线贴哪边就表示栏在哪边），
 * 而不是换两个完全不同的图标 —— 位置固定、形状连续，学生一眼就知道
 * 「点它是把栏收起来/放出来」。
 */
function SidebarIcon({ collapsed }: { collapsed: boolean }): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
      <rect
        x="3.5"
        y="4.5"
        width="17"
        height="15"
        rx="2.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
      />
      <path
        d={collapsed ? 'M9.5 4.5v15' : 'M14.5 4.5v15'}
        stroke="currentColor"
        strokeWidth="1.5"
      />
    </svg>
  )
}

/** 预览：一只眼睛 */
function EyeIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
      <g fill="none" stroke="currentColor" strokeWidth="1.5">
        <path d="M2.5 12s3.6-6 9.5-6 9.5 6 9.5 6-3.6 6-9.5 6-9.5-6-9.5-6Z" strokeLinejoin="round" />
        <circle cx="12" cy="12" r="2.6" />
      </g>
    </svg>
  )
}

/** 日志抽屉：几行左对齐的文本线 */
function ListIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
      <g stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
        <path d="M4 7h16M4 12h16M4 17h10" />
      </g>
    </svg>
  )
}
