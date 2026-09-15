import { useEffect, useRef, useState } from 'react'
import { useAppStore } from '../store/useAppStore'
import FileTree from './FileTree'
import TreeOverlays from './file-tree/TreeOverlays'
import { useFileTreeController } from './file-tree/useFileTreeController'

/**
 * 左侧栏。
 *
 * 四块内容自上而下：
 *   1. 产品标识 + 侧栏收起按钮
 *   2. 「新对话 / Skills / MCP」三个动作
 *   3. 工作空间与最近会话两个分组列表（工作空间可切换，会话可点击/删除）
 *   4. 当前项目的文件树（可折叠）
 *
 * 文件树从右侧挪进来，是因为内容区改成了「编辑器在左、对话在右」：
 * 对话必须紧贴编辑器才好边看边问，而文件树本来就和「项目 / 会话」是一类东西，
 * 跟它们放同一栏更符合直觉（VS Code 就是这么分的）。
 *
 * 所有列表都从 store 读，而 store 的数据来自 config.json ——
 * 关掉应用再打开还在，这是「最近会话」能用的前提。
 */

type Props = {
  collapsed: boolean
  onToggle: () => void
  onOpenSettings: () => void
  onNewSession: () => void
}

function relTime(iso: string): string {
  if (!iso) return ''
  const at = new Date(iso).getTime()
  if (!Number.isFinite(at)) return ''
  const diff = Date.now() - at
  if (diff < 60_000) return '刚刚'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`
  if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)} 天前`
  return new Date(at).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' })
}

/** 路径太长时只留末尾两段，列表里不会撑破 */
function shortPath(target: string): string {
  const parts = target.split(/[\\/]/).filter(Boolean)
  return parts.length <= 2 ? target : `…/${parts.slice(-2).join('/')}`
}

/** 工具能力模式的中文短标签 */
function modeLabel(mode?: string): string {
  if (mode === 'full') return '全开'
  if (mode === 'safe') return '保守'
  return '自动'
}

export default function Sidebar({
  collapsed,
  onToggle,
  onOpenSettings,
  onNewSession
}: Props): JSX.Element {
  const workspace = useAppStore((s) => s.workspace)
  const workspaces = useAppStore((s) => s.workspaces)
  const sessions = useAppStore((s) => s.sessions)
  const sessionId = useAppStore((s) => s.sessionId)
  const config = useAppStore((s) => s.config)
  const openWorkspace = useAppStore((s) => s.openWorkspace)
  const openWorkspaceAt = useAppStore((s) => s.openWorkspaceAt)
  const removeWorkspace = useAppStore((s) => s.removeWorkspace)
  const removeSession = useAppStore((s) => s.removeSession)
  const openSession = useAppStore((s) => s.openSession)
  const sessionLoading = useAppStore((s) => s.sessionLoading)
  const treeOpen = useAppStore((s) => s.treeOpen)
  const setTreeOpen = useAppStore((s) => s.setTreeOpen)

  const [showSkills, setShowSkills] = useState(false)
  const [showMcp, setShowMcp] = useState(false)
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
      <div className="sidenav-head">
        <span className="sidenav-logo">H</span>
        {!collapsed && <span className="sidenav-title">HangKe</span>}
        <span className="spacer" />
        <button
          className="sidenav-icon"
          aria-label={collapsed ? '展开侧栏' : '收起侧栏'}
          title={collapsed ? '展开侧栏' : '收起侧栏'}
          onClick={onToggle}
        >
          <PanelIcon />
        </button>
      </div>

      <div className="sidenav-body">
        {/*
          上半段：动作键 + 工作区/会话两个列表。
          单独包一层是为了让它在文件树很长时自己滚动，
          而不是把整个侧栏（含文件树）一起推长。
        */}
        <div className="sidenav-top">
        <button className="nav-action" onClick={onNewSession} title="新建会话（Ctrl+N）">
          <PlusIcon />
          {!collapsed && <span>新对话</span>}
        </button>

        <button
          className={`nav-action${showSkills ? ' active' : ''}`}
          onClick={() => {
            setShowSkills((v) => !v)
            setShowMcp(false)
          }}
          title="查看当前可用的工具能力"
        >
          <SparkIcon />
          {!collapsed && (
            <>
              <span>Skills</span>
              <span className="spacer" />
              <span className="nav-count">{modeLabel(config?.capability.mode)}</span>
            </>
          )}
        </button>

        <button
          className={`nav-action${showMcp ? ' active' : ''}`}
          onClick={() => {
            setShowMcp((v) => !v)
            setShowSkills(false)
          }}
          title="接入外部工具服务"
        >
          <PlugIcon />
          {!collapsed && (
            <>
              <span>MCP</span>
              <span className="spacer" />
              <span className="nav-count">{config?.ai.baseUrl ? '已配' : '未配'}</span>
            </>
          )}
        </button>

        {!collapsed && showSkills && (
          <div className="nav-pop">
            <div className="nav-pop-title">本机生效的工具能力</div>
            <div className="nav-pop-text">
              共 {config ? '—' : '—'} 项。完整清单与逐个开关在「设置 → 工具能力」里。
            </div>
            <button className="nav-pop-link" onClick={onOpenSettings}>
              去设置里看
            </button>
          </div>
        )}

        {!collapsed && showMcp && (
          <div className="nav-pop">
            <div className="nav-pop-title">MCP 服务器</div>
            <div className="nav-pop-text">
              当前版本用中转站直连模型，MCP 外部工具服务尚未接入。
            </div>
            <button className="nav-pop-link" onClick={onOpenSettings}>
              配置 AI 模型
            </button>
          </div>
        )}

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

        {/* ---------------- 最近会话 ---------------- */}
        {!collapsed && (
          <div className="nav-group">
            <div className="nav-group-head">
              <span>最近会话</span>
              <span className="spacer" />
              <span className="nav-count">{sessions.length}</span>
            </div>
            {sessions.length === 0 && (
              <div className="nav-empty">还没有会话记录，发一条消息就会出现在这里</div>
            )}
            {sessions.map((item) => (
              <div key={item.id} className="nav-item-row">
                <button
                  className={`nav-item${sessionId === item.id ? ' active' : ''}`}
                  title={`${item.title}\n${relTime(item.updatedAt)} · ${item.messageCount} 条消息`}
                  disabled={sessionLoading}
                  onClick={() => void openSession(item.id)}
                >
                  <ChatIcon />
                  <span className="nav-item-name">{item.title}</span>
                  <span className="nav-time">{relTime(item.updatedAt)}</span>
                </button>
                <button
                  className="nav-item-x"
                  aria-label={`删除会话 ${item.title}`}
                  title="删除这条记录"
                  onClick={(e) => {
                    e.stopPropagation()
                    void removeSession(item.id)
                  }}
                >
                  ×
                </button>
              </div>
            ))}
            {workspace && (
              <div className="nav-path" title={workspace}>
                {shortPath(workspace)}
              </div>
            )}
          </div>
        )}
        </div>
        {/* 上半段结束 */}

        {/* ---------------- 文件树 ---------------- */}
        {/*
          只在展开态渲染。收起态（只剩 52px 的图标列）里塞不下文件树，
          而把它也压成图标列没任何意义 —— 树本来就要看名字。
        */}
        {!collapsed && (
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

function PanelIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true">
      <rect x="3.5" y="4.5" width="17" height="15" rx="2.5" fill="none" stroke="currentColor" strokeWidth="1.6" />
      <path d="M9.5 4.5v15" stroke="currentColor" strokeWidth="1.6" />
    </svg>
  )
}

function PlusIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true">
      <path d="M12 5v14M5 12h14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  )
}

function SparkIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true">
      <path
        d="M12 3.5 13.7 9l5.5 1.7-5.5 1.7L12 18l-1.7-5.6L4.8 10.7 10.3 9 12 3.5Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function PlugIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true">
      <path
        d="M9 3.5v5M15 3.5v5M6.5 8.5h11v3a5.5 5.5 0 0 1-11 0v-3ZM12 17v3.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
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

function ChatIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true">
      <path
        d="M20 12.5c0 3.6-3.6 6.5-8 6.5-.9 0-1.8-.1-2.6-.3L4 20.5l1.5-3.6A6.3 6.3 0 0 1 4 12.5C4 8.9 7.6 6 12 6s8 2.9 8 6.5Z"
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
