import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { installDevApiStub } from './dev-api-stub'
import { applyTheme, readTheme } from './theme'
// 只取副作用：这个模块负责 Monaco 的语言注册与 worker 注入。
// 必须在 App 渲染前执行 —— EditorPane 一挂载就会调 monaco.editor.create，
// 那时语言与 worker 都得已经就位。
import './monaco-setup'
// 样式入口。层叠顺序写在 styles/index.css 里，别在这里逐个 import ——
// 顺序是契约，集中在一处才看得见。
import './styles/index.css'

/**
 * 必须放在 render 之前：App 的 useEffect 一跑就会调 window.api。
 * Electron 里 preload 已注入真实 api，这个函数会直接返回 false，什么也不做；
 * 只有「用普通浏览器打开 dev server」时才会真的装上桩。
 */
installDevApiStub()

// 主题要在首次渲染前落到 <html> 上，否则浅色主题会先闪一下深色
applyTheme(readTheme())

const container = document.getElementById('root')
if (!container) throw new Error('未找到 #root 挂载点')

ReactDOM.createRoot(container).render(
  React.createElement(React.StrictMode, null, React.createElement(App))
)

/**
 * 自检入口：主进程 --self-test 时调用。
 * 不是检查“页面有没有返回”，而是检查 React 挂载、对话界面渲染、IPC 通道可用。
 *
 * 关键点：这些事都是异步完成的，而 __SELFTEST__ 是在 did-finish-load 那一刻被调用的，
 * 那时 React 18 并发渲染还没提交、store.init() 还没回来。所以不能瞬时采样，
 * 每一项都要等（waitFor），否则自检会随机失败。
 */
window.__SELFTEST__ = async () => {
  const checks: Record<string, unknown> = {}

  const waitFor = async (predicate: () => boolean, timeoutMs: number): Promise<boolean> => {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (predicate()) return true
      await new Promise((resolve) => setTimeout(resolve, 120))
    }
    return predicate()
  }

  checks.root = Boolean(document.getElementById('root'))

  // App.tsx 在 store.init()（含 IPC 往返）完成后才把 data-app-ready 置为 1
  checks.reactMounted = await waitFor(
    () => Boolean(document.querySelector('[data-app-ready="1"]')),
    20_000
  )
  checks.domNodes = document.querySelectorAll('*').length
  checks.title = document.title

  // 界面真的渲染出来了：顶栏 + 对话输入区
  checks.topbar = Boolean(document.querySelector('.topbar'))
  checks.composer = Boolean(document.querySelector('.composer'))
  checks.theme = document.documentElement.dataset.theme || ''

  // preload 的 contextBridge 注入时机也不保证早于页面脚本；
  // 浏览器预览模式下这个值来自 dev 桩，不能算通过
  checks.apiReady = await waitFor(() => typeof window.api === 'object', 5_000)

  // 验证 IPC 通道真的能通
  try {
    const runtime = await window.api.runtime()
    checks.ipc = true
    checks.osName = runtime.osName
    checks.osTier = runtime.osTier
    checks.softwareRendering = runtime.softwareRendering
    checks.chrome = runtime.chrome
  } catch (err) {
    checks.ipc = false
    checks.ipcError = String(err)
  }

  // 浏览器预览模式下 api / ipc 都来自 dev 桩，是假的，不能当成真实环境通过自检
  checks.devApiStub = Boolean(window.__DEV_API_STUB__)

  /*
   * 工具能力。
   *
   * 它同时决定两件事：AI 拿到的工具表、设置界面显示什么。
   * 算错了不会报错，只会静默地“AI 不会用工具”或“设置页写着空的”，
   * 所以这里必须断言，不能靠肉眼看日志。
   */
  // checks 是 Record<string, unknown>，后续要参与运算的基准值先存在局部变量里
  let baseEffectiveCount = 0
  let baseMode = ''
  try {
    const caps = await window.api.capabilities()
    baseEffectiveCount = caps.effective.length
    baseMode = caps.mode
    checks.capabilityProfile = caps.profile
    checks.capabilityMode = caps.mode
    checks.capabilityOverridden = caps.overridden
    checks.capabilityDetected = caps.detected
    checks.capabilityEffective = caps.effective
    checks.capabilityEffectiveCount = caps.effective.length
    // 被拦下的每一项都要有原因，否则用户看到“少了一个”却不知道为啥
    checks.capabilityFiltered = caps.filtered.map((item) => `${item.name}: ${item.reason}`)
    // 每个生效的工具都要有中文名，否则设置界面会漏出英文标识
    checks.capabilityLabelsComplete = caps.effective.every((name) => Boolean(caps.labels[name]))
    checks.capabilityReasonsComplete = caps.filtered.every((item) => Boolean(item.reason))
    // 生效与未启用应当不重不漏地覆盖全部工具
    checks.capabilityPartitionOk =
      caps.effective.length + caps.filtered.length === Object.keys(caps.labels).length
    /*
     * 命令类工具（执行命令 / 后台任务）这一批的门控结论只靠肉眼看日志是看不出来的：
     * 它们该不该出现完全取决于本机探测，而探测在 CI runner 上永远是「有」。
     * 两条断言：
     *   1. 全部工具都已经实现，不该再有任何一项报「尚未实现」——
     *      真报了说明 IMPLEMENTED_TOOLS 与实作表对不上，工具会静默消失；
     *   2. auto 模式下「探测到的能力」与「真的进了工具表」必须一致，
     *      否则就是门控算错了：要么模型调一个跑不起来的工具，要么白少一批能力。
     */
    checks.capabilityNoUnimplemented = caps.filtered.every((item) => item.reason !== '尚未实现')
    checks.capabilityCommandFollowsDetection =
      caps.mode !== 'auto' || caps.detected.commandExec === caps.effective.includes('runCommand')
    checks.capabilityOk =
      caps.effective.length > 0 &&
      checks.capabilityLabelsComplete &&
      checks.capabilityReasonsComplete &&
      checks.capabilityPartitionOk &&
      checks.capabilityNoUnimplemented &&
      checks.capabilityCommandFollowsDetection &&
      caps.notes.length > 0
  } catch (err) {
    checks.capabilityOk = false
    checks.capabilityError = String(err)
  }

  /*
   * 设置那一层得单独验。
   *
   * --capability-profile 只能验探测，验不了「设置改了到底生不生效」。
   * 而设置这条路有两个容易静默出错的地方：
   *   1. normalize() 是白名单式的 —— 新增的顶层 section 没加进去，
   *      改完存盘、重启就没了，而且不报错；
   *   2. setConfig(patch) 顶层是浅合并 —— 少传一个字段会把整个 section 替掉。
   * 两个坑都不会抛异常，只会“设置页显示成功但 AI 还是用不了工具”，
   * 所以必须真写一次、真读一次。
   *
   * 自检跑在带 -selftest 后缀的独立 userData 里，改配置不会影响正常使用；
   * 但不管成败都要恢复，否则下次自检的起点就变了。
   */
  try {
    const before = await window.api.getConfig()

    // 挑一个确定会生效的保守设置：只放开文件读写，并单独关掉一个
    await window.api.setConfig({
      capability: { mode: 'conservative', disabled: ['readFile'] }
    })
    const changed = await window.api.capabilities()

    // 读回来的配置也要真的变了 —— 这一条同时盖住 normalize() 白名单陷阱
    const persisted = (await window.api.getConfig()).capability
    checks.capabilitySavedMode = persisted.mode
    checks.capabilitySavedDisabled = persisted.disabled
    checks.capabilitySettingsPersisted =
      persisted.mode === 'conservative' && persisted.disabled.includes('readFile')

    checks.capabilityModeApplied = changed.mode === 'conservative'
    checks.capabilityDisabledApplied = !changed.effective.includes('readFile')
    checks.capabilityDisabledReason =
      changed.filtered.find((item) => item.name === 'readFile')?.reason || ''
    // 保守模式本来就不放开命令类工具，所以这里不直接断言 runCommand ——
    // 换个更普适的角度：生效集必须真的变小，否则说明设置没起作用
    checks.capabilityShrank = changed.effective.length < baseEffectiveCount

    // 恢复现场
    await window.api.setConfig({ capability: before.capability })
    const restored = await window.api.capabilities()
    checks.capabilityRestored =
      restored.mode === baseMode && restored.effective.length === baseEffectiveCount

    checks.capabilitySettingsOk =
      checks.capabilitySettingsPersisted &&
      checks.capabilityModeApplied &&
      checks.capabilityDisabledApplied &&
      checks.capabilityShrank &&
      checks.capabilityRestored
  } catch (err) {
    checks.capabilitySettingsOk = false
    checks.capabilitySettingsError = String(err)
  }

  /*
   * 设置页的进出。
   *
   * 设置从弹窗改成了独立页面，而“改成页面”最容易坏的地方不是样式，是导航：
   * 点了没反应、进去了出不来、或者切页时把对话面板卸载掉（聊天记录全丢）。
   * 这三件事人工点一遍也能发现，但等发到学生机上才发现就太晚了。
   */
  try {
    const openBtn = document.querySelector('.topbar [aria-label="设置"]') as HTMLElement | null
    checks.settingsButtonFound = Boolean(openBtn)
    openBtn?.click()

    checks.settingsPageOpened = await waitFor(
      () => Boolean(document.querySelector('.settings-page')),
      5_000
    )
    // 对话面板必须还在 DOM 里（只是被 CSS 藏起来），否则回来聊天记录就没了
    checks.chatPanelKeptMounted = Boolean(document.querySelector('.composer'))

    const backBtn = document.querySelector(
      '.settings-page [aria-label="返回"]'
    ) as HTMLElement | null
    checks.settingsBackButtonFound = Boolean(backBtn)
    backBtn?.click()

    checks.settingsPageClosed = await waitFor(
      () => !document.querySelector('.settings-page'),
      5_000
    )

    checks.settingsNavOk =
      checks.settingsButtonFound &&
      checks.settingsPageOpened &&
      checks.chatPanelKeptMounted &&
      checks.settingsBackButtonFound &&
      checks.settingsPageClosed
  } catch (err) {
    checks.settingsNavOk = false
    checks.settingsNavError = String(err)
  }

  /*
   * 布局骨架：左侧栏（内含文件树）+ 编辑器在左 / 对话在右 + 竖向分割条。
   *
   * 这里必须量实际几何，不能只查元素存在。
   * 改布局时踩过一次：JSX 已改成横向，CSS 里还留着旧的 height 规则，
   * 结果对话栏变成一个又高又窄的怪东西 —— 元素全在，但界面是坏的。
   * 所以下面每条都断言「谁的左边在谁右边」「宽度是不是真的分开了」。
   */
  try {
    const sidebar = document.querySelector('.sidenav') as HTMLElement | null
    const tree = document.querySelector('.filetree') as HTMLElement | null
    const editor = document.querySelector('.editor-dock') as HTMLElement | null
    const view = document.querySelector('.view.is-active') as HTMLElement | null
    const divider = document.querySelector('.splitter') as HTMLElement | null

    checks.sidebarFound = Boolean(sidebar)
    checks.fileTreeFound = Boolean(tree)
    checks.splitterFound = Boolean(divider)
    checks.splitterFocusable = divider?.getAttribute('tabindex') === '0'
    checks.splitterRole = divider?.getAttribute('role') === 'separator'

    /*
     * 关键的布局断言。
     * 全部用「> 一个明显的差值」而不是精确相等：字体、滚动条宽度、
     * 边框像素在不同机器上会有 1~2px 差异，等于精确值会让自检随机失败。
     */
    const sb = sidebar?.getBoundingClientRect()
    const tr = tree?.getBoundingClientRect()
    const ed = editor?.getBoundingClientRect()
    const vw = view?.getBoundingClientRect()
    const dv = divider?.getBoundingClientRect()

    // 文件树必须在侧栏里（并进来了，而不是还在右侧独立成栏）
    checks.treeInsideSidebar = Boolean(sb && tr && tr.left >= sb.left - 1 && tr.right <= sb.right + 1)

    // 编辑器在左、对话在右
    checks.editorLeftOfChat = Boolean(ed && vw && ed.left < vw.left)

    /*
     * 分割条夹在两者之间。
     *
     * 容差给 9px 而不是 2px：分割条用 margin: 0 -4px 把 9px 的可点区
     * 叠到两侧面板上（这样它不占布局宽度，视觉上还是 1px 缝），
     * 所以它真实的 left 会比编辑器的 right 小几像素。
     */
    checks.splitterBetween = Boolean(
      dv && ed && vw && dv.left >= ed.right - 9 && dv.left <= vw.left + 9
    )

    // 竖向分割条：高得多、窄得多。这条正好卡住「光标方向 / 宽高写反」那类 bug
    checks.splitterIsVertical = Boolean(dv && dv.height > dv.width * 3)

    // 两栏都有实际宽度（都 > 120px）。盯着「某一栏被算成 0 宽」这种塌陷
    checks.editorDockHasWidth = Boolean(ed && ed.width > 120)
    checks.chatAreaHasWidth = Boolean(vw && vw.width > 120)

    // 两栏都有满高（不再按 --split 分高度）
    checks.bothFullHeight = Boolean(ed && vw && ed.height > 100 && Math.abs(ed.height - vw.height) < 4)

    checks.layoutOk = Boolean(
      checks.sidebarFound &&
        checks.fileTreeFound &&
        checks.treeInsideSidebar &&
        checks.splitterFound &&
        checks.splitterFocusable &&
        checks.splitterRole &&
        checks.splitterIsVertical &&
        checks.editorLeftOfChat &&
        checks.splitterBetween &&
        checks.editorDockHasWidth &&
        checks.chatAreaHasWidth &&
        checks.bothFullHeight
    )
  } catch (err) {
    checks.layoutOk = false
    checks.layoutError = String(err)
  }

  /*
   * 空态（欢迎页）的几何检查。
   *
   * 只查元素存在是不够的 —— 之前就因为 .stage 忘了改 flex-direction，
   * 三个子块并排挤在一起，元素全在但界面是坏的。
   * 这里量实际布局：三个入口要横排、从左往右（允许换行），
   * 图标必须在上、标题必须在下（否则说明 flex 方向错了）。
   */
  try {
    const badge = document.querySelector('.welcome-badge') as HTMLElement | null
    const title = document.querySelector('.welcome h1') as HTMLElement | null
    const starts = Array.from(document.querySelectorAll('.quick-start')) as HTMLElement[]
    const bar = document.querySelector('.composer-bar') as HTMLElement | null
    const send = document.querySelector('.send-btn') as HTMLElement | null

    checks.welcomeBadgeFound = Boolean(badge)
    checks.welcomeTitleFound = Boolean(title)
    checks.quickStartCount = starts.length

    // 图标在标题上方：说明欢迎页是竖向堆叠的
    checks.welcomeStackedVertical = Boolean(
      badge && title && badge.getBoundingClientRect().bottom <= title.getBoundingClientRect().top
    )

    /*
     * 三个入口要横排、从左往右，但**允许换行**。
     *
     * 早先这里断言「三张卡必须在同一行」，在 CI runner 上误报了：
     * 窗口按 1440x900 创建，而 runner 屏幕只有 1024x768，系统会把窗口夹窄，
     * 对话面板跟着变窄，三张卡就换行了 —— 而 .quick-starts 本来就写着
     * flex-wrap: wrap（注释：「窄屏自动换行」）。断言比设计更严格，是断言错了。
     *
     * 现在改成量「流式排布是否正常」：按 top 分行，第一行至少两张，
     * 同一行内 left 递增，换行后新行更低。flex-direction 写错成 column 时，
     * 第一行只会有一张，仍然会被抓到。
     */
    const rects = starts.map((el) => el.getBoundingClientRect())
    const rows: Array<{ top: number; lefts: number[] }> = []
    for (const r of rects) {
      const row = rows.find((x) => Math.abs(x.top - r.top) < 2)
      if (row) row.lefts.push(r.left)
      else rows.push({ top: r.top, lefts: [r.left] })
    }
    checks.quickStartRows = rows.length
    // 留一份实际几何：以后布局再出问题，报告里直接能看出窄了多少
    checks.quickStartRects = rects.map((r) => ({
      top: Math.round(r.top),
      left: Math.round(r.left),
      w: Math.round(r.width)
    }))
    checks.quickStartsRowLayout = Boolean(
      starts.length >= 3 &&
        rows.length >= 1 &&
        rows[0].lefts.length >= 2 &&
        rows.every((row) => row.lefts.every((l, i) => i === 0 || l > row.lefts[i - 1])) &&
        rows.every((row, i) => i === 0 || row.top > rows[i - 1].top)
    )

    checks.composerBarFound = Boolean(bar)
    checks.sendButtonFound = Boolean(send)

    // 发送键必须在工具条右端 —— 挤到左边说明 spacer 没起作用
    checks.sendButtonAtRightEdge = Boolean(
      bar && send && send.getBoundingClientRect().right > bar.getBoundingClientRect().right - 8
    )

    checks.welcomeOk = Boolean(
      checks.welcomeBadgeFound &&
        checks.welcomeTitleFound &&
        checks.quickStartsRowLayout &&
        checks.composerBarFound &&
        checks.sendButtonFound &&
        checks.sendButtonAtRightEdge
    )
  } catch (err) {
    checks.welcomeOk = false
    checks.welcomeError = String(err)
  }

  /*
   * 本轮新逻辑的断言。
   *
   * 重点验证三件以前缺失、现在必须成立的事：
   *   1. 编辑器标签为空时不给一个假的「欢迎.md」占位
   *   2. 编辑器有真正的空态提示（而不是一片空白）
   *   3. 顶栏模型名读的是真实配置，不是硬编码的字符串
   * 第 3 条的写法：未配置时应该显示「未配置模型」，任何具体模型名都说明又问硬编码了。
   */
  try {
    checks.editorEmptyStateFound = Boolean(document.querySelector('.editor-empty'))
    checks.editorPaneFound = Boolean(document.querySelector('.editor-pane'))
    checks.tabCount = document.querySelectorAll('.tab').length
    // 不该存在任何虚拟欢迎标签
    checks.noWelcomeTab = !Array.from(document.querySelectorAll('.tab-name')).some((el) =>
      (el.textContent || '').includes('欢迎')
    )

    const crumbModel = document.querySelector('.crumb-model')?.textContent?.trim() || ''
    checks.crumbModel = crumbModel
    // 配置里模型为空，所以顶栏必须显示「未配置模型」。
    // 如果显示的是某个具体模型名，说明又写成硬编码了。
    checks.crumbModelFromConfig = crumbModel === '未配置模型'

    checks.newLayoutOk = Boolean(
      checks.editorPaneFound &&
        checks.noWelcomeTab &&
        checks.crumbModelFromConfig
    )
  } catch (err) {
    checks.newLayoutOk = false
    checks.newLayoutError = String(err)
  }

  /*
   * Monaco 语言注册检查。
   *
   * 这条是给「按需引入 Monaco」那次优化兜底的。
   * 那次把 82 种语言减到 16 种来压包体，风险在于：如果 languageFromPath 会产出的
   * 某个 id 忘了在 monaco-setup.ts 里注册，编辑器会**静默退化成纯文本**——
   * 不报错、不白屏，只是没了高亮和括号匹配。这种退化极难在人工点击中发现，
   * 所以必须断言「MAP 里出现的每个语言 id 都真的注册上了」。
   */
  try {
    const mod = await import('./monaco-setup')
    const registered = new Set(mod.default.languages.getLanguages().map((l) => l.id))
    checks.registeredLanguageCount = registered.size

    // language.ts 的 MAP 实际会产出的语言 id（去重）
    const needed = [
      'typescript',
      'javascript',
      'json',
      'html',
      'css',
      'scss',
      'less',
      'markdown',
      'python',
      'java',
      'c',
      'cpp',
      'csharp',
      'go',
      'rust',
      'php',
      'ruby',
      'sql',
      'shell',
      'bat',
      'powershell',
      'xml',
      'yaml'
    ]
    const missing = needed.filter((id) => !registered.has(id))
    checks.missingLanguages = missing
    checks.allNeededLanguagesRegistered = missing.length === 0

    // 不该把全量 82 种语言都塞回来，这条盯住包体优化被回退
    checks.languageCountReasonable = registered.size < 30
  } catch (err) {
    checks.allNeededLanguagesRegistered = false
    checks.monacoError = String(err)
  }

  /*
   * ok 依赖的检查项集中一处，并且把「哪些没过」写进报告。
   *
   * 为什么要多这一步：CI 里只能通过 ::error 注解看到报告（job 日志要仓库
   * admin 权限），而注解只能把「值为 false 的项」列出来。直接列会混进一堆
   * 噪声 —— devApiStub、capabilityOverridden 这些「false 才是正常」的项会被
   * 误报成失败。所以让报告自己给出结论：哪些门没过。
   */
  const gates: Record<string, boolean> = {
    root: Boolean(checks.root),
    reactMounted: Boolean(checks.reactMounted),
    topbar: Boolean(checks.topbar),
    composer: Boolean(checks.composer),
    apiReady: Boolean(checks.apiReady),
    ipc: Boolean(checks.ipc),
    capabilityOk: Boolean(checks.capabilityOk),
    capabilitySettingsOk: Boolean(checks.capabilitySettingsOk),
    settingsNavOk: Boolean(checks.settingsNavOk),
    layoutOk: Boolean(checks.layoutOk),
    welcomeOk: Boolean(checks.welcomeOk),
    newLayoutOk: Boolean(checks.newLayoutOk),
    allNeededLanguagesRegistered: Boolean(checks.allNeededLanguagesRegistered),
    languageCountReasonable: Boolean(checks.languageCountReasonable),
    noDevApiStub: !checks.devApiStub
  }
  checks.gates = gates
  checks.failedGates = Object.keys(gates).filter((key) => !gates[key])

  const ok = Object.values(gates).every(Boolean)
  return { ok, checks }
}
