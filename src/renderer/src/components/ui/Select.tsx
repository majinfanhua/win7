import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

/**
 * 自绘下拉选择器。
 *
 * ## 为什么不用原生 <select>
 *
 * 原生 select 的**展开列表由操作系统绘制**，CSS 完全管不到。
 * 在 Windows 7 上这一点尤其明显：即使声明了 `color-scheme: dark`，
 * 系统主题引擎仍然把列表画成**白底**，而选项文字继承的是我们设的
 * 浅色变量 —— 结果就是「深色模式下下拉文字看不见」。
 * 这个问题在 Linux/macOS 上复现不了（实测 Chromium 108 在 Linux 上
 * option 是深色 `rgb(23,27,34)`），所以只能从根上不用原生控件。
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
 * ## 弹层为什么 portal 到 body + position: fixed
 *
 * 这里**两次**踩过定位的坑，最后收敛到现在的做法：
 *
 * 1. 最早用 `fixed` + 视口坐标，但在 AI 输入框里完全失效：祖先
 *    `.composer` 带 `.glass`，即 `backdrop-filter: blur(20px)`，而
 *    **`backdrop-filter` 会为 fixed 子元素创建新的包含块** ——
 *    弹层不再相对视口，实测偏移 779px、跑到屏幕外。
 *    （同类属性还有 transform / filter / perspective / will-change。）
 *
 * 2. 改成 `absolute` + 局部 relative 包裹层解决了上面那条，但**换个位置
 *    又会坏**：设置页的 `.page-scroll` 带 `overflow-y: auto`，
 *    absolute 弹层会被裁掉一半。
 *
 * 现在的做法：portal 到 `document.body`（在 `#root` 之外），
 * 再用 `fixed` + 按钮 rect 算坐标。body 上没有任何会创建包含块的属性
 * （只有背景渐变），所以 `fixed` 在这里是**可靠的视口定位**；
 * 又因为在 #root 之外，任何祖先的 overflow 都裁不到它。
 *
 * 代价是坐标要自己维护，所以监听 scroll / resize 重算
 * （scroll 用 capture 才能收到内层滚动容器的滚动）。
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
   * 额外类名：用来按当前值换配色（如权限模式的三种颜色）
   * 以及控制宽度（见 ui.css）。
   */
  className?: string
  /** 撑满父容器宽度。设置页那些整行的下拉要用它 */
  block?: boolean
  /** 不可用 */
  disabled?: boolean
}

/** 弹层与按钮/视口的间距 */
const GAP = 4
/** 弹层不超出视口时留的边距 */
const EDGE = 6
/** 弹层的理想最大高度。空间不够时会被压缩（见 measure） */
const MAX_POPUP_H = 280
/** 方向翻转的阈值：低于这个可用高度就试着换方向 */
const MIN_USEFUL_H = 160

interface Placement {
  left: number
  top: number
  width: number
  /** 向上展开时为 true。CSS 用 bottom 定位，避免高度算错时抖动 */
  up: boolean
  /**
   * 这次实际可用的最大高度。
   *
   * ⚠️ 必须动态算，不能只靠 CSS 的固定 max-height。
   * 原先 CSS 写死 280px、翻转阈值却是 180px，两者不一致：
   * 按钮下方有 200px 空间时会选择向下展开，而列表能长到 280px，
   * 于是**溢出视口底部 80px** —— 底部选项点不到。
   * 现在按「这一侧真实剩多少」来限高，方向与高度用的是同一个数，
   * 不会再出现两者打架。
   */
  maxHeight: number
}

export default function Select<T extends string>({
  value,
  options,
  onChange,
  ariaLabel,
  title,
  className = '',
  block = false,
  disabled = false
}: Props<T>): JSX.Element {
  const [open, setOpen] = useState(false)
  const [place, setPlace] = useState<Placement | null>(null)
  const btnRef = useRef<HTMLButtonElement | null>(null)
  const popRef = useRef<HTMLDivElement | null>(null)
  /** 键盘高亮项。打开时先落在当前值上 */
  const [active, setActive] = useState(0)

  const current = options.find((o) => o.value === value)

  /**
   * 算位置。
   *
   * 方向按**可用空间**决定，不写死：输入框在最底部 → 下方没空间 → 向上；
   * 设置页在中部 → 向下。写死任一个都会在另一处出问题。
   */
  const measure = (): void => {
    const btn = btnRef.current
    if (!btn) return
    const r = btn.getBoundingClientRect()
    // 宽度跟随按钮，但不小于 120（太窄的列表读起来费劲）
    const width = Math.max(r.width, 120)
    // 水平方向夹在视口内，避免右边溢出
    const left = Math.min(Math.max(EDGE, r.left), window.innerWidth - width - EDGE)

    // 两侧各自真实可用的高度（扣掉间距与视口边距）
    const spaceBelow = window.innerHeight - r.bottom - GAP - EDGE
    const spaceAbove = r.top - GAP - EDGE

    /*
     * 方向：优先向下（符合「从按钮往下展开」的直觉）。
     * 只有下方连一个可用高度都放不下、且上方确实更宽敞时才翻转 ——
     * 光比较「谁更大」会在下方刚好够用时也翻转，看起来像弹错了方向。
     */
    const up = spaceBelow < MIN_USEFUL_H && spaceAbove > spaceBelow

    /*
     * 高度**不设下限**，只设上限。
     *
     * 这里刻意不用「至少 MIN_USEFUL_H」那种兜底：一旦两个方向的空间
     * 都不足 160px，兜底出来的 160 反而会**溢出视口**，底部选项被切掉。
     * 我们要的不变式是「弹层完整可见」，所以高度只能取「当前这侧真实
     * 剩多少」——空间小就矮一点、内部滚动，任何情况下都不会溢出。
     */
    const maxHeight = Math.max(0, Math.min(MAX_POPUP_H, up ? spaceAbove : spaceBelow))

    setPlace({
      left,
      width,
      up,
      maxHeight,
      // up 时用 bottom 定位（离视口底部多远），否则用 top
      top: up ? window.innerHeight - r.top + GAP : r.bottom + GAP
    })
  }

  useLayoutEffect(() => {
    if (!open) return
    measure()
    /*
     * scroll 用 capture：设置页的滚动发生在 .page-scroll 这个内层容器上，
     * 不捕获的话收不到，弹层会在滚动时脱节留在原地。
     */
    const onScroll = (): void => measure()
    window.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', onScroll)
    return () => {
      window.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', onScroll)
    }
    // measure 每次渲染都是新函数，放进依赖会让弹层反复重算；只在 open 变化时挂监听
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

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

  /*
   * 弹层用 portal 挂到 body。
   *
   * 必须这样，不能留在原地：设置页的 .page-scroll 有 overflow-y:auto，
   * 留在里面会被裁掉一半（这个坑踩过一次）。
   */
  const popup =
    open && place
      ? createPortal(
          <div
            ref={popRef}
            className={`ui-select-pop${place.up ? ' is-up' : ''}`}
            role="listbox"
            aria-label={ariaLabel}
            style={{
              left: place.left,
              width: place.width,
              maxHeight: place.maxHeight,
              // 向上时用 bottom 定位：弹层高度随选项数量变，
              // 用 top 反算要量高度，用 bottom 直接贴住按钮省一次测量
              ...(place.up
                ? { bottom: place.top }
                : { top: place.top })
            }}
          >
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
          </div>,
          document.body
        )
      : null

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        className={`ui-select${open ? ' is-open' : ''}${block ? ' is-block' : ''} ${className}`.trim()}
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={disabled}
        title={title || current?.hint || current?.label}
        onClick={() => (open ? setOpen(false) : openList())}
        onKeyDown={onKeyDown}
      >
        <span className="ui-select-label">{current?.label || value}</span>
        <CaretIcon />
      </button>
      {popup}
    </>
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
