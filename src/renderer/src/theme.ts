/**
 * 深色 / 浅色主题切换。
 *
 * 状态只落在 documentElement 的 data-theme 上，CSS 里靠变量切换，
 * 所以组件不需要知道当前是什么主题，也不需要重新渲染。
 * 选择存 localStorage（Electron 下就在 userData 里，重启仍在）。
 */

export type Theme = 'dark' | 'light'

const STORAGE_KEY = 'ai-editor-theme'

export function readTheme(): Theme {
  try {
    const saved = localStorage.getItem(STORAGE_KEY)
    if (saved === 'dark' || saved === 'light') return saved
  } catch {
    // 隐私模式等场景下 localStorage 可能不可用，忽略即可
  }
  // 没存过就跟随系统
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'
}

export function applyTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme
  try {
    localStorage.setItem(STORAGE_KEY, theme)
  } catch {
    // 存不下就算了，不影响本次会话
  }
}
