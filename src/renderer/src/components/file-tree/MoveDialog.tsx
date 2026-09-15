import { useEffect, useMemo, useState } from 'react'
import { useAppStore } from '../../store/useAppStore'
import { baseName, isDescendantOf, parentDirOf } from './shared'
import type { FileTreeController } from './useFileTreeController'

/**
 * 「移动到…」目录选择器。
 *
 * 为什么在拖拽之外还要有它：
 *   1. 目标在折叠的深层目录里时，拖拽要先一层层展开，很别扭
 *   2. 老机器上鼠标拖动容易脱手（与分割条同一个问题）
 *   3. 键盘用户没法拖
 * 所以拖拽是主路径，这个弹层是等价的备选路径 —— 两者最终都调同一个
 * `store.moveEntry`，不存在两套移动逻辑。
 *
 * 目录树直接从 store 的 `childMap` 渲染：那是文件树已经在用的同一份缓存，
 * 展开时顺手 refreshDir 补上即可，不另开一个「只读目录」的 IPC。
 */
export default function MoveDialog({ tree }: { tree: FileTreeController }): JSX.Element | null {
  const workspace = useAppStore((s) => s.workspace)
  const childMap = useAppStore((s) => s.childMap)
  const refreshDir = useAppStore((s) => s.refreshDir)

  const from = tree.move?.path || ''
  const currentParent = from ? parentDirOf(from) : ''

  /** 选中的目标目录。初始为空 = 还没选 */
  const [dest, setDest] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  /** 已展开的目录（弹层自己的一份，不动文件树的 expanded） */
  const [open, setOpen] = useState<Record<string, boolean>>(() => ({ [workspace]: true }))

  // 打开时把工作区根读出来。childMap 里通常已经有了（文件树用着同一份），
  // 但「弹层打开时文件树还没展开过根」也是可能的
  useEffect(() => {
    if (workspace && !childMap[workspace]) void refreshDir(workspace)
  }, [workspace, childMap, refreshDir])

  /**
   * 可选的目标目录集合。
   *
   * 排除三类：
   *   - 它当前所在的目录（移过去等于没动）
   *   - 它自己（不能移到自己里）
   *   - 它的任何子孙（同上，否则会产生环）
   */
  const selectable = useMemo(() => {
    const out = new Set<string>()
    const walk = (dir: string): void => {
      if (dir !== from && !isDescendantOf(dir, from)) out.add(dir)
      const children = childMap[dir] || []
      for (const node of children) {
        if (node.kind !== 'dir') continue
        // 被排除的目录仍然要往下走：它的子孙同样该被排除，
        // 但它们的父节点会显示成不可点，孩子自然也不该出现
        if (node.path === from || isDescendantOf(node.path, from)) continue
        walk(node.path)
      }
    }
    if (workspace) walk(workspace)
    return out
  }, [childMap, workspace, from])

  const toggle = (dir: string): void => {
    setOpen((prev) => ({ ...prev, [dir]: !prev[dir] }))
    if (!childMap[dir]) void refreshDir(dir)
  }

  const submit = async (): Promise<void> => {
    if (busy) return
    if (!dest) {
      setError('请先在下面选一个目标文件夹')
      return
    }
    if (dest === currentParent) {
      setError('它已经在这个文件夹里了')
      return
    }
    setBusy(true)
    setError('')
    try {
      const failed = await tree.submitMove(dest)
      if (failed) setError(failed)
    } finally {
      setBusy(false)
    }
  }

  if (!tree.move) return null

  /** 递归渲染目录行。只列目录 —— 移动的落点只能是目录 */
  const renderDir = (dir: string, depth: number): JSX.Element[] => {
    const children = (childMap[dir] || []).filter((node) => node.kind === 'dir')
    const rows: JSX.Element[] = []
    for (const node of children) {
      // 要移动的目录自己，以及它的子孙，整枝都不显示 ——
      // 显示成灰色也还是噪音，不如直接不列
      if (node.path === from || isDescendantOf(node.path, from)) continue
      const expanded = Boolean(open[node.path])
      rows.push(
        <div
          key={node.path}
          className={`move-dir${dest === node.path ? ' is-picked' : ''}`}
          style={{ paddingLeft: 8 + depth * 14 }}
        >
          <button
            className="move-dir-caret"
            aria-label={expanded ? '收起' : '展开'}
            onClick={(e) => {
              e.stopPropagation()
              toggle(node.path)
            }}
          >
            {expanded ? '▾' : '▸'}
          </button>
          <button
            className="move-dir-name"
            disabled={!selectable.has(node.path)}
            title={selectable.has(node.path) ? node.path : `${node.path}（不能选它）`}
            onClick={() => {
              setDest(node.path)
              setError('')
            }}
          >
            {node.name}
          </button>
        </div>
      )
      if (expanded) rows.push(...renderDir(node.path, depth + 1))
    }
    return rows
  }

  return (
    <div className="overlay" onMouseDown={tree.closeMove}>
      <div className="dialog" onMouseDown={(e) => e.stopPropagation()}>
        <div className="dialog-head">
          <h2>移动「{baseName(from)}」</h2>
        </div>

        <div className="field">
          <label>当前位置</label>
          <div className="dialog-path" title={currentParent}>
            <span className="dialog-path-text">{currentParent}</span>
          </div>
        </div>

        <div className="field">
          <label>移动到</label>
          <div className="move-tree">
            <div className={`move-dir${dest === workspace ? ' is-picked' : ''}`}>
              <button className="move-dir-caret" aria-hidden="true" tabIndex={-1} onClick={() => toggle(workspace)}>
                {open[workspace] ? '▾' : '▸'}
              </button>
              <button className="move-dir-name" onClick={() => { setDest(workspace); setError('') }}>
                {baseName(workspace) || workspace}
                <span className="muted"> （项目根目录）</span>
              </button>
            </div>
            {open[workspace] && renderDir(workspace, 1)}
          </div>
          {dest && (
            <div className="hint" title={dest}>
              将移动到：{dest}
            </div>
          )}
          {error && (
            <div className="field-error" role="alert">
              {error}
            </div>
          )}
        </div>

        <div className="dialog-actions">
          <span className="spacer" />
          <button className="ghost" onClick={tree.closeMove} disabled={busy}>
            取消
          </button>
          <button className="primary" onClick={() => void submit()} disabled={busy || !dest}>
            {busy ? '移动中…' : '移动到此处'}
          </button>
        </div>
      </div>
    </div>
  )
}
