/**
 * 只启动渲染层的 Vite（不启 Electron 窗口）。
 *
 * 用途：`npm run dev` 会同时拉起 Vite 与 Electron 窗口，而窗口在某些
 * 受限环境里起不来（chrome-sandbox 权限 / futex 不可用）—— 它一崩，
 * Vite 也跟着退出，于是「5173 打不开」。
 *
 * 这个配置只跑 Vite，所以 5173 与窗口是否起来无关。用浏览器打开时
 * `dev-api-stub.ts` 会接管 window.api（内存文件系统 + 模拟 AI 流），
 * 界面照样能点。
 *
 *   npx vite --config vite.preview.config.ts
 *
 * ⚠️ 这不是开发的主路径：浏览器预览没有真实文件系统与 IPC。
 * 正式开发仍用 `npm run dev`。
 */
import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  root: resolve(__dirname, 'src/renderer'),
  base: './',
  server: {
    host: '0.0.0.0',
    port: 5173,
    strictPort: true
  },
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src/renderer/src'),
      '@shared': resolve(__dirname, 'src/shared')
    }
  },
  plugins: [react()]
})
