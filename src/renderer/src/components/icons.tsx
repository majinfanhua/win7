/**
 * 对话面板用到的图标。
 *
 * 统一线性图标，全部用 currentColor 上色 ——
 * 这样深浅主题切换时不用改任何图标代码，颜色跟着文字色走。
 *
 * 不引图标库：十来个图标换成几百 KB 的依赖不划算，
 * 而且这些图形都很简单，手写反而更好控制粗细与圆角。
 *
 * 单独成文件是因为 AiPanel 本体已经很长，图标堆在里面会盖住逻辑。
 */

/** 欢迎页的方形应用图标：深底 + 火箭 */
export function RocketIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" width="26" height="26" aria-hidden="true">
      <g fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round">
        <path d="M13.2 4.4c2.6-1.6 5.2-1.9 6.4-1.7.2 1.2-.1 3.8-1.7 6.4l-2.9 4.7-6.3-6.3 4.5-3.1Z" />
        <circle cx="15.4" cy="8.6" r="1.5" />
        <path d="M8.7 7.5 5.6 8.1l-1.4 2.4 3 .7M16.5 15.3l-.6 3.1-2.4 1.4-.7-3" />
        <path d="M9.9 16.2c-1 1-1.4 2.4-1.5 3.6 1.2-.1 2.6-.5 3.6-1.5" strokeLinecap="round" />
      </g>
    </svg>
  )
}

/** 「解读项目」 */
export function CompassIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
      <g fill="none" stroke="currentColor" strokeWidth="1.6">
        <circle cx="12" cy="12" r="8.4" />
        <path d="m15.2 8.8-2 4.4-4.4 2 2-4.4 4.4-2Z" strokeLinejoin="round" />
      </g>
    </svg>
  )
}

/** 「修复问题」*/
export function WrenchIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
      <g fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
        <path d="M14.8 6.2a3.9 3.9 0 0 1 5.2-.5 3.9 3.9 0 0 1-.6 5.2l1.4 1.4a2 2 0 0 1-2.8 2.8L5.6 9.2" />
        <path d="m9.1 5.3-3.6 3.6a2 2 0 0 0 2.8 2.8l3.6-3.6" />
        <path d="M6.5 13.4 4.2 15.7a2 2 0 1 0 2.8 2.8l2.3-2.3" />
      </g>
    </svg>
  )
}

/** 「头脑风暴」*/
export function BulbIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
      <g fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
        <path d="M9 16.2a6 6 0 1 1 6 0v1.3H9v-1.3Z" />
        <path d="M10 20h4" />
      </g>
    </svg>
  )
}

/** 工具条：引用文件 */
export function PaperclipIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
      <path
        d="M18.4 11.1 12.2 17.3a4.3 4.3 0 1 1-6.1-6.1l6.6-6.6a2.9 2.9 0 1 1 4.1 4.1l-6.6 6.6a1.4 1.4 0 1 1-2-2l6-6"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

/** 工具条：附件 */
export function AtIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
      <g fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
        <circle cx="12" cy="12" r="3.4" />
        <path d="M15.4 12v1.9a2.4 2.4 0 0 0 4.8 0V12a8.2 8.2 0 1 0-3.2 6.5" />
      </g>
    </svg>
  )
}

/** 工具条：截图 */
export function KeyIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
      <g fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
        <circle cx="8.4" cy="12" r="3.9" />
        <path d="M12.3 12h8M17.6 12v3.2M20 12v2.4" />
      </g>
    </svg>
  )
}

/** 工具条：配色 */
export function StarIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
      <path
        d="m12 4 2.3 4.9 5.2.7-3.8 3.7.9 5.3-4.6-2.5-4.6 2.5.9-5.3-3.8-3.7 5.2-.7L12 4Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
    </svg>
  )
}

/** 工具条：Git 仓库 */
export function GitIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
      <g fill="none" stroke="currentColor" strokeWidth="1.6">
        <circle cx="7" cy="6" r="2" />
        <circle cx="7" cy="18" r="2" />
        <circle cx="17" cy="12" r="2" />
        <path d="M7 8v8M9 18h4a2 2 0 0 0 2-2v-2" strokeLinecap="round" />
      </g>
    </svg>
  )
}

/** 发送键 */
export function SendIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
      <path
        d="M20.2 11.4 4.9 4.6a.6.6 0 0 0-.8.8l2.6 5.5a1 1 0 0 0 .7.6l5.3 1a.4.4 0 0 1 0 .8l-5.3 1a1 1 0 0 0-.7.6L4.1 18a.6.6 0 0 0 .8.8l15.3-6.8a.6.6 0 0 0 0-1.1Z"
        fill="currentColor"
      />
    </svg>
  )
}
