import type { ExplorerSortBy } from '@shared/types'
import { RefreshIcon } from './icons'

/**
 * 文件树工具栏：新建文件 / 新建文件夹 / 刷新 / 全部折叠 / 显示隐藏文件 / 排序。
 *
 * 全部用 24x24 的图标按钮，靠原生 title 给中文说明与快捷键提示 ——
 * 不引图标库（体积），也不用自定义 tooltip（老系统上浮层容易闪）。
 */

type Props = {
  /** 没打开工作区时整排置灰，而不是隐藏 —— 位置稳定才好找 */
  disabled: boolean
  showHidden: boolean
  sortBy: ExplorerSortBy
  /** 独立面板里工具栏可以宽松一点，显示排序下拉的文字 */
  expanded?: boolean
  onNewFile: () => void
  onNewDir: () => void
  onRefresh: () => void
  onCollapseAll: () => void
  onToggleHidden: () => void
  onSort: (sortBy: ExplorerSortBy) => void
}

const SORTS: Array<{ key: ExplorerSortBy; label: string }> = [
  { key: 'name', label: '名称' },
  { key: 'type', label: '类型' },
  { key: 'mtime', label: '修改时间' }
]

export default function TreeToolbar({
  disabled,
  showHidden,
  sortBy,
  expanded = false,
  onNewFile,
  onNewDir,
  onRefresh,
  onCollapseAll,
  onToggleHidden,
  onSort
}: Props): JSX.Element {
  return (
    <div className={`tree-tools${expanded ? ' is-expanded' : ''}`}>
      <button
        className="tree-tool"
        title="新建文件（Ctrl+Alt+N）"
        aria-label="新建文件"
        disabled={disabled}
        onClick={onNewFile}
      >
        <FilePlusIcon />
      </button>
      <button
        className="tree-tool"
        title="新建文件夹（Ctrl+Alt+Shift+N）"
        aria-label="新建文件夹"
        disabled={disabled}
        onClick={onNewDir}
      >
        <DirPlusIcon />
      </button>
      <span className="tree-tool-sep" aria-hidden="true" />
      <button
        className="tree-tool"
        title="刷新当前目录（F5）"
        aria-label="刷新"
        disabled={disabled}
        onClick={onRefresh}
      >
        <RefreshIcon />
      </button>
      <button
        className="tree-tool"
        title="全部折叠"
        aria-label="全部折叠"
        disabled={disabled}
        onClick={onCollapseAll}
      >
        <CollapseIcon />
      </button>
      <button
        className={`tree-tool${showHidden ? ' is-on' : ''}`}
        title={showHidden ? '不再显示隐藏文件' : '显示以 . 开头的隐藏文件'}
        aria-label="显示隐藏文件"
        aria-pressed={showHidden}
        disabled={disabled}
        onClick={onToggleHidden}
      >
        <EyeIcon />
      </button>

      <span className="spacer" />

      {/*
        排序：窄栏里只给一个下拉，没有空间铺三个按钮。
        用原生 <select> 而不是自绘下拉 —— 前者在 Win7 上一定能弹出来，
        而且键盘可达性白拿（上下键、首字母跳转）。
      */}
      <label className="tree-sort" title="文件树排序方式（文件夹始终排在最前）">
        <SortIcon />
        <select
          value={sortBy}
          disabled={disabled}
          aria-label="排序方式"
          onChange={(e) => onSort(e.target.value as ExplorerSortBy)}
        >
          {SORTS.map((item) => (
            <option key={item.key} value={item.key}>
              {item.label}
            </option>
          ))}
        </select>
      </label>
    </div>
  )
}

/* ------------------------------------------------------------------ *
 * 图标：统一 13px 线性，currentColor 上色，深浅主题共用
 * ------------------------------------------------------------------ */

function FilePlusIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true">
      <g fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round">
        <path d="M13.5 3.5H7A1.5 1.5 0 0 0 5.5 5v14A1.5 1.5 0 0 0 7 20.5h10a1.5 1.5 0 0 0 1.5-1.5V8.5l-5-5Z" />
        <path d="M13.5 3.5v5h5" />
        <path d="M12 12.5v5M9.5 15h5" strokeLinecap="round" />
      </g>
    </svg>
  )
}

function DirPlusIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true">
      <g fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round">
        <path d="M3.5 6.5A1.5 1.5 0 0 1 5 5h4l1.6 2h8.4A1.5 1.5 0 0 1 20.5 8.5v9A1.5 1.5 0 0 1 19 19H5a1.5 1.5 0 0 1-1.5-1.5v-11Z" />
        <path d="M12 11.5v5M9.5 14h5" strokeLinecap="round" />
      </g>
    </svg>
  )
}

function CollapseIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true">
      <g fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
        <path d="M8 4.5 12 8.5l4-4M8 19.5l4-4 4 4" />
      </g>
    </svg>
  )
}

function EyeIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true">
      <g fill="none" stroke="currentColor" strokeWidth="1.6">
        <path d="M2.8 12S6.4 6.2 12 6.2 21.2 12 21.2 12 17.6 17.8 12 17.8 2.8 12 2.8 12Z" strokeLinejoin="round" />
        <circle cx="12" cy="12" r="2.6" />
      </g>
    </svg>
  )
}

function SortIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" width="12" height="12" aria-hidden="true">
      <path
        d="M7 5v13M4 15l3 3 3-3M14 7h6M14 12h4M14 17h3"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}
