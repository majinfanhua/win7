import type { FileNode } from '@shared/types'
import { useAppStore } from '../../store/useAppStore'
import { fileBadge, humanSize, isDescendantOf } from './shared'

/**
 * 递归节点。
 *
 * ⚠️ 有几个属性是**契约**，改名前先搜一下自检脚本：
 *   - `data-path` / `data-kind`：右键菜单靠 closest('[data-path]') 找落点
 *   - `.tree-node`：几何与选择态断言
 *   - `paddingLeft: 6 + depth * 13`：缩进量，改成别的值会让深层目录的
 *     引导线与 caret 对不上（视觉上会有半像素错位）
 *
 * 性能上只做一件事：不在这一层排序。子节点在 store 里已经排好了，
 * 每个节点再排一次等于把同一份工作重复做 O(n) 次。
 *
 * 拖拽用原生 HTML5 DnD（dragstart / dragover / drop）而不是 Pointer Events：
 * 文件树要的是「把一个元素扔到另一个元素上」，DnD 天生干这个，
 * 而且白拿浏览器自绘的拖拽影像与边缘自动滚动。
 * 一个必踩的坑：**dragover 必须 preventDefault**，否则浏览器认为这里
 * 不接受放置，drop 事件根本不会派发 —— 表现为「拖过去没反应」。
 */

type Props = {
  node: FileNode
  depth: number
  /** 独立面板里显示大小与时间，嵌在侧栏里不显示（侧栏太窄） */
  detailed?: boolean
}

/**
 * 拖拽载荷的自定义 MIME 类型。
 *
 * 用自定义类型而不是 text/plain 当判据：从外部（资源管理器、
 * 浏览器里选中的一段文字）拖进来的东西没有这个类型，直接忽略，
 * 不会被误当成「树内移动」而去查一个根本不存在的路径。
 * text/plain 照样要设 —— 某些平台上没有纯文本载荷时连 drop 都不派发。
 */
export const TREE_DRAG_TYPE = 'application/x-hangke-tree-path'

export default function TreeNode({ node, depth, detailed = false }: Props): JSX.Element {
  const expanded = useAppStore((s) => Boolean(s.expanded[node.path]))
  const children = useAppStore((s) => s.childMap[node.path])
  const activePath = useAppStore((s) => s.activePath)
  const selectedPath = useAppStore((s) => s.selectedPath)
  const dragPath = useAppStore((s) => s.dragPath)
  const dropTarget = useAppStore((s) => s.dropTarget)
  const toggleDir = useAppStore((s) => s.toggleDir)
  const openFile = useAppStore((s) => s.openFile)
  const select = useAppStore((s) => s.select)
  const beginDrag = useAppStore((s) => s.beginDrag)
  const hoverDropTarget = useAppStore((s) => s.hoverDropTarget)
  const endDrag = useAppStore((s) => s.endDrag)
  const dropOn = useAppStore((s) => s.dropOn)

  const isDir = node.kind === 'dir'
  const isActive = !isDir && activePath === node.path
  const isSelected = selectedPath === node.path
  const badge = isDir ? null : fileBadge(node.name)

  const isDropTarget = dropTarget === node.path
  const dragging = Boolean(dragPath)
  /** 自己和自己的子孙都不能当落点（否则会把目录移进它自己里面） */
  const isSelfOrDescendant = dragPath ? isDescendantOf(node.path, dragPath) : false
  /** 只有目录能接住放置。文件之间的「扔到同级」由空白区处理，不在这里 */
  const canDropHere = dragging && isDir && !isSelfOrDescendant

  const onClick = (): void => {
    select(node.path)
    if (isDir) void toggleDir(node.path)
    else void openFile(node.path)
  }

  return (
    <>
      <div
        className={[
          'tree-node',
          isActive ? 'is-active' : '',
          isSelected ? 'is-selected' : '',
          isDropTarget ? 'is-drop-target' : '',
          dragPath === node.path ? 'is-dragging' : ''
        ]
          .filter(Boolean)
          .join(' ')}
        style={{ paddingLeft: 6 + depth * 13 }}
        onClick={onClick}
        title={detailed ? node.path : undefined}
        data-path={node.path}
        data-kind={node.kind}
        draggable
        onDragStart={(e) => {
          // 不 stopPropagation 的话，父节点也会收到 dragstart，
          // 拖一个深层文件会变成「拖的是最外层那个目录」
          e.stopPropagation()
          e.dataTransfer.effectAllowed = 'move'
          e.dataTransfer.setData(TREE_DRAG_TYPE, node.path)
          e.dataTransfer.setData('text/plain', node.path)
          beginDrag(node.path)
        }}
        onDragEnd={() => endDrag()}
        onDragOver={(e) => {
          if (!canDropHere) return
          e.preventDefault()
          e.stopPropagation()
          e.dataTransfer.dropEffect = 'move'
          hoverDropTarget(node.path)
        }}
        onDragLeave={(e) => {
          // 在子元素之间移动也会触发 dragleave，只处理真的离开本节点的情况，
          // 否则高亮会一直闪
          if (e.currentTarget.contains(e.relatedTarget as Node | null)) return
          if (dropTarget === node.path) hoverDropTarget('')
        }}
        onDrop={(e) => {
          if (!canDropHere) return
          e.preventDefault()
          e.stopPropagation()
          // 优先读 dataTransfer：dragPath 在跨窗口/异常中断时可能已经清掉，
          // 而 dataTransfer 是浏览器托管的那一份，更可靠
          const from = e.dataTransfer.getData(TREE_DRAG_TYPE) || dragPath || ''
          const toDir = node.path
          endDrag()
          if (from) void dropOn(from, toDir)
        }}
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
        {detailed && (
          <span className="tree-meta">{isDir ? '' : humanSize(node)}</span>
        )}
      </div>
      {isDir &&
        expanded &&
        (children || []).map((child) => (
          <TreeNode key={child.path} node={child} depth={depth + 1} detailed={detailed} />
        ))}
    </>
  )
}
