import { useEffect, useRef, useState } from 'react'

/**
 * 自绘下拉选择器。
 *
 * ## 为什么不用原生 <select>
 *
 * 原生 select 的**展开列表由操作系统绘制**，CSS 完全管不到 ——
 * 圆角、配色、字号、悬停高亮全都改不了，在深色界面里会突兀地弹出一个
 * 系统风格的白色列表。这是它和本项目其它控件看着不一致的根本原因，
 * 不是样式没调好。
 *
 * ## 为什么不用 UI 库
 *
 * 本项目跑在 **Chromium 108**（Electron 22），并且有一道护栏
 * （check-css108.mjs）禁止 108 之后才有的 CSS 特性。主流方案里：
 *   - antd / MUI：包体大（几百 KB），且大量依赖新 CSS
 *   - radix / shadcn：需要 Tailwind，且内部用了 color-mix 等特性
 * 引进来会直接和那道护栏冲突，为一个下拉引入整套体系也不划算。
 * 所以这里自己写一个：依赖为零，样式完全受控，行为可预测。
 *
 * ## 弹出层为什么用 absolute（而不是 fixed）
 *
 * 这里改过一次，是个**实测踩出来的坑**，值得写下来：
 *
 * 原来用 `position: fixed` + 按按钮 rect 算视口坐标。看着更稳
 * （fixed 不受祖先 overflow 影响），但在本项目的输入框里**完全失效**：
 * 弹层渲染到了屏幕外，实测偏移 779px（按钮在 x=1231，弹层跑到 x=2213，
 * 而视口只有 1439 宽）—— 用户看到的是「点了没反应」。
 *
 * 根因：`.composer` 带 `.glass`，即 `backdrop-filter: blur(20px)`。
 * **`backdrop-filter` 会为 fixed 子元素创建新的包含块**，于是 `fixed`
 * 不再相对视口、而是相对 `.composer` 定位；而我们的坐标是按视口算的，
 * 两者一叠加就整体偏掉了。
 *
 * 同类属性还有 transform / filter / perspective / will-change ——
 * 光看组件自己看不出来，得看它被放进了什么样的祖先里。
 *
 * 现在用 absolute + 一个 position:relative 的包裹层：
 *   - 坐标交给浏览器算（`bottom: 100%`），**没有任何 JS 测量**
 *   - 不受 backdrop-filter 影响
 *   - 祖先链上（.composer-bar → .composer → .chat → .view）都没有
 *     overflow:hidden，向上展开不会被裁掉
 *
 * 代价：它不再跟随视口滚动。但输入框固定在底部、上方那条消息区
 * 自己滚（.chat-scroll），弹层挂在输入框上不参与那次滚动，正合适。
 */

export interface SelectOption<T extends string> {
  value: T
  label: string
  /** 悬停提示（原生 title），用来放这一项的详细说明 */
  hint?: string
}

interface Props<T extends string> {
  value: T
  options: ReadonlyArray<SelectOption<T>>
  onChange: (value: T) => void
  /** 无障碍标签 */
  ariaLabel: string
  /** 触发按钮上的 title */
  title?: string
  /**
   * 额外类名，用来按当前值换配色（如权限模式的三种颜色）
   * 以及控制宽度（见 ui.css 的 .mode-picker / .model-picker）。
   */
  className?: string
}

export default function Select<T extends string>({
  value,
  options,
  onChange,
  ariaLabel,
  title,
  className = ''
}: Props<T>): JSX.Element {
  const [open, setOpen] = useState(false)
  const btnRef = useRef<HTMLButtonElement | null>(null)
  const popRef = useRef<HTMLDivElement | null>(null)
  /** 键盘高亮项。打开时先落在当前值上 */
  const [active, setActive] = useState(0)

  const current = options.find((o) => o.value === value)

  /** 点外面 / 按 Esc 关掉 */
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      const t = e.target as Node
      if (popRef.current?.contains(t) || btnRef.current?.contains(t)) return
      setOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        setOpen(false)
        btnRef.current?.focus()
      }
    }
    // mousedown 而不是 click：click 会在按钮 onClick 之前冒泡上来，
    // 导致「刚点开就被关掉」
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const openList = (): void => {
    const idx = options.findIndex((o) => o.value === value)
    setActive(idx < 0 ? 0 : idx)
    setOpen(true)
  }

  const choose = (v: T): void => {
    onChange(v)
    setOpen(false)
    btnRef.current?.focus()
  }

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (!open) {
      if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown') {
        e.preventDefault()
        openList()
      }
      return
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActive((i) => (i + 1) % options.length)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActive((i) => (i - 1 + options.length) % options.length)
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      const picked = options[Math.min(active, options.length - 1)]
      if (picked) choose(picked.value)
    } else if (e.key === 'Home') {
      e.preventDefault()
      setActive(0)
    } else if (e.key === 'End') {
      e.preventDefault()
      setActive(options.length - 1)
    }
  }

  return (
    /*
     * 包裹层只为定位：弹层用 absolute 锚在它身上（见文件头注释），
     * 所以它必须是 position: relative 的那个元素。
     */
    <span className="ui-select-wrap">
      <button
        ref={btnRef}
        type="button"
        className={`ui-select${open ? ' is-open' : ''} ${className}`.trim()}
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        title={title || current?.hint || current?.label}
        onClick={() => (open ? setOpen(false) : openList())}
        onKeyDown={onKeyDown}
      >
        <span className="ui-select-label">{current?.label || value}</span>
        <CaretIcon />
      </button>

      {open && (
        <div ref={popRef} className="ui-select-pop" role="listbox" aria-label={ariaLabel}>
          {options.map((opt, i) => (
            <button
              key={opt.value}
              type="button"
              role="option"
              aria-selected={opt.value === value}
              className={[
                'ui-select-item',
                opt.value === value ? 'is-current' : '',
                i === active ? 'is-active' : ''
              ]
                .filter(Boolean)
                .join(' ')}
              title={opt.hint}
              onMouseEnter={() => setActive(i)}
              // 用 mousedown + preventDefault：click 会先让按钮失焦，
              // 而且外层那个「点外面关闭」也会同时命中
              onMouseDown={(e) => {
                e.preventDefault()
                choose(opt.value)
              }}
            >
              <span className="ui-select-item-label">{opt.label}</span>
              {opt.value === value && <CheckIcon />}
            </button>
          ))}
        </div>
      )}
    </span>
  )
}

/** 小三角：表示「可展开」 */
function CaretIcon(): JSX.Element {
  return (
    <svg className="ui-select-caret" viewBox="0 0 24 24" width="11" height="11" aria-hidden="true">
      <path
        d="m6.5 9.5 5.5 5.5 5.5-5.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

/** 勾：标出当前选中项 */
function CheckIcon(): JSX.Element {
  return (
    <svg className="ui-select-check" viewBox="0 0 24 24" width="12" height="12" aria-hidden="true">
      <path
        d="m5 12.5 4.5 4.5L19 7"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}
