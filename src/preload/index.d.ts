import type { AppApi } from '../shared/api'

declare global {
  interface Window {
    api: AppApi
    /** 自检入口，由渲染进程在启动时注入；主进程 --self-test 会调用它 */
    __SELFTEST__?: () => Promise<Record<string, unknown>>
    /** 浏览器预览模式下 window.api 是 dev 桩装的，置为 true；Electron 里不会出现 */
    __DEV_API_STUB__?: boolean
  }
}

export {}
