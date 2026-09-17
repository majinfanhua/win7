import type { ExplorerSortBy } from '@shared/types'
import { RefreshIcon } from './icons'
import Select from '../ui/Select'

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

        ⚠️ 这里原来用**原生 <select>**，理由写的是「在 Win7 上一定能弹出来」。
        现在改用自绘下拉，原因是原生那个在深色模式下会**白底浅字看不见**：
        它的展开列表由 Windows 系统主题引擎绘制，`color-scheme: dark`
        在 Win7 上不生效（explorer.css 里那条 `.tree-sort select option`
        补丁就是为它打的，但改不动列表背景本身）。
        自绘的列表完全由 CSS 控制，两个主题下都正常。
      */}
      <label className="tree-sort" title="文件树排序方式（文件夹始终排在最前）">
        <SortIcon />
        <Select
          value={sortBy}
          options={SORTS.map((item) => ({ value: item.key, label: item.label }))}
          onChange={(v) => onSort(v)}
          ariaLabel="排序方式"
          title="文件树排序方式（文件夹始终排在最前）"
          className="tree-sort-select"
          disabled={disabled}
        />
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
