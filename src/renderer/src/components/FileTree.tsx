import { useEffect, useRef, useState } from 'react'
import type { FileNode } from '@shared/types'
import { useAppStore } from '../store/useAppStore'

/**
 * 文件树。
 *
 * 两种位置：
 *   - embedded（嵌在左侧栏里）：不画自己的头与边框，标题由 Sidebar 的分组头承担
 *   - 独立成栏：自带标题与左边框
 * 默认取 embedded —— 现在它只从左侧栏里用，独立模式保留是为了以后
 * 想把它当浮层或侧抽屉打开时不至于重写。
 *
 * 右键菜单的项：
 *   预览文件 / 新建文件 / 新建文件夹 / 重命名 / 删除 /
 *   显示隐藏文件 / 复制路径 / 打开所在目录 / 插入引用 / 刷新
 */

type MenuItem = {
  key: string
  label: string
  kind: 'sep' | 'item'
  danger?: boolean
  checked?: boolean
  run?: () => void
}

function ext(name: string): string {
  const idx = name.lastIndexOf('.')
  return idx > 0 ? name.slice(idx + 1).toLowerCase() : ''
}

function baseName(target: string): string {
  const parts = target.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] || target
}

/**
 * 文件图标。
 *
 * 用「扩展名 → 短标签」而不是引入图标库：
 * 打包体积小，且标签本身就能告诉使用者「这是个 HTML」——
 * 统一的小圆点做十几种文件类型反而更难分辨。
 */
function fileBadge(name: string): { text: string; tone: string } {
  switch (ext(name)) {
    case 'html':
    case 'htm':
      return { text: 'H', tone: 'html' }
    case 'css':
      return { text: 'C', tone: 'css' }
    case 'js':
    case 'mjs':
    case 'cjs':
      return { text: 'J', tone: 'js' }
    case 'ts':
    case 'tsx':
      return { text: 'T', tone: 'ts' }
    case 'json':
      return { text: '{}', tone: 'json' }
    case 'md':
      return { text: 'M', tone: 'md' }
    case 'py':
      return { text: 'Py', tone: 'py' }
    case 'vue':
      return { text: 'V', tone: 'vue' }
    default:
      return { text: '·', tone: 'plain' }
  }
}

function TreeNode({ node, depth }: { node: FileNode; depth: number }): JSX.Element {
  const expanded = useAppStore((s) => Boolean(s.expanded[node.path]))
  const children = useAppStore((s) => s.childMap[node.path])
  const activePath = useAppStore((s) => s.activePath)
  const selectedPath = useAppStore((s) => s.selectedPath)
  const toggleDir = useAppStore((s) => s.toggleDir)
  const openFile = useAppStore((s) => s.openFile)
  const select = useAppStore((s) => s.select)

  const isDir = node.kind === 'dir'
  const isActive = !isDir && activePath === node.path
  const isSelected = selectedPath === node.path
  const badge = isDir ? null : fileBadge(node.name)

  const onClick = (): void => {
    select(node.path)
    if (isDir) void toggleDir(node.path)
    else void openFile(node.path)
  }

  return (
    <>
      <div
        className={`tree-node${isActive ? ' is-active' : ''}${isSelected ? ' is-selected' : ''}`}
        style={{ paddingLeft: 6 + depth * 13 }}
        onClick={onClick}
        title={node.path}
        data-path={node.path}
        data-kind={node.kind}
      >
        {isDir ? (
          <span className={`tree-caret${expanded ? ' is-open' : ''}`} aria-hidden="true">
            ▸
          </span>
        ) : (
          <span className={`tree-badge tone-${badge?.tone}`} aria-hidden="true">
            {badge?.text}
          </span>
        )}
        <span className="tree-name">{node.name}</span>
      </div>
      {isDir &&
        expanded &&
        (children || []).map((child) => (
          <TreeNode key={child.path} node={child} depth={depth + 1} />
        ))}
    </>
  )
}

export default function FileTree({ embedded = true }: { embedded?: boolean } = {}): JSX.Element {
  const workspace = useAppStore((s) => s.workspace)
  const root = useAppStore((s) => (s.workspace ? s.childMap[s.workspace] : undefined))
  const showHidden = useAppStore((s) => Boolean(s.config?.explorer.showHidden))
  const openWorkspace = useAppStore((s) => s.openWorkspace)
  const refreshDir = useAppStore((s) => s.refreshDir)
  const collapseAll = useAppStore((s) => s.collapseAll)
  const createEntry = useAppStore((s) => s.createEntry)
  const renameEntry = useAppStore((s) => s.renameEntry)
  const removeEntry = useAppStore((s) => s.removeEntry)
  const setShowHidden = useAppStore((s) => s.setShowHidden)
  const pushLog = useAppStore((s) => s.pushLog)

  const [menu, setMenu] = useState<{ x: number; y: number; path: string; kind: string } | null>(null)
  const [pos, setPos] = useState({ x: 0, y: 0 })
  const busyRef = useRef(false)
  const menuRef = useRef<HTMLDivElement | null>(null)

  // 关菜单：点任意处 / Esc / 窗口尺寸变化。
  // 用 mousedown 而非 click —— 菜单项自己的 click 会先冒泡到这里把菜单关掉，
  // 导致「点了没反应」
  useEffect(() => {
    if (!menu) return
    const close = (): void => setMenu(null)
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') close()
    }
    document.addEventListener('mousedown', close)
    document.addEventListener('keydown', onKey)
    window.addEventListener('resize', close)
    return () => {
      document.removeEventListener('mousedown', close)
      document.removeEventListener('keydown', onKey)
      window.removeEventListener('resize', close)
    }
  }, [menu])

  /**
   * 菜单超出窗口右侧/底部时往回挪。
   * 不做这个的话，右键最右边或最下面的文件，菜单会有一半在屏幕外，点不到「刷新」。
   */
  useEffect(() => {
    if (!menu) return
    const box = menuRef.current?.getBoundingClientRect()
    if (!box) return
    const x = box.right > window.innerWidth - 8 ? Math.max(8, menu.x - box.width) : menu.x
    const y = box.bottom > window.innerHeight - 8 ? Math.max(8, menu.y - box.height) : menu.y
    setPos({ x, y })
  }, [menu])

  const onContextMenu = (e: React.MouseEvent): void => {
    e.preventDefault()
    const el = (e.target as HTMLElement).closest('[data-path]') as HTMLElement | null
    const path = el?.dataset.path || ''
    if (path) useAppStore.getState().select(path)
    setPos({ x: e.clientX, y: e.clientY })
    setMenu({ x: e.clientX, y: e.clientY, path, kind: el?.dataset.kind || '' })
  }

  const hasTarget = Boolean(menu?.path)
  const isDirTarget = menu?.kind === 'dir'

  /** 新建时的落点：右键文件夹就进那个文件夹，右键文件或空白就落在同级 */
  const parentDir = !menu?.path
    ? workspace
    : isDirTarget
      ? menu.path
      : menu.path.replace(/[\\/][^\\/]*$/, '') || workspace

  /** 包一层 busy，防止连点两次弹出两个 prompt。fn 的返回值全部丢掉 */
  const guard = async (fn: () => Promise<unknown> | unknown): Promise<void> => {
    if (busyRef.current) return
    busyRef.current = true
    try {
      await fn()
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      pushLog({ time: '', level: 'error', scope: 'tree', text: msg })
      window.alert(`操作失败：${msg}`)
    } finally {
      busyRef.current = false
    }
  }

  const doCreate = (kind: 'file' | 'dir'): void => {
    if (!parentDir) return
    const label = kind === 'dir' ? '文件夹' : '文件'
    const seed = kind === 'dir' ? '新建文件夹' : '新建文件.txt'
    const name = window.prompt(`新建${label}名称`, seed)
    if (!name || !name.trim()) return
    void guard(() => createEntry(parentDir, name.trim(), kind))
  }

  const doRename = (): void => {
    if (!menu?.path) return
    const old = baseName(menu.path)
    const name = window.prompt('重命名为', old)
    if (!name || !name.trim() || name.trim() === old) return
    void guard(() => renameEntry(menu.path, name.trim()))
  }

  const doDelete = (): void => {
    if (!menu?.path) return
    const name = baseName(menu.path)
    if (!window.confirm(`确定删除「${name}」？\n\n会先移入回收目录，不会立刻永久删除。`)) return
    void guard(() => removeEntry(menu.path))
  }

  const doCopyPath = (): void => {
    if (!menu?.path) return
    const target = menu.path
    void navigator.clipboard.writeText(target).then(
      () => pushLog({ time: '', level: 'info', scope: 'tree', text: `已复制路径 ${target}` }),
      () => {
        // Electron 里剪贴板几乎不会失败，但无权限时降级成让用户自己复制，
        // 比静默失败强
        window.prompt('自动复制失败，请手动复制：', target)
      }
    )
  }

  const doReveal = (): void => {
    if (!menu?.path) return
    void guard(() => window.api.revealInOs(menu.path))
  }

  const doPreview = (): void => {
    if (!menu?.path) return
    void guard(() => window.api.previewInBrowser(menu.path))
  }

  const doInsertRef = (): void => {
    if (!menu?.path) return
    useAppStore.getState().insertReference(menu.path)
    pushLog({ time: '', level: 'info', scope: 'tree', text: `已插入引用 ${menu.path}` })
  }

  /** 「预览文件」只在 HTML 上有意义，其余文件交系统默认程序 */
  const canPreview = hasTarget && !isDirTarget && ['html', 'htm'].includes(ext(menu?.path || ''))

  const items: MenuItem[] = [
    { key: 'preview', label: '预览文件', kind: 'item', run: doPreview },
    { key: 'sep1', label: '', kind: 'sep' },
    { key: 'newFile', label: '新建文件', kind: 'item', run: () => doCreate('file') },
    { key: 'newDir', label: '新建文件夹', kind: 'item', run: () => doCreate('dir') },
    { key: 'sep2', label: '', kind: 'sep' },
    { key: 'rename', label: '重命名', kind: 'item', run: doRename },
    { key: 'delete', label: '删除', kind: 'item', danger: true, run: doDelete },
    { key: 'sep3', label: '', kind: 'sep' },
    {
      key: 'hidden',
      label: '显示隐藏文件',
      kind: 'item',
      checked: showHidden,
      run: () => void setShowHidden(!showHidden)
    },
    { key: 'copyPath', label: '复制路径', kind: 'item', run: doCopyPath },
    { key: 'reveal', label: '打开所在目录', kind: 'item', run: doReveal },
    { key: 'insert', label: '插入引用', kind: 'item', run: doInsertRef },
    { key: 'sep4', label: '', kind: 'sep' },
    {
      key: 'refresh',
      label: '刷新',
      kind: 'item',
      run: () => void refreshDir(parentDir || workspace)
    }
  ]

  /** 没选中文件时把不适用的项置灰，而不是藏起来 —— 菜单位置稳定才好找 */
  const isDisabled = (key: string): boolean => {
    if (key === 'preview') return !canPreview
    if (key === 'rename' || key === 'delete') return !hasTarget
    if (key === 'copyPath' || key === 'reveal' || key === 'insert') return !hasTarget
    if (key === 'refresh') return !workspace
    return false
  }

  return (
    <section className={`filetree${embedded ? ' is-embedded' : ''}`}>
      {/*
        嵌在侧栏里时不画自己的标题栏：外层 Sidebar 已经有了「文件树」分组头，
        再画一遍就是同一个标签出现两次。刷新按钮挪到根目录那一行去。
      */}
      {!embedded && (
        <div className="tree-head">
          <span className="tree-head-title">文件树</span>
          <button
            className="tree-head-btn"
            title="刷新工作区"
            onClick={() => workspace && void refreshDir(workspace)}
            disabled={!workspace}
          >
            <RefreshIcon />
          </button>
        </div>
      )}

      <div className="tree-root-row">
        <button
          className="tree-root"
          title={workspace ? `${workspace}\n点击折叠全部分支` : '尚未打开文件夹'}
          onClick={() => void collapseAll()}
          disabled={!workspace}
        >
          <span className="tree-caret is-open" aria-hidden="true">
            ▸
          </span>
          <span className="tree-name">{workspace ? baseName(workspace) : '未打开项目'}</span>
        </button>
        <button
          className="tree-head-btn"
          title="刷新工作区"
          onClick={() => workspace && void refreshDir(workspace)}
          disabled={!workspace}
        >
          <RefreshIcon />
        </button>
      </div>

      <div className="tree-body" onContextMenu={onContextMenu}>
        {!workspace && (
          <div className="tree-empty">
            <div className="tree-empty-title">尚未打开文件夹</div>
            <button className="btn-primary btn-sm" onClick={() => void openWorkspace()}>
              选择一个文件夹
            </button>
          </div>
        )}
        {workspace && (root || []).length === 0 && (
          <div className="tree-empty">
            <div className="tree-empty-title">这个文件夹是空的</div>
            <div className="tree-empty-hint">右键空白处可以新建文件</div>
          </div>
        )}
        {(root || []).map((node) => (
          <TreeNode key={node.path} node={node} depth={0} />
        ))}
      </div>

      {menu && (
        <div
          className="ctx-menu"
          ref={menuRef}
          style={{ left: pos.x, top: pos.y }}
          onContextMenu={(e) => e.preventDefault()}
        >
          {items.map((item) =>
            item.kind === 'sep' ? (
              <div key={item.key} className="ctx-sep" />
            ) : (
              <button
                key={item.key}
                className={`ctx-item${item.danger ? ' is-danger' : ''}`}
                disabled={isDisabled(item.key)}
                onClick={() => {
                  setMenu(null)
                  item.run?.()
                }}
              >
                <span className="ctx-check">{item.checked ? '✓' : ''}</span>
                <span className="ctx-label">{item.label}</span>
              </button>
            )
          )}
        </div>
      )}
    </section>
  )
}

function RefreshIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true">
      <path
        d="M20 12a8 8 0 1 1-2.3-5.6M20 4.5V10h-5.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}
