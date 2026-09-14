import type { FileNode } from '@shared/types'
import { useAppStore } from '../store/useAppStore'

function TreeNode({ node, depth }: { node: FileNode; depth: number }): JSX.Element {
  const expanded = useAppStore((s) => Boolean(s.expanded[node.path]))
  const children = useAppStore((s) => s.childMap[node.path])
  const activePath = useAppStore((s) => s.activePath)
  const toggleDir = useAppStore((s) => s.toggleDir)
  const openFile = useAppStore((s) => s.openFile)

  if (node.kind === 'dir') {
    return (
      <>
        <div
          className="node"
          style={{ paddingLeft: 8 + depth * 12 }}
          onClick={() => void toggleDir(node.path)}
          title={node.path}
        >
          <span className="icon">{expanded ? '▾' : '▸'}</span>
          <span>{node.name}</span>
        </div>
        {expanded && (children || []).map((child) => <TreeNode key={child.path} node={child} depth={depth + 1} />)}
      </>
    )
  }

  return (
    <div
      className={`node${activePath === node.path ? ' active' : ''}`}
      style={{ paddingLeft: 8 + depth * 12 }}
      onClick={() => void openFile(node.path)}
      title={node.path}
    >
      <span className="icon">·</span>
      <span>{node.name}</span>
    </div>
  )
}

export default function FileTree(): JSX.Element {
  const workspace = useAppStore((s) => s.workspace)
  const root = useAppStore((s) => (s.workspace ? s.childMap[s.workspace] : undefined))
  const openWorkspace = useAppStore((s) => s.openWorkspace)

  return (
    <div className="sidebar">
      <div className="panel-title">
        <span>资源管理器</span>
        <span style={{ flex: 1 }} />
        <button onClick={() => void openWorkspace()}>打开</button>
      </div>
      <div className="scroll">
        {!workspace && <div className="empty">尚未打开文件夹</div>}
        {workspace && (root || []).map((node) => <TreeNode key={node.path} node={node} depth={0} />)}
      </div>
    </div>
  )
}
