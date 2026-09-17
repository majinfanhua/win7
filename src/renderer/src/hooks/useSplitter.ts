import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * 拖拽分割条。
 *
 * 用 Pointer Events 而不是 mouse 事件：
 *   - `setPointerCapture` 让指针跑到条子外面（甚至窗口外）也继续收事件，
 *     这是鼠标拖拽最容易漏掉的一环 —— 手快一点脱离条子，拖动就断了
 *   - 触摸与鼠标走同一条代码路径，不用写两套
 * Chromium 108 完整支持 Pointer Events，Win7 上也没有兼容问题。
 *
 * 关键性能约束：拖动过程中不能每帧 setState。
 * `pointermove` 在拖动时能到 60~120Hz，每帧触发一次 React 重渲染，
 * 中间是 Monaco 编辑器的话会明显卡顿。所以拖动期间只改 CSS 变量
 * （`--split`），松手时才提交一次状态。CSS 变量变化不触发 React 渲染。
 */

/** 分割方向 */
export type SplitAxis = 'horizontal' | 'vertical'

export interface SplitterOptions {
  /**
   * 分割方向。
   *
   * 'horizontal' = 上下分（相邻两栏纵向排列，拖动改高度，指针看 Y）
   * 'vertical'   = 左右分（相邻两栏横向排列，拖动改宽度，指针看 X）
   * 命名按「分割条本身的方向」比按「面板排列方向」更好记：
   * 一条横着的分割条，它就是 horizontal。
   */
  axis: SplitAxis
  /** 容器尺寸（px）。横向分割传高度，竖向分割传宽度 */
  containerSize: number
  /** 提交后的分割比例，0~1，表示前一个区域占比 */
  value: number
  /** 松手（或键盘调整）时提交 */
  onChange: (ratio: number) => void
  /** 上下限，防止某一侧被拖到不可用 */
  min?: number
  max?: number
  /**
   * 拖动期间写哪个 CSS 变量。默认 --split（内容区的左右分割）。
   * 侧栏那条上下分割用 --sidebar-split，两条互不干扰。
   */
  cssVar?: string
  /**
   * 变量写到哪个元素上。默认 `.stage`。
   *
   * ⚠️ 必须是**样式的实际来源元素**：如果某处用内联 style 设了同名变量
   * （App.tsx 给 .stage 设了 --split），那么写在更上层的 documentElement
   * 上会被内联那份遮蔽，拖动完全不生效 —— 这个坑踩过，见下面的注释。
   */
  targetSelector?: string
}

export interface SplitterApi {
  /** 挂到分割条元素上 */
  onPointerDown: (e: React.PointerEvent) => void
  /** 键盘方向键调整，无障碍与精确微调用 */
  onKeyDown: (e: React.KeyboardEvent) => void
  /** 是否正在拖动，用于给分割条加高亮样式 */
  dragging: boolean
}

export function useSplitter({
  axis,
  containerSize,
  value,
  onChange,
  min = 0.2,
  max = 0.85,
  cssVar = '--split',
  targetSelector = '.stage'
}: SplitterOptions): SplitterApi {
  const [dragging, setDragging] = useState(false)
  /** 拖动开始时的指针坐标与当时的比例，用来算增量 */
  const startRef = useRef({ pos: 0, ratio: 0 })
  /**
   * 容器尺寸放 ref 里。
   *
   * 不能在 pointermove 里读 props：那个回调是在 effect 里注册的，
   * 闭包会捕获注册那一刻的 containerSize。窗口在拖动期间被缩放的话，
   * 换算出来的比例就是按旧尺寸算的，会跳一下。
   */
  const sizeRef = useRef(containerSize)
  sizeRef.current = containerSize
  const axisRef = useRef(axis)
  axisRef.current = axis
  const cssVarRef = useRef(cssVar)
  cssVarRef.current = cssVar
  const targetRef = useRef(targetSelector)
  targetRef.current = targetSelector

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      // 只响应主键（鼠标左键 / 单指触摸），右键拖不该改布局
      if (e.button !== 0) return
      e.preventDefault()
      const el = e.currentTarget as HTMLElement
      el.setPointerCapture(e.pointerId)
      startRef.current = {
        pos: axisRef.current === 'vertical' ? e.clientX : e.clientY,
        ratio: value
      }
      setDragging(true)
    },
    [value]
  )

  useEffect(() => {
    if (!dragging) return

    /** 正在拖的那个元素，松手时要释放捕获 */
    let captured: HTMLElement | null = null
    let pointerId = -1

    /*
     * ⚠️ 变量必须写在 `.stage` 上，不能写 documentElement。
     *
     * 这条是实测踩出来的：`App.tsx` 给 `.stage` 设了**内联**的
     * `--split`（React 的 style 属性），而内联自定义属性会**遮蔽**
     * 祖先上同名的那一份。所以以前写 documentElement 时：
     *
     *   写 documentElement  → 面板宽度 748px 纹丝不动（不生效）
     *   写 .stage           → 748px → 362px（生效）
     *
     * 表现就是「拖动时面板不跟随，松手才跳过去」—— 用户会说「卡顿」，
     * 但根因不是性能，是变量压根没生效。
     *
     * 同时这也让重算范围更小：--split 只被 .stage 的两个子元素用，
     * 写在这里就不必让整份文档参与样式重算。
     */
    const targetEl = (): HTMLElement | null => document.querySelector(targetRef.current)

    /** 指针当前坐标 → 比例增量 */
    const ratioAt = (e: PointerEvent): number => {
      const size = sizeRef.current
      if (size <= 0) return startRef.current.ratio
      const current = axisRef.current === 'vertical' ? e.clientX : e.clientY
      const delta = (current - startRef.current.pos) / size
      return clamp(startRef.current.ratio + delta, min, max)
    }

    /*
     * 用 rAF 合帧，而不是每个 pointermove 都写一次。
     *
     * pointermove 在 Windows 上能到 120Hz+，而屏幕通常 60Hz —— 多出来的
     * 那些算出来根本不会被显示，纯粹浪费：每次写都会触发 .stage 子树的
     * 样式重算 + 布局，而那里包着 Monaco。攒到下一帧只写最终值，
     * 视觉完全一样，写入次数减半。
     */
    let rafId = 0
    let pending: number | null = null

    const flush = (): void => {
      rafId = 0
      if (pending === null) return
      const el = targetEl()
      if (el) el.style.setProperty(cssVarRef.current, String(pending))
      pending = null
    }

    /** 清掉临时变量，让 CSS 回落到由 state 算出的值 */
    const clearVar = (): void => {
      if (rafId !== 0) {
        window.cancelAnimationFrame(rafId)
        rafId = 0
      }
      pending = null
      targetEl()?.style.removeProperty(cssVarRef.current)
    }

    const onMove = (e: PointerEvent): void => {
      pending = ratioAt(e)
      if (rafId === 0) rafId = window.requestAnimationFrame(flush)
      captured = (e.target as HTMLElement) || captured
      pointerId = e.pointerId
    }

    const onUp = (e: PointerEvent): void => {
      const next = ratioAt(e)
      /*
       * 松手才提交。顺序要注意：**先清临时变量，再 setState**。
       * 反过来的话，state 更新后 React 会重写 .stage 的内联 --split，
       * 而残留的旧变量与它打架，会闪一下。
       */
      clearVar()
      setDragging(false)
      onChange(next)
    }

    const onCancel = (): void => {
      // pointercancel 发生在系统抢走指针时（比如弹出右键菜单、切窗口），
      // 这时不能把当前值提交 —— 用户并没有确认这个位置
      clearVar()
      setDragging(false)
    }

    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onCancel)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onCancel)
      // 组件在拖动中被卸载（比如切到设置页）时，别留下一个脏变量
      clearVar()
      if (captured && pointerId >= 0 && captured.hasPointerCapture?.(pointerId)) {
        captured.releasePointerCapture(pointerId)
      }
    }
  }, [dragging, min, max, onChange])

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      const step = e.shiftKey ? 0.1 : 0.02
      // 左右分割时方向键要跟着转：→ 是把左栏加宽
      const shrinkKey = axis === 'vertical' ? 'ArrowLeft' : 'ArrowUp'
      const growKey = axis === 'vertical' ? 'ArrowRight' : 'ArrowDown'
      let next: number | null = null
      if (e.key === shrinkKey) next = clamp(value - step, min, max)
      else if (e.key === growKey) next = clamp(value + step, min, max)
      else if (e.key === 'Home') next = min
      else if (e.key === 'End') next = max
      if (next === null) return
      e.preventDefault()
      onChange(next)
    },
    [value, onChange, min, max, axis]
  )

  return { onPointerDown, onKeyDown, dragging }
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n))
}
