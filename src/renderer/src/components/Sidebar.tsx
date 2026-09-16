import { useEffect, useRef, useState } from 'react'
import { useAppStore } from '../store/useAppStore'
import FileTree from './FileTree'
import TreeOverlays from './file-tree/TreeOverlays'
import { useFileTreeController } from './file-tree/useFileTreeController'

/**
 * 左侧栏。
 *
 * 三块内容自上而下：
 *   1. 产品标识 + 侧栏收起按钮（收起态下 logo 本身就是「展开」入口）
 *   2. 「新对话」动作 + 工作空间分组
 *   3. 当前项目的文件树（展开态可折叠；收起态留一个图标入口）
 *
 * Skills 与 MCP 已移到设置页；「最近会话」已移到 AI 聊天面板顶部。
 * 侧栏因此只负责「项目」这一个维度 —— 动作、工作空间、文件。
 *
 * 文件树从右侧挪进来，是因为内容区改成了「编辑器在左、对话在右」：
 * 对话必须紧贴编辑器才好边看边问，而文件树和「项目」是一类东西，
 * 放同一栏更符合直觉（VS Code 就是这么分的）。
 */

type Props = {
  collapsed: boolean
  onToggleCollapse: () => void
}

/** 路径太长时只留末尾两段，列表里不会撑破 */
function shortPath(target: string): string {
  const parts = target.split(/[\\/]/).filter(Boolean)
  return parts.length <= 2 ? target : `…/${parts.slice(-2).join('/')}`
}

export default function Sidebar({
  collapsed,
  onToggleCollapse
}: Props): JSX.Element {
  const workspace = useAppStore((s) => s.workspace)
  const workspaces = useAppStore((s) => s.workspaces)
  const openWorkspace = useAppStore((s) => s.openWorkspace)
  const openWorkspaceAt = useAppStore((s) => s.openWorkspaceAt)
  const removeWorkspace = useAppStore((s) => s.removeWorkspace)
  const treeOpen = useAppStore((s) => s.treeOpen)
  const setTreeOpen = useAppStore((s) => s.setTreeOpen)

  const [wsMenu, setWsMenu] = useState(false)
  const rootRef = useRef<HTMLDivElement | null>(null)

  /*
   * 「工作空间」分组里的「新建文件 / 新建文件夹」要用到与文件树完全同一套弹层。
   * 这里另起一个 controller 实例而不是从 FileTree 往上提：
   * 两者共享的是 store 状态（childMap / config），而不是组件局部状态，
   * 所以各持一份互不干扰；反之把 controller 提到 Sidebar 再层层下传，
   * 会让 FileTree 多出一堆与它无关的接口。
   */
  const tree = useFileTreeController()

  // 点空白处收起浮层。用 mousedown 而不是 click ——
  // click 会在浮层按钮的 onClick 之前冒泡上来，导致「刚点开就被关掉」
  useEffect(() => {
    const onDown = (e: MouseEvent): void => {
      if (!rootRef.current?.contains(e.target as Node)) setWsMenu(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [])

  return (
    <aside className={`sidenav${collapsed ? ' is-collapsed' : ''}`} ref={rootRef}>
      {/*
        头部：产品标识 + 收起/展开按钮。
        收起态**也保留头部**，但改成「只显示 logo，点一下就展开」——
        收起后侧栏只剩 52px 的图标列，如果连 logo 都没有，整列就是一排
        认不出功能的图标；而 logo 是唯一的身份锚点，一眼就知道这是哪一栏。
        原来的问题是「收起后展开入口藏在图标堆里认不出来」，
        现在那个入口是明确的（logo 自身），并且下方还有工作区/文件树图标。
      */}
      {collapsed ? (
        <button
          className="sidenav-head is-collapsed"
          aria-label="展开侧栏"
          aria-expanded={false}
          title="展开侧栏"
          onClick={onToggleCollapse}
        >
          <img className="sidenav-logo" src="./logo.png" alt="" />
        </button>
      ) : (
        <div className="sidenav-head">
          <img className="sidenav-logo" src="./logo.png" alt="" />
          <span className="sidenav-title">航科教育</span>
          <span className="spacer" />
          <button
            className="sidenav-icon"
            aria-label="收起侧栏"
            aria-expanded
            title="收起侧栏"
            onClick={onToggleCollapse}
          >
            <CollapseIcon />
          </button>
        </div>
      )}

      <div className="sidenav-body">
        {/*
          上半段：动作键 + 工作区/会话两个列表。
          单独包一层是为了让它在文件树很长时自己滚动，
          而不是把整个侧栏（含文件树）一起推长。
        */}
        <div className="sidenav-top">
        {/*
          「新对话」已从这里去掉。
          它现在只在 AI 面板顶部（历史按钮旁）与菜单 Ctrl+N 里 ——
          「开一段新对话」是对话区的事，放在侧栏会让「侧栏 = 项目导航」
          这个定位变得含糊。侧栏只留工作空间与文件树。
        */}

        {/* ---------------- 工作空间 ---------------- */}
        <div className="nav-group">
          {!collapsed && (
            <div className="nav-group-head">
              <span>工作空间</span>
              <span className="spacer" />
              <button
                className="sidenav-icon"
                aria-label="管理工作空间"
                title="管理工作空间"
                onClick={() => setWsMenu((v) => !v)}
              >
                <SlidersIcon />
              </button>
            </div>
          )}

          {!collapsed && wsMenu && (
            <div className="nav-menu">
              <button className="nav-menu-item" onClick={() => { setWsMenu(false); void openWorkspace() }}>
                打开文件夹…
              </button>

              {/*
                新建文件 / 新建文件夹。
                这是本轮补上的断点：以前「工作空间」分组只有「打开文件夹…」，
                建文件夹的唯一入口藏在系统对话框里，建文件则完全没有入口。
                落点固定为当前项目根目录 —— 分组菜单里没有「当前在哪一层」的概念，
                想落在子目录就右键那个子目录。
                没打开项目时置灰（而不是隐藏）：项的位置稳定才好找。
              */}
              <div className="nav-menu-sep" />
              <button
                className="nav-menu-item"
                disabled={!workspace}
                title={workspace ? `在 ${workspace} 下新建文件` : '先打开一个文件夹'}
                onClick={() => { setWsMenu(false); tree.requestNew('file') }}
              >
                新建文件
              </button>
              <button
                className="nav-menu-item"
                disabled={!workspace}
                title={workspace ? `在 ${workspace} 下新建文件夹` : '先打开一个文件夹'}
                onClick={() => { setWsMenu(false); tree.requestNew('dir') }}
              >
                新建文件夹
              </button>

              {workspace && (
                <>
                  <div className="nav-menu-sep" />
                  <button
                    className="nav-menu-item"
                    onClick={() => { setWsMenu(false); void removeWorkspace(workspace) }}
                  >
                    从最近列表移除当前项目
                  </button>
                </>
              )}
            </div>
          )}

          {!workspace && (
            <button className="nav-item" title="点击选择一个文件夹作为工作区" onClick={() => void openWorkspace()}>
              <FolderIcon />
              {!collapsed && <span className="nav-item-name is-muted">尚未打开项目</span>}
            </button>
          )}

          {!collapsed &&
            workspaces.map((item) => (
              <div key={item.path} className="nav-item-row">
                <button
                  className={`nav-item${workspace === item.path ? ' active' : ''}`}
                  title={item.path}
                  onClick={() => void openWorkspaceAt(item.path)}
                >
                  <FolderIcon />
                  <span className="nav-item-name">{item.name}</span>
                </button>
                <button
                  className="nav-item-x"
                  aria-label={`移除 ${item.name}`}
                  title="从最近列表移除（不删磁盘上的目录）"
                  onClick={(e) => {
                    e.stopPropagation()
                    void removeWorkspace(item.path)
                  }}
                >
                  ×
                </button>
              </div>
            ))}
        </div>

        {/*
          「最近会话」已移到 AI 聊天面板顶部（点「历史」展开浮层）。
          理由：会话列表天然属于「对话」这件事，放在聊天栏抬头比放在
          左侧导航里更贴近使用场景 —— 聊到一半想换一段讨论，眼睛不用来回跑。
          侧栏这里只保留工作空间与文件树（那是「项目」维度的东西）。
        */}
        </div>
        {/* 上半段结束 */}

        {/* ---------------- 文件树 ---------------- */}
        {/*
          展开态：完整文件树（要看名字，压成图标没意义）。
          收起态：只留一个「文件树」图标按钮，点它把侧栏展开并打开文件树 ——
          否则 52px 的窄栏里这一栏等于凭空消失，学生以为功能没了。
        */}
        {collapsed ? (
          <div className="nav-group">
            <button
              className={`nav-item${workspace ? '' : ' is-muted'}`}
              aria-label="文件树"
              title={workspace ? '打开文件树（同时展开侧栏）' : '先打开一个文件夹'}
              onClick={() => {
                onToggleCollapse()
                if (workspace) void setTreeOpen(true)
              }}
            >
              <TreeIcon />
            </button>
            <button
              className="nav-item"
              aria-label="工作空间"
              title={workspace ? `当前项目：${workspace}` : '打开文件夹'}
              onClick={() => void openWorkspace()}
            >
              <FolderIcon />
            </button>
          </div>
        ) : (
          <div className={`nav-group nav-group-tree${treeOpen ? ' is-open' : ''}`}>
            <button
              className="nav-group-head is-clickable"
              aria-expanded={treeOpen}
              title={treeOpen ? '收起文件树' : '展开文件树'}
              onClick={() => void setTreeOpen(!treeOpen)}
            >
              <span className={`tree-caret${treeOpen ? ' is-open' : ''}`} aria-hidden="true">
                ▸
              </span>
              <span>文件树</span>
              <span className="spacer" />
              {workspace && (
                <span className="nav-count" title={workspace}>
                  {shortPath(workspace).split('/').pop()}
                </span>
              )}
            </button>

            {/* 用 display 控制而不是条件渲染：树展开时保留滚动位置与展开的目录 */}
            {treeOpen && <FileTree embedded />}
          </div>
        )}

        {/* 收起态只留图标，悬停用原生 title 提示，不做浮层（老系统上浮层容易闪） */}
      </div>

      {/* 「工作空间」分组里点「新建文件 / 新建文件夹」弹出的输入弹层 */}
      <TreeOverlays tree={tree} />
    </aside>
  )
}

/* ------------------------------------------------------------------ *
 * 图标：统一 14px 线性图标，currentColor 上色，深浅主题都不用改
 * ------------------------------------------------------------------ */


/** 收起侧栏：两条竖线夹一个向左的箭头（面板往左收） */
function CollapseIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true">
      <g fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
        <path d="M4.5 5v14" />
        <path d="M19.5 5v14" opacity=".5" />
        <path d="M14.5 12H8.5M11 9l-3 3 3 3" />
      </g>
    </svg>
  )
}

/** 文件树：一个分叉的目录结构 */
function TreeIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true">
      <g fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M6 4.5v13a2 2 0 0 0 2 2h3" />
        <path d="M6 10.5h3a2 2 0 0 0 2-2v-1" />
        <rect x="3.5" y="2.5" width="5" height="4" rx="1" />
        <rect x="15.5" y="10.5" width="5" height="4" rx="1" />
        <rect x="11.5" y="17.5" width="5" height="4" rx="1" />
      </g>
    </svg>
  )
}

function FolderIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true">
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

function SlidersIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true">
      <path
        d="M4 8h10M18 8h2M4 16h4M12 16h8"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
      <circle cx="16" cy="8" r="2" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <circle cx="10" cy="16" r="2" fill="none" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  )
}
