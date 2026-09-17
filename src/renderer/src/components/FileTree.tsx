import { useEffect, useRef } from 'react'
import TreeNode from './file-tree/TreeNode'
import TreeToolbar from './file-tree/TreeToolbar'
import TreeOverlays from './file-tree/TreeOverlays'
import { EmptyFolderIcon } from './file-tree/icons'
import { baseName } from './file-tree/shared'
import { useFileTreeController, type FileTreeController } from './file-tree/useFileTreeController'
import { useAppStore } from '../store/useAppStore'

/**
 * 文件树（只此一个形态，嵌在侧栏的「文件树」分组里）。
 *
 * 它曾经有两个形态：侧栏里的嵌入态，以及内容区那个占满整页的
 * 「资源管理器」视图。后者已按用户要求删掉 —— 于是 embedded 这个开关
 * 也失去了意义，一并去掉，免得留一个永远为 true 的参数让人猜。
 *
 * 行为（菜单、弹层、排序、落点）全部在 useFileTreeController 里。
 *
 * ⚠️ 保留的 DOM 契约（自检脚本与右键菜单都依赖，不要改名）：
 *   .filetree / .tree-node / .tree-body / [data-path] / [data-kind]
 *
 * 修过的根因：新建 / 重命名原本调用 `window.prompt`，
 * 而 **Electron 不支持 prompt** —— 调用即抛错，界面上表现为什么也没发生。
 * 现在这两件事全部走应用内弹层（TreeOverlays）。
 */
export default function FileTree(): JSX.Element {
  const tree = useFileTreeController()
  const openWorkspace = useAppStore((s) => s.openWorkspace)
  const collapseAll = useAppStore((s) => s.collapseAll)

  /*
   * 快捷键：Ctrl+Alt+N 新建文件、Ctrl+Alt+Shift+N 新建文件夹、F5 刷新。
   *
   * 用 ref 拿最新的 tree 而不是把 tree 塞进 deps：
   * tree 每次渲染都是新对象，塞进去等于每次渲染都解绑重绑监听器。
   */
  const treeRef = useRef<FileTreeController>(tree)
  treeRef.current = tree

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      // 输入框里打字时不要抢键（比如正在给 AI 写提示词），
      // 也不要在弹层开着时抢 —— 那时 Enter / 方向键属于弹层
      const el = document.activeElement as HTMLElement | null
      const tag = el?.tagName
      const typing = tag === 'INPUT' || tag === 'TEXTAREA' || Boolean(el?.isContentEditable)
      if (typing) return

      if (e.key === 'F5') {
        e.preventDefault()
        treeRef.current.refresh()
        return
      }
      if (!e.ctrlKey || !e.altKey || e.key.toLowerCase() !== 'n') return
      e.preventDefault()
      treeRef.current.requestNew(e.shiftKey ? 'dir' : 'file')
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  return (
    /*
     * 不画自己的标题栏：外层 Sidebar 已经有「文件树」分组头，
     * 再画一遍就是同一个标签出现两次。工具栏始终保留 ——
     * 它是「新建文件」唯一可发现的位置。
     */
    <section className="filetree is-embedded">

      <div className="tree-root-row">
        <button
          className="tree-root"
          title={tree.workspace ? `${tree.workspace}\n点击折叠全部分支` : '尚未打开文件夹'}
          onClick={() => void collapseAll()}
          disabled={!tree.workspace}
        >
          <span className="tree-caret is-open" aria-hidden="true">
            ▸
          </span>
          <span className="tree-name">
            {tree.workspace ? baseName(tree.workspace) : '未打开项目'}
          </span>
        </button>
        <TreeToolbar
          disabled={!tree.workspace}
          showHidden={tree.showHidden}
          sortBy={tree.sortBy}
          onNewFile={() => tree.requestNew('file')}
          onNewDir={() => tree.requestNew('dir')}
          onRefresh={tree.refresh}
          onCollapseAll={() => void collapseAll()}
          onToggleHidden={tree.toggleHidden}
          onSort={tree.setSortBy}
        />
      </div>

      <div className="tree-body" onContextMenu={tree.onContextMenu}>
        {!tree.workspace && (
          <div className="tree-empty">
            <EmptyFolderIcon />
            <div className="tree-empty-title">尚未打开文件夹</div>
            <div className="tree-empty-hint">
              选一个文件夹当项目，就能在里面新建 html / css / js 了
            </div>
            <button className="primary btn-sm" onClick={() => void openWorkspace()}>
              选择一个文件夹
            </button>
          </div>
        )}

        {tree.isEmpty && (
          <div className="tree-empty">
            <EmptyFolderIcon />
            <div className="tree-empty-title">这个文件夹是空的</div>
            <div className="tree-empty-hint">右键空白处也可以新建</div>
            <div className="tree-empty-actions">
              <button className="primary btn-sm" onClick={() => tree.requestNew('file')}>
                新建文件
              </button>
              <button className="ghost btn-sm" onClick={() => tree.requestNew('dir')}>
                新建文件夹
              </button>
            </div>
          </div>
        )}

        {tree.sortedRoot.map((node) => (
          <TreeNode key={node.path} node={node} depth={0} detailed={false} />
        ))}
      </div>

      <TreeOverlays tree={tree} />
    </section>
  )
}
