import FileTree from '../FileTree'
import { useAppStore } from '../../store/useAppStore'
import { useFileTreeController, type FileTreeController } from './useFileTreeController'

/**
 * 内容区「资源管理器」整页视图。
 *
 * 它是文件树在内容区的非嵌入形态：同一个 `FileTree`（embedded=false），
 * 外面包了标题、面包屑、已打开文件列表与快捷键提示。
 *
 * 为什么不做成「左边再加一栏」：
 * 现有 .stage 用 `--split` 做 100% 宽度分割，DOM 顺序「编辑器 → 分割条 → 对话」
 * 是已踩过坑的契约（分割条不能占布局宽度）。再加一栏会连锁破坏布局，
 * 而且 Win7 软件渲染下多一栏更吃力。整页视图完全不碰这条约束。
 */
export default function ExplorerPanel(): JSX.Element {
  const workspace = useAppStore((s) => s.workspace)
  const openWorkspace = useAppStore((s) => s.openWorkspace)
  const setActive = useAppStore((s) => s.setActive)
  const tabs = useAppStore((s) => s.tabs)

  return (
    <div className="explorer-page">
      <ExplorerHead />

      <div className="explorer-body">
        <div className="explorer-tree-col">
          {/* 非嵌入形态：FileTree 自带标题栏与整宽布局 */}
          <FileTree embedded={false} />
        </div>

        {workspace && (
          <aside className="explorer-side-col">
            <div className="explorer-side-block">
              <h3 className="explorer-side-title">已打开的文件</h3>
              {tabs.length === 0 && (
                <div className="explorer-side-hint">
                  还没有打开任何文件。点左边树里的文件名就会在这里打开。
                </div>
              )}
              {tabs.map((tab) => (
                <button
                  key={tab.path}
                  className="explorer-openfile"
                  title={tab.path}
                  onClick={() => setActive(tab.path)}
                >
                  <span className="explorer-openfile-name">{tab.name}</span>
                  {tab.dirty && <span className="explorer-openfile-dot" title="有未保存的修改" />}
                </button>
              ))}
            </div>

            <div className="explorer-side-block">
              <h3 className="explorer-side-title">教学提示</h3>
              <ul className="explorer-tips">
                <li>
                  右键文件夹可以<strong>在该目录下</strong>继续新建 html / css / js。
                </li>
                <li>新建文件会写入一段可直接运行的初始代码，并自动在编辑器里打开。</li>
                <li>排序方式与「显示隐藏文件」都会记住，重启后保持不变。</li>
              </ul>
            </div>

            <div className="explorer-side-block">
              <h3 className="explorer-side-title">快捷键</h3>
              <div className="explorer-keys">
                <span>新建文件</span>
                <kbd>Ctrl</kbd>
                <kbd>Alt</kbd>
                <kbd>N</kbd>
              </div>
              <div className="explorer-keys">
                <span>新建文件夹</span>
                <kbd>Ctrl</kbd>
                <kbd>Alt</kbd>
                <kbd>Shift</kbd>
                <kbd>N</kbd>
              </div>
              <div className="explorer-keys">
                <span>刷新</span>
                <kbd>F5</kbd>
              </div>
            </div>
          </aside>
        )}
      </div>

      {!workspace && (
        <div className="explorer-blank">
          <button className="primary" onClick={() => void openWorkspace()}>
            选择一个文件夹
          </button>
        </div>
      )}
    </div>
  )
}

/**
 * 面板头：面包屑 + 当前目录整路径。
 *
 * 面包屑自己用一份 controller 读 crumbs，而不是从 FileTree 往下传：
 * 传 prop 会让 FileTree 多出一个「只有非嵌入形态才需要」的接口，
 * 而 controller 内部只是几个 useMemo，重复算一次的代价可以忽略。
 */
function ExplorerHead(): JSX.Element {
  const tree: FileTreeController = useFileTreeController()

  return (
    <header className="explorer-head">
      <div className="explorer-crumbs" title={tree.workspace}>
        {tree.crumbs.length === 0 && <span className="explorer-crumb is-current">未打开项目</span>}
        {tree.crumbs.length > 0 && tree.crumbs.length > 4 && (
          <>
            <span className="explorer-crumb is-dim">…</span>
            <span className="explorer-crumb-sep">/</span>
          </>
        )}
        {tree.crumbs.map((crumb, index) => (
          <span key={crumb.path} className="explorer-crumb-wrap">
            <span
              className={`explorer-crumb${index === tree.crumbs.length - 1 ? ' is-current' : ''}`}
            >
              {crumb.name}
            </span>
            {index < tree.crumbs.length - 1 && <span className="explorer-crumb-sep">/</span>}
          </span>
        ))}
      </div>
      <span className="spacer" />
      <span className="explorer-head-count">
        {tree.workspace ? `${tree.sortedRoot.length} 个可见项` : ''}
      </span>
    </header>
  )
}
