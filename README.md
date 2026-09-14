# win7-ai-editor

面向教学场景的 AI 代码编辑器，分发为 **Windows 免安装版**，覆盖 **Windows 7 SP1 ~ Windows 10**（32/64 位）。

## 关键约束

| 项 | 取值 | 原因 |
|---|---|---|
| Electron | **22.3.27**（锁定） | 22.x 是最后一个支持 Win7 的版本，23 起要求 Win10 1809+ |
| 渲染目标 | Chrome 108 | Electron 22 内置 Chromium |
| 主进程目标 | Node 16 | Electron 22 内置 Node 16.17.1（无全局 fetch） |
| 原生模块 | **禁止引入** | ABI 110，预编译包不可用 |

## 打包方式

**只通过 GitHub Actions 打包**，开发环境不做 Windows 打包（`npm run dist:win` 会直接拒绝执行）。

产物（免安装 zip，x64 + ia32）：

```
AIEditor-<version>-win7-win10-x64.zip
AIEditor-<version>-win7-win10-ia32.zip
```

> Windows 版本不是打包维度。同一份包在 Win7 SP1 / Win8 / Win10 上都能跑，
> 系统差异在启动时自适应（Win7/8 走软件渲染，Win10 走硬件加速）。

### 产物从哪拿

| 位置 | 在哪 | 说明 |
|---|---|---|
| **Releases 页**（推荐）| 仓库 → Releases | `latest` 是 main 的滚动构建（prerelease）；推 `v*` tag 生成正式 Release |
| Artifacts | 工作流**运行页**（不是任务日志页）底部 | 带自检报告，默认 90 天后过期 |

> 两个常见困惑：
> 1. **任务日志页看不到 Artifacts**，必须点进工作流的运行页，在最下方。
> 2. 构建成功**不会自动产生 Release**（除非推 tag），这是刻意的：Release 只从 tag 或滚动 `latest` 来。

## 本地开发

```bash
npm ci
npm run dev        # 开发模式（Vite HMR）
npm run typecheck  # 类型检查
npm run build      # 构建
npm run smoke      # 无头启动自检（Linux 需 xvfb，其他平台会直接弹窗口）
```

> 开发态的用户数据目录是 **`AIEditor-dev`**，与打包版的 `AIEditor` 分开。
> 这样 `npm run dev` 不会和本机已解压的打包版抢单实例锁，也不会写坏真实配置。
> 启动日志会打印实际目录。

### dev server

| 项 | 值 |
|---|---|
| 地址 | `http://0.0.0.0:5173/`（绑所有网卡，局域网可访问）|
| 端口 | `5173`；`strictPort` 打开，被占时直接报错，不会悄悄换端口 |

只想本机访问：把 `electron.vite.config.ts` 里 `renderer.server.host` 改回 `'127.0.0.1'`。

**不要用普通浏览器直接打开 5173** —— 渲染进程依赖 preload 注入的 `window.api`，
缺了它 `App.tsx` 会直接报错白屏，5173 只能由 Electron 加载。

Linux 容器 / root 环境下 Electron 起不来（`chrome-sandbox` 非 setuid-root），改用
`npx electron-vite dev --noSandbox`。

## 文档

- `docs/技术框架方案.md` —— 完整技术方案
- `docs/多系统-测试清单.md` —— 分发前真机验证清单
