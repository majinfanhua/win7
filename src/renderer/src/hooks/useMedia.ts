import { useEffect, useState } from 'react'

/**
 * 订阅一条 CSS 媒体查询。
 *
 * 用 window.matchMedia 而不是自己监听 resize：resize 在拖动窗口时会每帧触发，
 * 而这里只需要「跨过断点」这一个瞬间。老机器上少跑几百次回调是有意义的。
 *
 * Chromium 108 上 addEventListener 可用，但仍保一份 addListener 降级分支，
 * 免得以后有人换内核时踩到。
 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return false
    return window.matchMedia(query).matches
  })

  useEffect(() => {
    if (!window.matchMedia) return
    const list = window.matchMedia(query)
    const onChange = (e: MediaQueryListEvent): void => setMatches(e.matches)
    setMatches(list.matches)
    if (list.addEventListener) {
      list.addEventListener('change', onChange)
      return () => list.removeEventListener('change', onChange)
    }
    // 极老内核的兼容路径
    list.addListener(onChange)
    return () => list.removeListener(onChange)
  }, [query])

  return matches
}

/** 窄屏（手机/平板竖屏）。侧栏与文件树面板在这种宽度下默认收起 */
export function useIsMobile(): boolean {
  return useMediaQuery('(max-width: 820px)')
}
