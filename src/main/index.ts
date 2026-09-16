import fs from 'node:fs'
import path from 'node:path'
import { BrowserWindow, Menu, app, dialog, ipcMain, shell } from 'electron'
import { IPC, type AppConfig } from '../shared/types'
import { getConfig, initConfig, setConfig } from './config'
import { initLogger, installCrashHandlers, logger, setLogSink } from './logger'
import { applyPlatformCompat, detectPlatform } from './platform-compat'
import { describeCapability, getCapabilityInfo, setCapabilityProfileOverride } from './capabilities'
import { sweepScriptDir } from './shell'
import { getRuntimeInfo, registerDiagnosticsIpc, setCompatState } from './ipc/diagnostics'
import { closePreviewServer, registerWorkspaceIpc, restoreLastWorkspace } from './ipc/workspace'
import { registerSessionIpc } from './ipc/sessions'
import { registerAiIpc } from './ipc/ai'
import { registerProfileIpc, flushProfile, scheduleArchiveCatchUp } from './ipc/profile'
import { invalidateSystemPrompt } from './system-doc'
import { drainWrites } from './atomic-file'
import { killAllJobs } from './tools/jobs'
import { setFileChangeEmitter, stopWatching, watchWorkspace } from './watcher'
import { initRoots } from './paths'
import {
  getPermissionMode,
  markExecuting,
  resolveApproval,
  setApprovalSender
} from './permissions'

interface CliOptions {
  forceGpu: boolean
  forceSoftware: boolean
  selfTest: boolean
  selfTestOut: string
  /** --capability-profile=win7 等，CI 用来跑降级分支 */
  capabilityProfile: string
}

function parseArgs(argv: string[]): CliOptions {
  return {
    forceGpu: argv.includes('--force-gpu'),
    forceSoftware: argv.includes('--software'),
    selfTest: argv.includes('--self-test'),
    selfTestOut: (argv.find((a) => a.startsWith('--self-test-out=')) || '').split('=')[1] || '',
    capabilityProfile: (argv.find((a) => a.startsWith('--capability-profile=')) || '').split('=')[1] || ''
  }
}

const cli = parseArgs(process.argv.slice(1))

let mainWindow: BrowserWindow | null = null

/**
 * 退出流程是否已经等过「排队中的写」。
 *
 * before-quit 里推迟退出、等 drainWrites 完成后调 app.quit()，
 * 而 app.quit() **会再次触发 before-quit**。没有这个标记就是无限循环：
 * 每次退出都被推迟，应用永远关不掉 —— 这比丢一次写糟糕得多。
 */
let writesDrained = false

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 640,
    show: false,
    // 和默认主题（深色）的底色一致，避免启动瞬间闪一下别的颜色
    backgroundColor: '#0e1116',
    title: '航科教育 · AI 代码编辑器',
    icon: windowIconPath(),
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
  ipcMain.handle(IPC.configSet, (_e, patch: Parameters<typeof setConfig>[0]) => {
    const next = setConfig(patch)
    /*
     * AI 设定改了就把 system prompt 快照丢掉。
     *
     * 只丢快照、**不在这里重新生成 系统.md**：生成要读运行时探测结果、
     * 要落盘，让设置页的「保存」按钮等它转圈是不必要的。
     *
     * 那「改了设置之后文件什么时候更新」？两个时机：
     *   - 设置页保存后自己要显示全文时，会显式 await 一次重新生成
     *   - 下一次对话开始前，ensureSystemDoc 会按内容比对并重写
     * 两处都不依赖这个 handler，所以这里 fire-and-forget 反而曾经
     * 制造过一个竞态：设置页点「查看全文」时生成可能还没落盘，
     * 于是显示的是**改之前**的内容，用户以为设置没生效。
     */
    if (patch && typeof patch === 'object' && 'ai' in patch) {
      invalidateSystemPrompt()
    }
    return next
  })
  // 每次调用都重新与设置求交，所以设置改完立即生效，不用重启
  ipcMain.handle(IPC.appCapabilities, () => getCapabilityInfo())
}

/**
 * 权限模式与越界审批的 IPC。
 *
 * 审批的方向值得注意：**主进程发问、渲染层回答**（evtApprovalRequest /
 * permissionResolve），而不是渲染层先答应再让主进程干活。因为要动文件的是
 * 主进程，它必须自己等到用户点头 —— 否则渲染层一旦被绕过或出 bug，
 * 审批就只是装饰。
 */
function registerPermissionIpc(): void {
  ipcMain.handle(IPC.permissionGetMode, () => getPermissionMode())
  ipcMain.handle(IPC.permissionSetMode, (_e, mode: string) => {
    // 走 setConfig 而不是直接调 setPermissionMode：这样模式会落盘，
    // 重启后保持用户的选择（setConfig 内部会把值灌进权限层）
    setConfig({ permission: { mode: mode as AppConfig['permission']['mode'] } })
    return getPermissionMode()
  })
  ipcMain.handle(IPC.permissionStartExecuting, (_e, sessionId: string) => {
    /*
     * 计划模式的「开始执行」按会话记。
     *
     * sessionId 由渲染层传入（它本来就知道当前会话），主进程不自己猜 ——
     * 猜错的后果是批准落到了别的会话上，而那个会话的 AI 因此被放行写文件。
     */
    markExecuting(typeof sessionId === 'string' ? sessionId : '')
    return true
  })
  ipcMain.handle(IPC.permissionResolve, (_e, id: string, choice: string) => {
    return resolveApproval(id, choice as 'once' | 'dir' | 'deny')
  })
}

function buildMenu(): void {
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: '文件',
      submenu: [
        { label: '打开文件夹…', accelerator: 'CmdOrCtrl+O', click: () => sendMenu('open-folder') },
        { label: '新建文件', accelerator: 'CmdOrCtrl+Alt+N', click: () => sendMenu('new-file') },
        { type: 'separator' },
        { label: '保存', accelerator: 'CmdOrCtrl+S', click: () => sendMenu('save') },
        { type: 'separator' },
        { label: '退出', role: 'quit' }
      ]
    },
    {
      // 会话是 AI 编辑器里比「文件」更常用的单位，单独一个顶级菜单比塞进文件菜单好找
      label: '会话',
      submenu: [
        { label: '新对话', accelerator: 'CmdOrCtrl+N', click: () => sendMenu('new-session') },
        { type: 'separator' },
        { label: '撤销 AI 上一次修改', accelerator: 'CmdOrCtrl+Z', click: () => sendMenu('undo-ai') }
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
      submenu: [
        { label: '打开设置页…', accelerator: 'CmdOrCtrl+,', click: () => sendMenu('settings') }
      ]
    },
    {
      label: '帮助',
      submenu: [
        { label: '运行环境体检', click: () => sendMenu('doctor') },
        // 「查看日志」与「打开日志目录」是两件事，不能只留一个：
        // 前者是应用内的抽屉（能直接看到 AI 改文件的冲突警告），
        // 后者是把系统文件管理器指到 logs 目录（要看历史日志时用）
        { label: '查看日志', accelerator: 'CmdOrCtrl+Shift+L', click: () => sendMenu('show-logs') },
        { label: '打开日志目录', click: () => sendMenu('open-logs') },
        { type: 'separator' },
        { label: '关于', click: () => sendMenu('about') }
      ]
    }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

/**
 * 自检结果落盘。CI 读这个文件，而不是只靠 stdout（编码与缓冲都可能出问题）。
 */
function writeSelfTestOut(result: Record<string, unknown>): void {
  if (!cli.selfTestOut) return
  try {
    fs.writeFileSync(cli.selfTestOut, JSON.stringify(result, null, 2), 'utf8')
  } catch {
    /* ignore */
  }
}

/**
 * 自检模式：启动 → 等渲染进程跑完 → 在页面里执行 __SELFTEST__ → 输出 JSON 并退出。
 * 用于 CI 和发布前回归，避免“能打包但一启动就白屏”。
 */
function runSelfTest(win: BrowserWindow): void {
  const fail = (reason: string): void => {
    const result = { ok: false, reason }
    logger.error('selftest', `失败: ${reason}`)
    // eslint-disable-next-line no-console
    console.log('SELFTEST_RESULT ' + JSON.stringify(result))
    writeSelfTestOut(result)
    app.exit(1)
  }

  // 软件渲染 + 首次加载 Monaco 在低配机器上偏慢，给足余量；
  // 这个超时只在真的卡死时才会触发
  const timer = setTimeout(() => fail('渲染进程 90s 内未完成自检'), 90_000)

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
      writeSelfTestOut(result)
      app.exit(result.ok === true ? 0 : 1)
    } catch (err) {
      clearTimeout(timer)
      fail(`执行 __SELFTEST__ 异常: ${String(err)}`)
    }
  })
}

/**
 * 用户数据目录名。
 * 打包版必须是 AIEditor —— 随包《使用说明》、测试清单、CI 的日志导出路径写的都是它。
 * 开发态（npm run dev / npm run smoke）另起一个 -dev 目录，原因有两个：
 *   1. 不和本机已解压的打包版抢 requestSingleInstanceLock()
 *   2. 开发调试不会写坏真实配置（apiKey / lastWorkspace 都在 config.json 里）
 *
 * 自检（--self-test）再单独挂一个 -selftest 后缀。单实例锁是按 userData 目录判定的，
 * 自检是一次性诊断进程，不能因为「用户正开着编辑器 / dev 里还跑着一个 Electron」
 * 就直接失败退出（本地 npm run smoke 会稳定撞到），也不该把自检日志混进正常日志。
 */
const BASE_USER_DATA_DIR = app.isPackaged ? 'AIEditor' : 'AIEditor-dev'
const USER_DATA_DIR = cli.selfTest ? `${BASE_USER_DATA_DIR}-selftest` : BASE_USER_DATA_DIR

/**
 * 窗口图标。由 scripts/make-icon.py 生成。
 *
 * 只有开发态需要显式指定：打包后 Windows 窗口会直接继承 exe 自带图标
 * （build/icon.ico），不必再往用户目录里放一份 png。
 * 写成函数是因为要等 app ready 之后才能问 __dirname 之外的东西。
 */
function windowIconPath(): string | undefined {
  if (app.isPackaged) return undefined
  const file = path.join(__dirname, '../../resources/icon.png')
  return fs.existsSync(file) ? file : undefined
}

function main(): void {
  // 必须在任何 getPath('userData') 之前固定目录名。
  // Electron 的 app.getName() 默认取 package.json 的 name（也就是 win7-ai-editor），
  // 不是 productName —— 上一轮 CI 实际落在 %APPDATA%\win7-ai-editor\logs，
  // 而使用说明和 CI 里写的都是 AIEditor，文档会指向一个不存在的目录。
  app.setName(USER_DATA_DIR)
  app.setPath('userData', path.join(app.getPath('appData'), USER_DATA_DIR))

  initLogger()
  installCrashHandlers()
  initConfig()

  // 上次异常退出（崩溃 / 拔电源 / 任务管理器结束进程）时，临时 .cmd 脚本
  // 的 cleanup 跑不到，会攒在 userData/tmp-scripts 里。启动时扫一次最省事
  sweepScriptDir()

  // 必须在任何能力计算之前：CI 用这个开关跑 Win7 降级分支
  setCapabilityProfileOverride(cli.capabilityProfile)

  logger.info('app', describeCapability(getCapabilityInfo()))

  logger.info(
    'app',
    `用户数据目录: ${app.getPath('userData')}${
      cli.selfTest ? '（自检专用）' : app.isPackaged ? '' : '（开发态，与打包版分开）'
    }`
  )

  const platform = detectPlatform()
  const compat = applyPlatformCompat(platform, {
    softwareRendering: getConfig().legacyGraphics.softwareRendering,
    forceGpu: cli.forceGpu,
    forceSoftware: cli.forceSoftware
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
    if (cli.selfTest) {
      const result = { ok: false, reason: '已有实例在运行，自检无法继续' }
      // eslint-disable-next-line no-console
      console.log('SELFTEST_RESULT ' + JSON.stringify(result))
      writeSelfTestOut(result)
      app.exit(1)
      return
    }
    app.quit()
    return
  }

  app.on('second-instance', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })

  if (cli.selfTest) {
    // 硬看门狗：不论卡在哪一步（窗口创建失败、渲染进程无响应、app.whenReady 未兑现），
    // 都在 120s 内给出结论。否则 CI 会一直挂到 job 超时，拿不到任何有效信息。
    setTimeout(() => {
      const result = { ok: false, reason: '自检硬超时（120s）：应用未能走完启动流程' }
      logger.error('selftest', result.reason)
      // eslint-disable-next-line no-console
      console.log('SELFTEST_RESULT ' + JSON.stringify(result))
      writeSelfTestOut(result)
      app.exit(1)
    }, 120_000)
  }

  app.whenReady()
    .then(() => {
      // 路径根要在任何文件操作之前就位（临时工作区依赖 app.getPath）
      initRoots()
      registerDiagnosticsIpc()
      registerConfigIpc()
      registerPermissionIpc()
      registerWorkspaceIpc()
      registerSessionIpc()
      registerAiIpc()
      registerProfileIpc()
      restoreLastWorkspace()
      buildMenu()
      // 补做上次没做完的归档总结（延迟执行，不抢启动资源）
      scheduleArchiveCatchUp()

      mainWindow = createWindow()
      /*
       * 越界审批的送信通道。
       *
       * 必须在建窗口之后接上：没有窗口时 permissions 层会直接拒绝越界请求
       * （宁可让 AI 报个可读的错，也不能在无人确认时越界）。
       */
      setApprovalSender((req) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send(IPC.evtApprovalRequest, req)
        }
      })
      setLogSink((line) => {
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(IPC.evtLog, line)
      })

      // 文件变化要推给界面。
      // 注意 restoreLastWorkspace() 在 createWindow() 之前就调了，
      // 那会儿 emitter 还没设上 —— 所以这里补一次 watchWorkspace()，
      // 否则「启动就恢复上次工作区」这条路径上监视是断的。
      setFileChangeEmitter((event) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send(IPC.evtFileChanged, event)
        }
      })
      const restoredWorkspace = getConfig().lastWorkspace
      if (restoredWorkspace) watchWorkspace(restoredWorkspace)

      if (cli.selfTest) runSelfTest(mainWindow)

      logger.info('app', '启动完成')
    })
    .catch((err: unknown) => {
      const reason = `启动流程异常: ${err instanceof Error ? err.stack || err.message : String(err)}`
      logger.error('app', reason)
      if (cli.selfTest) {
        // eslint-disable-next-line no-console
        console.log('SELFTEST_RESULT ' + JSON.stringify({ ok: false, reason }))
        writeSelfTestOut({ ok: false, reason })
        app.exit(1)
      }
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

  // 预览用的临时 HTTP 服务必须显式关掉：它只绑回环地址，但进程不退的话
  // 端口会一直挂着，下次预览拿到的就是旧服务（工作区已经换过了）
  app.on('before-quit', (event) => {
    closePreviewServer()
    stopWatching()
    // 后台任务（npm run dev / python -m http.server 之类）不杀的话会变成孤儿进程，
    // 继续占着端口与 CPU，下次启动就变成「端口被占用」这种查不到原因的故障
    killAllJobs()
    /*
     * 用量统计是防抖写盘的（合并 2 秒内的多次记录）。
     * 用户「聊完立刻关窗口」时最后那一次还在防抖窗口里，
     * 不在这里冲一次就会丢掉 —— 表现为统计页上的数字偶尔少一截。
     */
    flushProfile()

    /*
     * 等还在排队的原子写落地，再真的退出。
     *
     * 归档索引与会话正文的写是「排队 + 异步」的：用户点了归档、
     * 或者刚发完一句话就关窗口，写入可能还在队列里。
     * 不等它就跑完 before-quit，那次改动就永远丢了 ——
     * 而用户看到的是「界面上说归档成功了」。
     *
     * 这里**推迟一次退出**（event.preventDefault + 完成后 app.quit()），
     * 而不是同步阻塞：队列里可能有几百毫秒的 I/O，
     * 阻塞主进程会让窗口在那段时间完全没响应。
     * 用一个标记防止 app.quit() 再次触发本回调造成死循环。
     */
    if (!writesDrained) {
      event.preventDefault()
      void drainWrites().finally(() => {
        writesDrained = true
        app.quit()
      })
    }
  })

  process.on('exit', () => {
    logger.info('app', '进程退出')
  })
}

main()
