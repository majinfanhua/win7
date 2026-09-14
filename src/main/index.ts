import fs from 'node:fs'
import path from 'node:path'
import { BrowserWindow, Menu, app, dialog, ipcMain, shell } from 'electron'
import { IPC } from '../shared/types'
import { getConfig, initConfig, setConfig } from './config'
import { initLogger, installCrashHandlers, logger, setLogSink } from './logger'
import { applyPlatformCompat, detectPlatform } from './platform-compat'
import { getRuntimeInfo, registerDiagnosticsIpc, setCompatState } from './ipc/diagnostics'
import { registerWorkspaceIpc, restoreLastWorkspace } from './ipc/workspace'
import { registerAiIpc } from './ipc/ai'

interface CliOptions {
  forceGpu: boolean
  selfTest: boolean
  selfTestOut: string
}

function parseArgs(argv: string[]): CliOptions {
  return {
    forceGpu: argv.includes('--force-gpu'),
    selfTest: argv.includes('--self-test'),
    selfTestOut: (argv.find((a) => a.startsWith('--self-test-out=')) || '').split('=')[1] || ''
  }
}

const cli = parseArgs(process.argv.slice(1))

let mainWindow: BrowserWindow | null = null

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 640,
    show: false,
    backgroundColor: '#1b1d22',
    title: 'AI 教学编辑器',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // Win7 上保持 sandbox 关闭以最大程度兼容；隔离靠 contextIsolation + 白名单 IPC
      sandbox: false,
      spellcheck: false,
      // Win7 窗口失焦时渲染进程会被节流，叠加遮挡判定问题容易白屏
      backgroundThrottling: false
    }
  })

  // ready-to-show 在老系统上偶尔不触发，加一个兜底定时器
  const showTimer = setTimeout(() => {
    if (!win.isDestroyed() && !win.isVisible()) {
      logger.warn('window', 'ready-to-show 未在 8s 内触发，强制显示窗口')
      win.show()
    }
  }, 8000)

  win.once('ready-to-show', () => {
    clearTimeout(showTimer)
    win.show()
    logger.info('window', '主窗口已显示')
  })

  win.webContents.on('did-finish-load', () => {
    logger.info('window', '渲染进程加载完成')
  })

  win.webContents.on('did-fail-load', (_e, code, desc, url) => {
    logger.error('window', `页面加载失败 code=${code} desc=${desc} url=${url}`)
  })

  win.webContents.on('preload-error', (_e, preloadPath, error) => {
    logger.error('window', `preload 执行失败 ${preloadPath}: ${error.stack || error.message}`)
  })

  // 把渲染进程的 console 收进主日志，Win7 上没法开 DevTools 时就靠这个
  win.webContents.on('console-message', (_e, level, message, line, sourceId) => {
    const map = ['debug', 'info', 'warn', 'error'] as const
    logger[map[level] || 'info']('renderer', `${message} (${sourceId}:${line})`)
  })

  // 不允许渲染进程自行开新窗口；外部链接交给系统浏览器
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('file://') && !url.startsWith(process.env['ELECTRON_RENDERER_URL'] || '\u0000')) {
      event.preventDefault()
      if (/^https?:/i.test(url)) void shell.openExternal(url)
    }
  })

  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl) {
    void win.loadURL(devUrl)
  } else {
    void win.loadFile(path.join(__dirname, '../renderer/index.html'))
  }

  return win
}

function sendMenu(action: string): void {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(IPC.evtMenu, action)
}

function registerConfigIpc(): void {
  ipcMain.handle(IPC.configGet, () => getConfig())
  ipcMain.handle(IPC.configSet, (_e, patch: Parameters<typeof setConfig>[0]) => setConfig(patch))
}

function buildMenu(): void {
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: '文件',
      submenu: [
        { label: '打开文件夹…', accelerator: 'CmdOrCtrl+O', click: () => sendMenu('open-folder') },
        { label: '新建文件', accelerator: 'CmdOrCtrl+N', click: () => sendMenu('new-file') },
        { type: 'separator' },
        { label: '保存', accelerator: 'CmdOrCtrl+S', click: () => sendMenu('save') },
        { type: 'separator' },
        { label: '退出', role: 'quit' }
      ]
    },
    {
      label: '编辑',
      submenu: [
        { label: '撤销', role: 'undo' },
        { label: '重做', role: 'redo' },
        { type: 'separator' },
        { label: '剪切', role: 'cut' },
        { label: '复制', role: 'copy' },
        { label: '粘贴', role: 'paste' },
        { label: '全选', role: 'selectAll' }
      ]
    },
    {
      label: '视图',
      submenu: [
        { label: '重新加载', role: 'reload' },
        { label: '开发者工具', role: 'toggleDevTools' },
        { type: 'separator' },
        { label: '放大', role: 'zoomIn' },
        { label: '缩小', role: 'zoomOut' },
        { label: '恢复默认缩放', role: 'resetZoom' },
        { type: 'separator' },
        { label: '全屏', role: 'togglefullscreen' }
      ]
    },
    {
      label: '设置',
      submenu: [{ label: 'AI 模型与编辑器设置…', accelerator: 'CmdOrCtrl+,', click: () => sendMenu('settings') }]
    },
    {
      label: '帮助',
      submenu: [
        { label: '运行环境体检', click: () => sendMenu('doctor') },
        { label: '打开日志目录', click: () => sendMenu('open-logs') },
        { type: 'separator' },
        { label: '关于', click: () => sendMenu('about') }
      ]
    }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

/**
 * 自检模式：启动 → 等渲染进程跑完 → 在页面里执行 __SELFTEST__ → 输出 JSON 并退出。
 * 用于 CI 和发布前回归，避免“能打包但一启动就白屏”。
 */
function runSelfTest(win: BrowserWindow): void {
  const outFile = cli.selfTestOut
  const fail = (reason: string): void => {
    const result = { ok: false, reason }
    logger.error('selftest', `失败: ${reason}`)
    // eslint-disable-next-line no-console
    console.log('SELFTEST_RESULT ' + JSON.stringify(result))
    if (outFile) {
      try {
        fs.writeFileSync(outFile, JSON.stringify(result, null, 2), 'utf8')
      } catch {
        /* ignore */
      }
    }
    app.exit(1)
  }

  const timer = setTimeout(() => fail('渲染进程 30s 内未完成自检'), 30_000)

  win.webContents.once('did-finish-load', async () => {
    try {
      const payload = await win.webContents.executeJavaScript(
        'typeof window.__SELFTEST__ === "function" ? window.__SELFTEST__() : { ok: false, reason: "未注入 __SELFTEST__" }',
        true
      )
      clearTimeout(timer)
      const result: Record<string, unknown> = {
        ...(payload as Record<string, unknown>),
        runtime: getRuntimeInfo()
      }
      // eslint-disable-next-line no-console
      console.log('SELFTEST_RESULT ' + JSON.stringify(result))
      if (outFile) {
        try {
          fs.writeFileSync(outFile, JSON.stringify(result, null, 2), 'utf8')
        } catch {
          /* ignore */
        }
      }
      app.exit(result.ok === true ? 0 : 1)
    } catch (err) {
      clearTimeout(timer)
      fail(`执行 __SELFTEST__ 异常: ${String(err)}`)
    }
  })
}

function main(): void {
  initLogger()
  installCrashHandlers()
  initConfig()

  const platform = detectPlatform()
  const compat = applyPlatformCompat(platform, {
    softwareRendering: getConfig().legacyGraphics.softwareRendering,
    forceGpu: cli.forceGpu
  })
  setCompatState({ softwareRendering: compat.softwareRendering, notes: compat.notes, platform })

  logger.info(
    'app',
    `启动: ${platform.name}(${platform.release}) ${process.arch} | 支持等级=${platform.support} | Electron ${process.versions.electron} / Chromium ${process.versions.chrome} / Node ${process.versions.node}`
  )

  if (platform.support !== 'full') {
    logger.warn('app', `当前系统不在承诺支持范围：${platform.supportNote}`)
  }

  if (!app.requestSingleInstanceLock()) {
    logger.warn('app', '已有实例在运行，本次启动退出')
    app.quit()
    return
  }

  app.on('second-instance', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })

  app.whenReady().then(() => {
    registerDiagnosticsIpc()
    registerConfigIpc()
    registerWorkspaceIpc()
    registerAiIpc()
    restoreLastWorkspace()
    buildMenu()

    mainWindow = createWindow()
    setLogSink((line) => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(IPC.evtLog, line)
    })

    if (cli.selfTest) runSelfTest(mainWindow)

    logger.info('app', '启动完成')
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow()
  })

  app.on('window-all-closed', () => {
    app.quit()
  })

  // 渲染进程崩溃时给出可操作的下一步，而不是直接消失
  app.on('render-process-gone', (_e, _wc, details) => {
    if (cli.selfTest || details.reason === 'clean-exit') return
    const choice = dialog.showMessageBoxSync({
      type: 'error',
      title: '界面进程异常退出',
      message: `渲染进程已退出（${details.reason}）。`,
      detail: '如果反复出现，可尝试以软件渲染模式重启（Win7 老显卡常见）。日志已保存，可从「帮助 → 打开日志目录」查看。',
      buttons: ['以软件渲染模式重启', '退出'],
      defaultId: 0,
      cancelId: 1
    })
    if (choice === 0) {
      setConfig({ legacyGraphics: { softwareRendering: true } })
      app.relaunch({ args: process.argv.slice(1).concat(['--software']) })
    }
    app.exit(1)
  })

  process.on('exit', () => {
    logger.info('app', '进程退出')
  })
}

main()
