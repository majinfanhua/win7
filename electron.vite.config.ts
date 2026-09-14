import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

/**
 * 构建目标锁死（Win7 兼容的关键）
 * - 主进程：Node 16.17.1（Electron 22 内置）
 * - 预加载：Node 16（electron-vite 强制要求 node 目标，预加载跑在 Node 上下文）
 * - 渲染进程：Chrome 108（Electron 22 内置 Chromium）
 *
 * 渲染进程 target 写成 chrome108 是硬约束：esbuild 会对超出该目标的
 * 语法直接报错，从而把“用了新语法导致 Win7 白屏”挡在构建阶段。
 */
export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      target: 'node16',
      minify: false,
      rollupOptions: { input: { index: resolve(__dirname, 'src/main/index.ts') } }
    },
    resolve: { alias: { '@shared': resolve(__dirname, 'src/shared') } }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      // electron-vite 强制预加载层必须用 node 目标：
      // 预加载脚本在 Node 上下文里执行，不是普通渲染页面
      target: 'node16',
      minify: false,
      rollupOptions: { input: { index: resolve(__dirname, 'src/preload/index.ts') } }
    },
    resolve: { alias: { '@shared': resolve(__dirname, 'src/shared') } }
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    base: './',
    server: {
      // 绑所有网卡，便于从容器 / 局域网外部访问 dev server。
      // 只想本机访问就改回 '127.0.0.1'。
      host: '0.0.0.0',
      port: 5173,
      // 端口被占时直接报错，不要悄悄换成 5174 —— 免得「说好的 5173」对不上
      strictPort: true
    },
    build: {
      target: 'chrome108',
      outDir: resolve(__dirname, 'out/renderer'),
      emptyOutDir: true,
      chunkSizeWarningLimit: 8000,
      rollupOptions: { input: { index: resolve(__dirname, 'src/renderer/index.html') } }
    },
    resolve: {
      alias: {
        '@': resolve(__dirname, 'src/renderer/src'),
        '@shared': resolve(__dirname, 'src/shared')
      }
    },
    plugins: [react()]
  }
})
