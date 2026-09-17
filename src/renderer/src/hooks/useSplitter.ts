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
      /*
       * 先把可能残留的捕获放掉，再重新捕获。
       *
       * ⚠️ 残留捕获会让**整个界面点不动**：指针捕获期间所有指针事件
       * 都被路由给捕获元素，输入框、按钮一律收不到 mousedown ——
       * 表现就是「拖过一次之后，输入框再也选不中」。
       * 上一次的 pointerup 若丢了（Win7 上软件渲染 + 高负载时可能发生），
       * 捕获就留在这里；这里主动释放一次，保证每次拖动都是干净起点。
       */
      for (const pid of capturedIds(el)) {
        try {
          el.releasePointerCapture(pid)
        } catch {
          /* 没捕获过会抛错，忽略 */
        }
      }
      /*
       * 捕获失败不能让拖动整个失效。
       *
       * setPointerCapture 在几种情况下会抛（指针已不活跃、合成事件、
       * 某些远程桌面/驱动环境）。原来它裸调用，一抛就把整个 pointerdown
       * 处理器打断 —— 结果是 setDragging(true) 都没执行，拖动完全不响应。
       * 捕获只是「手滑出条子也能继续拖」的增强，失败时退化成普通拖动
       * 仍然可用，所以这里必须 try 住。
       */
      try {
        el.setPointerCapture(e.pointerId)
      } catch {
        /* 没捕获到就退化成不捕获的拖动，功能不受影响 */
      }
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

    /** 取消未落地的 rAF 写入 */
    const cancelPending = (): void => {
      if (rafId !== 0) {
        window.cancelAnimationFrame(rafId)
        rafId = 0
      }
      pending = null
    }

    /**
     * 把变量写成某个确定的值。
     *
     * ⚠️ 这里**绝不能用 removeProperty**，那是「拖动后弹回原位」的根因。
     *
     * 原因是这个变量同时被两方写：拖动期间是这里，非拖动时是 React
     * （App.tsx 把 `--split` 放进 .stage 的 style prop）。
     * 以前松手时调 removeProperty，删掉的正是 React 那一个 ——
     * 于是 .editor-dock 的 `calc(var(--split, 0.62) * 100%)` 回落到
     * fallback 0.62，宽度弹回原位。
     *
     * 更糟的是它会**永久**卡住：React 记着自己上次渲染的是 0.62，
     * 松手后重渲染仍是 0.62（store 更新还没轮到），React 判定「style 没变」
     * 就不重新写入；等 store 变成新值时，React 才会写 —— 但只要中间
     * 任何一次渲染让它以为没变，属性就一直是空的。
     * 实测：松手后 --split 为空、编辑器宽度 748px 纹丝不动，
     * 而 config.json 里明明存着 0.4543。
     *
     * 现在改成写入**具体值**：松手时写最终值，React 之后渲染同一个值，
     * 两者一致，不会跳变也不会丢。
     */
    const writeVar = (v: number): void => {
      cancelPending()
      targetEl()?.style.setProperty(cssVarRef.current, String(v))
    }

    const onMove = (e: PointerEvent): void => {
      /*
       * ★ 兜底：鼠标键已经松开了，但我们没收到 pointerup。
       *
       * pointerup 丢失时（Win7 软件渲染高负载、驱动异常、窗口失焦都可能），
       * 指针捕获会**一直留着**，而捕获期间所有指针事件都被路由给分割条 ——
       * 输入框、按钮一律收不到 mousedown，表现就是「拖过一次之后，
       * 输入框再也点不中」。实测确认过这条链路。
       *
       * `buttons` 是**当前**按下的键位掩码，它比事件可靠：只要指针还在动
       * 就一定会带上真实状态。发现 0 就说明用户早已松手，直接按「松手」
       * 处理并结束拖动，别等一个可能永远不来的 pointerup。
       *
       * 判断放在写变量之前：这样不会用一个过期坐标覆盖最终值。
       */
      if (e.buttons === 0) {
        onUp(e)
        return
      }
      pending = ratioAt(e)
      if (rafId === 0) rafId = window.requestAnimationFrame(flush)
      captured = (e.target as HTMLElement) || captured
      pointerId = e.pointerId
    }

    const onUp = (e: PointerEvent): void => {
      const next = ratioAt(e)
      /*
       * 松手才提交。
       *
       * 顺序：先把**最终值**写进变量，再 setState 提交。
       *
       * 不写这一下的话：最后一次 pointermove 可能还在 rAF 里没落地，
       * 松手瞬间会闪一下旧值。而写成最终值则与 React 随后的渲染一致。
       */
      writeVar(next)
      setDragging(false)
      onChange(next)
    }

    const onCancel = (): void => {
      /*
       * pointercancel：系统抢走指针（弹右键菜单、切窗口）时触发。
       * 这时不能提交 —— 用户并没有确认这个位置，要**还原成拖动前的值**。
       *
       * 还原用 writeVar(起始值) 而不是 removeProperty：
       * 理由同上面的 writeVar 注释（删属性会连带删掉 React 那份）。
       */
      writeVar(startRef.current.ratio)
      setDragging(false)
    }

    /*
     * 捕获丢失兜底。
     *
     * 系统在某些情况下（窗口失焦、弹系统菜单、驱动异常）会直接
     * 撤掉指针捕获而不发 pointerup。那时拖动状态不会自己结束 ——
     * `dragging` 一直为 true，界面停在「正在拖」，而且按钮一直按着的样子。
     * 这里按「取消」处理：还原到拖动前的值，因为用户并没有确认这个位置。
     */
    const onLostCapture = (): void => {
      writeVar(startRef.current.ratio)
      setDragging(false)
    }
    window.addEventListener('lostpointercapture', onLostCapture)
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onCancel)
    return () => {
      window.removeEventListener('lostpointercapture', onLostCapture)
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onCancel)
      /*
       * 这里**不能**动那个变量。
       *
       * effect 的依赖里有 dragging，所以松手时（true→false）这个 cleanup
       * 也会跑一次。以前它在这里 removeProperty，正好把 onUp 刚写好的
       * 值擦掉 —— 这是「弹回原位」的第二个入口，即使 onUp 改对了也会被它毁掉。
       * 变量此时已经是正确值，交给 React 保持即可。
       */
      if (captured && pointerId >= 0 && captured.hasPointerCapture?.(pointerId)) {
        captured.releasePointerCapture(pointerId)
      }
    }
  }, [dragging, min, max, onChange])

  /*
   * 卸载时才清掉变量。
   *
   * 单独一个空依赖的 effect：与上面那个不同，它只在组件真正卸载时跑，
   * 不会被 dragging 变化误触发（切到设置页等场景要靠它清干净）。
   */
  useEffect(() => {
    return () => {
      const el = document.querySelector<HTMLElement>(targetRef.current)
      el?.style.removeProperty(cssVarRef.current)
    }
  }, [])

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

/**
 * 列出这个元素当前捕获着的所有 pointerId。
 *
 * 没有 API 能直接枚举，只能按 id 探。指针 id 是小的自增整数
 * （鼠标恒为 1，触摸从 1 起递增），探 1~12 足够覆盖真实交互，
 * 超过这个数只可能是异常状态 —— 那时也还有下面的指针捕获丢失兜底。
 */
function capturedIds(el: HTMLElement): number[] {
  const ids: number[] = []
  for (let pid = 1; pid <= 12; pid++) {
    try {
      if (el.hasPointerCapture(pid)) ids.push(pid)
    } catch {
      /* 某些实现会在未捕获时抛错，忽略 */
    }
  }
  return ids
}
