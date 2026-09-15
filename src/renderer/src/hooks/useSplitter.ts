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
  max = 0.85
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

    /** 指针当前坐标 → 比例增量 */
    const ratioAt = (e: PointerEvent): number => {
      const size = sizeRef.current
      if (size <= 0) return startRef.current.ratio
      const current = axisRef.current === 'vertical' ? e.clientX : e.clientY
      const delta = (current - startRef.current.pos) / size
      return clamp(startRef.current.ratio + delta, min, max)
    }

    const onMove = (e: PointerEvent): void => {
      // 只写 CSS 变量，不 setState —— 见文件头注释
      document.documentElement.style.setProperty('--split', String(ratioAt(e)))
      captured = (e.target as HTMLElement) || captured
      pointerId = e.pointerId
    }

    const onUp = (e: PointerEvent): void => {
      const next = ratioAt(e)
      // 松手才提交。清掉变量，让 CSS 回落到由 state 算出的值，
      // 否则变量会一直是最后拖到的位置，和 state 不一致
      document.documentElement.style.removeProperty('--split')
      setDragging(false)
      onChange(next)
    }

    const onCancel = (): void => {
      // pointercancel 发生在系统抢走指针时（比如弹出右键菜单、切窗口），
      // 这时不能把当前值提交 —— 用户并没有确认这个位置
      document.documentElement.style.removeProperty('--split')
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
      document.documentElement.style.removeProperty('--split')
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
