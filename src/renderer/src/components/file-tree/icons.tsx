/**
 * 文件树用到的图标。
 *
 * 单独一份是因为工具栏与容器都要用（原来 RefreshIcon 挂在 FileTree.tsx 末尾，
 * 拆分后两边都引它就会出现「容器引工具栏、工具栏再反向引容器」的循环）。
 *
 * 统一 13px 线性、currentColor 上色 —— 与 components/icons.tsx 同一套语言，
 * 但那边是对话面板专用的，没有文件 / 目录这一类图形。
 */

/** 刷新 */
export function RefreshIcon(): JSX.Element {
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

/** 空目录的引导图示：一个淡淡的文件夹轮廓，比干巴巴一行字更像「可以在这里放东西」 */
export function EmptyFolderIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 48 48" width="44" height="44" aria-hidden="true">
      <g fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round">
        <path d="M6 13a3 3 0 0 1 3-3h9l3.4 4H39a3 3 0 0 1 3 3v18a3 3 0 0 1-3 3H9a3 3 0 0 1-3-3V13Z" />
        <path d="M13 27h22M13 33h14" strokeLinecap="round" opacity=".55" />
      </g>
    </svg>
  )
}
