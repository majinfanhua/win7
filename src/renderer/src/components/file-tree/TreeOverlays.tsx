import { useEffect, useRef, useState } from 'react'
import { templateByExt, validateEntryName } from '../../file-templates'
import InputDialog from '../InputDialog'
import NewEntryDialog from '../NewEntryDialog'
import MoveDialog from './MoveDialog'
import { baseName, existingNamesOf, parentDirOf } from './shared'
import type { FileTreeController } from './useFileTreeController'

/**
 * 文件树的三层浮层：右键菜单 + 新建 / 重命名弹层 + 移动弹层。
 *
 * 两种形态（侧栏嵌入、内容区独立面板）都渲染这一个组件 ——
 * 浮层必须共用，否则「侧栏里能重命名、面板里不行」这类差异会漏出去。
 */

export default function TreeOverlays({ tree }: { tree: FileTreeController }): JSX.Element {
  return (
    <>
      {tree.menu && <ContextMenu tree={tree} />}
      {tree.newEntry && (
        <NewEntryDialog
          kind={tree.newEntry.kind}
          target={tree.newEntry.target}
          onSubmit={tree.submitNewEntry}
          onCancel={tree.closeNewEntry}
        />
      )}
      {tree.rename && <RenameDialog tree={tree} />}
      {tree.move && <MoveDialog tree={tree} />}
    </>
  )
}

/**
 * 重命名弹层。
 *
 * 单独包一层是为了拿到「当前名字」与「同目录已有名字」：
 * 校验要排除它自己（否则「改成原名」会被判定成重名），
 * 而这两个值都要从 store 的当前快照里读。
 */
function RenameDialog({ tree }: { tree: FileTreeController }): JSX.Element {
  const target = tree.rename?.path || ''
  const current = baseName(target)
  const siblings = existingNamesOf(parentDirOf(target)).filter(
    (name) => name.toLowerCase() !== current.toLowerCase()
  )

  /**
   * 校验：合法性 + 重名（排除自己）。
   * 重命名到同名由 submitRename 内部直接当成「无变化」处理，这里不拦。
   */
  const validate = (value: string): string => {
    const base = validateEntryName(value)
    if (base) return base
    const name = value.trim()
    if (siblings.some((item) => item.toLowerCase() === name.toLowerCase())) {
      return `这里已经有一个叫「${name}」的项目了`
    }
    return ''
  }

  return (
    <InputDialog
      title="重命名"
      label="新名称"
      initial={current}
      confirmText="重命名"
      hint="扩展名也会一起改；改完仍在原目录下"
      validate={validate}
      onSubmit={tree.submitRename}
      onCancel={tree.closeRename}
    >
      <div className="field">
        <label>当前位置</label>
        <div className="dialog-path" title={parentDirOf(target)}>
          <span className="dialog-path-text">{tree.crumbs.map((c) => c.name).join(' / ') || parentDirOf(target)}</span>
        </div>
      </div>
      {templateByExt(current) && <div className="hint">提示：改扩展名不会改写文件内容</div>}
    </InputDialog>
  )
}

/**
 * 右键菜单。
 *
 * 位置为 position:fixed，但那也还是会被窗口边缘裁掉，
 * 所以先渲染一次、量出实际尺寸，再往回挪到窗口内。
 * 不做这一步，右键最右侧或最下侧的文件，菜单会有一半在屏幕外，点不到「刷新」。
 */
function ContextMenu({ tree }: { tree: FileTreeController }): JSX.Element {
  const menu = tree.menu
  const ref = useRef<HTMLDivElement | null>(null)
  const [pos, setPos] = useState({ x: menu?.x || 0, y: menu?.y || 0 })

  useEffect(() => {
    const box = ref.current?.getBoundingClientRect()
    if (!box || !menu) return
    const x = box.right > window.innerWidth - 8 ? Math.max(8, menu.x - box.width) : menu.x
    const y = box.bottom > window.innerHeight - 8 ? Math.max(8, menu.y - box.height) : menu.y
    setPos({ x, y })
  }, [menu])

  return (
    <div
      className="ctx-menu"
      ref={ref}
      style={{ left: pos.x, top: pos.y }}
      onContextMenu={(e) => e.preventDefault()}
      /* 点菜单内部不能冒泡到 document 的 mousedown 关菜单逻辑，
         否则刚点开就被自己关掉 */
      onMouseDown={(e) => e.stopPropagation()}
    >
      {tree.menuItems.map((item) =>
        item.kind === 'sep' ? (
          <div key={item.key} className="ctx-sep" />
        ) : (
          <button
            key={item.key}
            className={`ctx-item${item.danger ? ' is-danger' : ''}`}
            title={item.disabledReason || item.label}
            disabled={Boolean(item.disabledReason)}
            onClick={() => {
              tree.closeMenu()
              item.run?.()
            }}
          >
            <span className="ctx-check">{item.checked ? '✓' : ''}</span>
            <span className="ctx-label">{item.label}</span>
          </button>
        )
      )}
    </div>
  )
}
