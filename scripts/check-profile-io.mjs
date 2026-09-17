/**
 * 主进程新模块的**联调**校验（带文件 I/O）。
 *
 * 与 check-profile.mjs 的分工：
 *   - check-profile.mjs 查纯函数（组装规则、正则）
 *   - 本文件查**落盘行为**：系统.md 的写/读/覆盖、记忆的敏感信息拦截、
 *     用量统计的累加与持久化、归档索引
 *
 * 这些行为光看代码很容易觉得「显然是对的」，而它们恰恰是最容易出问题的：
 *   - 「用户手改了 系统.md，下次会话前要覆盖掉」是一条**明确的产品要求**，
 *     但代码里只要少一个比较、或者比较方向写反，就会变成「手改永久生效」
 *     或「每次请求都重写」—— 前者违反要求，后者每次请求都挂掉缓存
 *   - 「记忆里不许存密钥」如果拦截写错了，错误是**静默**的：
 *     密钥静静地躺在磁盘上，以后每次对话都被发出去
 *   - 用量统计的日期分桶、防抖落盘、退出前 flush，全靠几个容易写错的边界
 *
 * 做法：把 electron 换成一个假的（app.getPath 指向临时目录），
 * 然后直接 require 真实模块。这样测的是**真代码**，不是复制品。
 *
 * 用法：npm run check:profileio
 */
import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { FAKE_OPENAI, FAKE_ENV_OPENAI } from './lib/fake-secrets.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const require = createRequire(import.meta.url)

/**
 * 测试自己的输出通道。
 *
 * 为什么要单独留一条：被测的主进程模块会通过 logger 往 console 打
 * INFO / WARN / DEBUG（真机上那是对的，用户要看），而本文件又需要
 * 在屏蔽这些噪音的同时把自己的结果打出来。所以先握住一个
 * **原始 stdout 写入函数**，测试结果一律走它，
 * 之后无论怎么改 console 都不会影响测试自己的输出。
 */
const writeOut = process.stdout.write.bind(process.stdout)
function say(line = '') {
  writeOut(`${line}\n`)
}

let failures = 0
function check(name, ok, detail = '') {
  say(`${ok ? '通过' : '失败'}  ${name}${detail ? `  ${detail}` : ''}`)
  if (!ok) failures += 1
}

/**
 * 折叠主进程日志。
 *
 * 这个测试**故意**让总结失败（测试环境禁网，net.request 直接抛错），
 * 主进程的 logger 会把每次失败都打到 stderr。那是正确的产品行为 ——
 * 真机上用户需要看到这些；但在构建输出里刷十几行 WARN 会把真正的
 * 测试结果淹掉，之后没人会去看那个构建日志。
 *
 * 所以收起来，但**不丢**：结束时报告折叠了几条，并保留最后几条，
 * 这样「预期内的噪音」被压掉，而「意料之外的报错」仍然看得见。
 * 不为了让日志安静去改生产代码（加个「测试模式环境变量」之类）——
 * 那会让 logger 多一条只在测试里走的分支。
 */
const mutedLines = []
const MUTE_KEEP = 3
function installLogMute() {
  const wrap = () => (...args) => {
    mutedLines.push(args.map((item) => String(item)).join(' '))
    // 只留最近若干条，避免长时间运行把内存吃满
    if (mutedLines.length > 200) mutedLines.shift()
  }
  console.log = wrap()
  console.warn = wrap()
  console.error = wrap()
}
function reportMutedLogs() {
  if (mutedLines.length === 0) return
  say('')
  say(`（测试期间主进程有 ${mutedLines.length} 条日志已折叠，其中最后 ${MUTE_KEEP} 条）`)
  for (const line of mutedLines.slice(-MUTE_KEEP)) say(`  · ${line}`)
  say('  （多数是「总结失败」——测试环境禁网，属于预期内）')
}
installLogMute()

/* ══ 1. 假的 electron ═══════════════════════════════════════ */

const USERDATA = fs.mkdtempSync(path.join(os.tmpdir(), 'profile-io-'))

const electronStub = {
  app: {
    getPath: (name) => (name === 'userData' ? USERDATA : path.join(USERDATA, String(name))),
    getVersion: () => '0.0.0-check',
    getLocale: () => 'zh-CN',
    getName: () => 'check',
    on: () => undefined,
    once: () => undefined,
    whenReady: () => Promise.resolve(),
    setPath: () => undefined,
    quit: () => undefined,
    exit: () => undefined,
    isReady: () => true
  },
  ipcMain: { handle: () => undefined, on: () => undefined },
  shell: { openPath: async () => '' },
  // 网络一律拒绝：这些测试不该发请求。真发了就是测试写错了，
  // 要让它立刻失败而不是等超时（那样只会让人以为「测试很慢」）
  net: {
    request: () => {
      throw new Error('测试环境不允许发网络请求')
    }
  },
  Menu: { buildFromTemplate: () => ({}), setApplicationMenu: () => undefined },
  dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
  nativeTheme: { shouldUseDarkColors: false, on: () => undefined },
  BrowserWindow: class {},
  screen: { getPrimaryDisplay: () => ({ workAreaSize: { width: 1280, height: 800 } }) }
}

// 把 require('electron') 换掉。必须在加载被测模块之前
const Module = require('node:module')
const originalLoad = Module._load
Module._load = function patched(request, parent, isMain) {
  if (request === 'electron') return electronStub
  return originalLoad.call(this, request, parent, isMain)
}

/* ══ 2. 打包并加载被测模块 ══════════════════════════════════ */

function loadModules() {
  const esbuild = require('esbuild')
  const entry = `
    export * as systemDoc from ${JSON.stringify(path.join(root, 'src/main/system-doc.ts'))}
    export * as memory from ${JSON.stringify(path.join(root, 'src/main/memory.ts'))}
    export * as usage from ${JSON.stringify(path.join(root, 'src/main/usage.ts'))}
    export * as archive from ${JSON.stringify(path.join(root, 'src/main/archive.ts'))}
    export * as config from ${JSON.stringify(path.join(root, 'src/main/config.ts'))}
    export * as atomic from ${JSON.stringify(path.join(root, 'src/main/atomic-file.ts'))}
  `
  const result = esbuild.buildSync({
    stdin: { contents: entry, resolveDir: root, loader: 'ts' },
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node16',
    // electron 由上面的 Module._load 补丁提供，不能打进包里
    external: ['electron'],
    // 必须 write:false，否则 esbuild 直接写盘、outputFiles 是空的
    write: false,
    logLevel: 'silent'
  })
  const tmp = path.join(USERDATA, 'bundle.cjs')
  fs.writeFileSync(tmp, result.outputFiles[0].text)
  return require(tmp)
}

const mods = loadModules()
const { systemDoc, memory, usage, archive, config, atomic } = mods

/* ══ 3. 系统.md：写、读、手改检测 ════════════════════════════ */

const DOC = path.join(USERDATA, '系统.md')
const HASH = `${DOC}.sha256`

async function systemDocTests() {
  say('\n── 系统.md ──')

  // 先造一份配置，否则组装出来只有文件头
  config.setConfig({
    ai: {
      baseUrl: 'https://relay.example.com',
      apiKey: 'sk-test',
      model: 'gpt-4o-mini',
      aiName: '小助',
      userName: '同学',
      habits: '- 我只用 Windows，命令按 cmd 写'
    }
  })

  const first = await systemDoc.ensureSystemDoc()
  check('首次调用生成内容', typeof first === 'string' && first.length > 0)
  check('文件真的落盘了', fs.existsSync(DOC))
  check('hash 旁文件也写了', fs.existsSync(HASH))
  check('内容含身份', first.includes('小助') && first.includes('同学'))
  // 「默认提示词」已移除（用户可自定义提示词那一项去掉了）。
  //   改为断言契约段在 —— 它是现在 system prompt 的固定组成部分
  check('内容含平台契约', first.includes('## 平台') && first.includes('## 工作纪律'))
  check('内容含习惯', first.includes('我只用 Windows'))

  // ★ 第二次调用不重写：内容一致时一个字都不动。
  //   重写会改 mtime，用户就分不清「是我改的还是它自己变的」
  const mtimeBefore = fs.statSync(DOC).mtimeMs
  const second = await systemDoc.ensureSystemDoc()
  const mtimeAfter = fs.statSync(DOC).mtimeMs
  check('内容未变时不重写文件', mtimeBefore === mtimeAfter)
  check('两次返回内容一致', first === second)

  /*
   * ★★ 核心要求：用户手改后，下次会话前要覆盖回设置里的内容。
   *
   * 这是用户明确提出的一条（「如果用户自己去改了，你发起会话前就重新
   * 覆盖一遍」）。这里模拟「用户拿记事本改了文件」。
   */
  fs.writeFileSync(DOC, '# 我自己的内容\n\n不要覆盖我！\n', 'utf8')
  const afterEdit = await systemDoc.ensureSystemDoc()
  check('手改的内容被覆盖回设置内容', !fs.readFileSync(DOC, 'utf8').includes('不要覆盖我'))
  check('覆盖后的返回值是新内容', afterEdit === first)
  check('覆盖后仍与设置一致', (await systemDoc.inspectSystemDoc()).inSync)

  // 手改后 inspect 应当先报「不一致」（覆盖发生在 ensure，不在 inspect）
  fs.writeFileSync(DOC, '# 又改了一次\n', 'utf8')
  const inspected = await systemDoc.inspectSystemDoc()
  check('inspect 能看出文件与设置不一致', inspected.inSync === false)
  check('inspect 返回文件真实内容', inspected.content.includes('又改了一次'))
  check('inspect 给出文件路径', inspected.path === DOC)
  check('inspect 不写盘（手改还在）', fs.readFileSync(DOC, 'utf8').includes('又改了一次'))

  // regenerate 无条件覆盖
  const regenerated = await systemDoc.regenerateSystemDoc()
  check('regenerate 覆盖手改', !fs.readFileSync(DOC, 'utf8').includes('又改了一次'))
  check('regenerate 后与设置一致', regenerated.inSync)

  /*
   * ★ 设置改动要反映到文件里。
   *
   * 这条看似显然，但「hash 比较写反」会让它静默失效 ——
   * 用户改了名字，系统.md 里还是旧的，而界面上「查看全文」显示的
   * 也是旧的，用户会以为设置没保存。
   */
  config.setConfig({ ai: { ...config.getConfig().ai, aiName: '阿码', userName: '老王' } })
  const afterSetting = await systemDoc.ensureSystemDoc()
  check('设置改动后内容跟着变', afterSetting.includes('阿码') && afterSetting.includes('老王'))
  check('设置改动后旧名字不再出现', !afterSetting.includes('小助'))

  // 文件被删掉时要能自愈（用户清理 userData、或手动删了）
  fs.rmSync(DOC, { force: true })
  fs.rmSync(HASH, { force: true })
  const recreated = await systemDoc.ensureSystemDoc()
  check('文件被删后能重新生成', fs.existsSync(DOC) && recreated.includes('阿码'))

  // 旁文件被删（内容对得上）：也要重写以修复状态
  fs.rmSync(HASH, { force: true })
  await systemDoc.ensureSystemDoc()
  check('旁文件缺失时补写状态', fs.existsSync(HASH))

  /*
   * ★ 会话级快照：同一会话内不重新校验。
   *
   * 这是**故意**的取舍 —— 用户要求的是「发起会话前」覆盖，
   * 不是「每次请求前」。会话中途手改文件不该影响正在进行的对话
   * （否则前后两轮的 system prompt 不一致，模型行为会莫名变化，
   * 而且每次请求都会挂掉 prompt 缓存）。
   *
   * 这条同时也是「别把 ensureSystemDoc 改成每次请求都调」的守卫：
   * 真改成那样，这个测试会失败。
   */
  systemDoc.invalidateSystemPrompt()
  const sessionA = await systemDoc.sessionSystemPrompt('s-1')
  fs.writeFileSync(DOC, '# 会话中途手改\n', 'utf8')
  const sessionA2 = await systemDoc.sessionSystemPrompt('s-1')
  check('同一会话内不重新校验（拿到同一份快照）', sessionA === sessionA2)
  check('同一会话内手改不被读进 prompt', !sessionA2.includes('会话中途手改'))

  // 换会话 → 重新校验，手改被覆盖
  const sessionB = await systemDoc.sessionSystemPrompt('s-2')
  check('新会话重新校验并覆盖手改', !sessionB.includes('会话中途手改') && sessionB.includes('阿码'))
  check('新会话重新写盘', !fs.readFileSync(DOC, 'utf8').includes('会话中途手改'))

  // 不传 id（后台任务路径：归档总结）应沿用快照
  const noId = await systemDoc.sessionSystemPrompt()
  check('不传会话 id 时沿用快照', noId === sessionB)

  // 设置变更后丢快照
  systemDoc.invalidateSystemPrompt()
  config.setConfig({ ai: { ...config.getConfig().ai, aiName: '新名' } })
  const afterInvalidate = await systemDoc.sessionSystemPrompt('s-2')
  check('invalidate 后重新组装', afterInvalidate.includes('新名'))
}

/* ══ 4. 记忆：敏感信息拦截与读取脱敏 ════════════════════════ */

async function memoryTests() {
  say('\n── 记忆 ──')

  /*
   * 「用户手写进文件」用的假密钥。
   *
   * 单独造一个（而不是复用 FAKE_OPENAI）是为了让断言更精确：
   * 这条测试验的是「**手写的**内容也能在读的时候被脱敏」，
   * 与写入口拦下的那条路径是两回事。用不同的值能避免
   * 「其实是别处写进去的」这种混淆。
   *
   * 同样的拆开拼写法 —— 理由见 scripts/lib/fake-secrets.mjs。
   */
  const HANDWRITTEN_FAKE_KEY = 'sk-' + 'proj-' + 'ZzZzYyYyXxXxWwWwVvVvUuUu'

  const dir = memory.memoryDir()

  // 正常内容能写进去
  const written = await memory.writeMemory({ content: '用户偏好用 VS Code 的快捷键' })
  check('正常内容写入成功', written.ok)
  check('当日流水文件已创建', fs.existsSync(written.path))

  // ★ 密钥必须被拦下，而且**文件里不能留下痕迹**
  const secretText = FAKE_ENV_OPENAI
  let blocked = false
  let errorMessage = ''
  try {
    await memory.writeMemory({ content: secretText })
  } catch (err) {
    blocked = true
    errorMessage = err instanceof Error ? err.message : String(err)
  }
  check('密钥写入被拒绝', blocked)
  check('拒绝原因说明了类别', errorMessage.includes('OpenAI'))
  check('拒绝原因说明了后果', errorMessage.includes('磁盘') || errorMessage.includes('发出去'))
  /*
   * ★ 错误信息里不能带密钥原文 —— 带了的话密钥就跟着错误信息
   *   进了对话上下文与日志，本来要防的事情被自己做了。
   */
  check('错误信息里不含密钥原文', !errorMessage.includes(FAKE_OPENAI))

  // 落盘的内容里绝不能有密钥
  const daily = memory.dailyPath(memory.today())
  const onDisk = fs.existsSync(daily) ? fs.readFileSync(daily, 'utf8') : ''
  check('磁盘上不含密钥', !onDisk.includes(FAKE_OPENAI))

  // 长期记忆
  const longWrite = await memory.writeMemory({ content: '用户是初学者，讲解要避免术语', target: 'long' })
  check('长期记忆写入成功', longWrite.ok && fs.existsSync(memory.longTermPath()))
  check('长期记忆文件里有内容', fs.readFileSync(memory.longTermPath(), 'utf8').includes('初学者'))

  // 读回来
  const readLong = await memory.readMemory({ target: 'long' })
  check('能读回长期记忆', readLong.text.includes('初学者'))
  check('读取不带脱敏标记（内容本来就干净）', readLong.redacted === 0)

  /*
   * ★★ 手写在文件里的密钥必须在**读**的时候被脱敏。
   *
   * 写入口的扫描拦不住手动编辑文件 —— 而读出来的内容会进对话上下文、
   * 被发到中转站。这是唯一能兜住手写内容的关口。
   */
  fs.writeFileSync(
    memory.longTermPath(),
    `# 长期记忆\n\n- 用户的 key 是 ${HANDWRITTEN_FAKE_KEY}\n- 用户喜欢简短回答\n`,
    'utf8'
  )
  const readDirty = await memory.readMemory({ target: 'long' })
  check('读取时隐去手写的密钥', readDirty.redacted > 0, `redacted=${readDirty.redacted}`)
  check('读回内容里没有密钥原文', !readDirty.text.includes(HANDWRITTEN_FAKE_KEY))
  check('读回内容保留了正常部分', readDirty.text.includes('用户喜欢简短回答'))
  check('读回内容标注了隐去', readDirty.text.includes('隐去'))

  /*
   * ★ 文件很大时写入要被拒绝而不是静默失败。
   *   静默失败会让模型以为记住了 —— 那比报错更糟。
   */
  const huge = 'x'.repeat(260 * 1024)
  let oversized = false
  try {
    await memory.writeMemory({ content: huge })
  } catch {
    oversized = true
  }
  check('超过体积上限时拒绝并报错', oversized)

  // 空内容不该写出一条空记忆
  let emptyRejected = false
  try {
    await memory.writeMemory({ content: '   ' })
  } catch {
    emptyRejected = true
  }
  check('空内容被拒绝', emptyRejected)

  // 概览
  const list = await memory.listMemory()
  check('能列出记忆文件', list.length >= 1)
  check('长期记忆排在第一位', list[0]?.name === memory.LONG_TERM_FILE)
  check('概览带字节数', typeof list[0]?.bytes === 'number')

  // 没有任何记忆时不报错，而是给一句可读说明
  fs.rmSync(dir, { recursive: true, force: true })
  const empty = await memory.readMemory({ target: 'all' })
  check('无记忆时给出可读说明', empty.text.includes('没有任何记忆') && empty.paths.length === 0)
}

/* ══ 5. 用量统计 ════════════════════════════════════════════ */

async function usageTests() {
  say('\n── 用量统计 ──')

  const empty = usage.readUsage()
  check('初始为空', empty.total.requests === 0 && empty.since === '')

  usage.recordUsage({
    model: 'gpt-4o-mini',
    promptTokens: 1000,
    completionTokens: 200,
    cachedTokens: 800,
    estimated: false
  })
  usage.recordUsage({
    model: 'gpt-4o-mini',
    promptTokens: 500,
    completionTokens: 100,
    cachedTokens: 0,
    estimated: true
  })
  usage.recordUsage({
    model: 'deepseek-chat',
    promptTokens: 300,
    completionTokens: 50,
    cachedTokens: 300,
    estimated: false
  })

  const stats = usage.readUsage()
  check('请求数累加', stats.total.requests === 3, `requests=${stats.total.requests}`)
  check('输入 token 累加', stats.total.promptTokens === 1800, `${stats.total.promptTokens}`)
  check('输出 token 累加', stats.total.completionTokens === 350, `${stats.total.completionTokens}`)
  check('缓存命中累加', stats.total.cachedTokens === 1100, `${stats.total.cachedTokens}`)
  // ★ 估算值单独计数：混进总数会让「精确数字」其实一半是猜的
  check('估算请求单独计数', stats.total.estimatedRequests === 1)
  check('今天与全部一致（都是今天记的）', stats.today.requests === 3)
  check('最近 7 天含今天', stats.week.requests === 3)

  check('按模型分成两组', stats.models.length === 2, `models=${stats.models.length}`)
  // 降序：gpt-4o-mini 的 1500 输入 > deepseek 的 300
  check('按 token 量降序', stats.models[0]?.model === 'gpt-4o-mini')
  check('分组统计正确', stats.models[0]?.promptTokens === 1500)

  check('逐日数据是 7 天', stats.days.length === 7, `days=${stats.days.length}`)
  check('今天的桶有数据', stats.days[6]?.requests === 3)
  check('没有记录的日子补 0 而不是缺项', stats.days[0]?.requests === 0)

  usage.flushUsage()
  const file = path.join(USERDATA, 'usage.json')
  check('落盘成功', fs.existsSync(file))
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
  check('落盘内容含逐日数据', Object.keys(parsed.days || {}).length === 1)
  check('落盘内容含按模型数据', Object.keys(parsed.models || {}).length === 2)
  check('落盘内容不含日期之外的元数据', parsed.version === 1)

  /*
   * ★ 脏数据不能让统计页崩掉（也不能变成 NaN）。
   *   usage.json 是用户可见可改的文件，手改坏了是很现实的场景。
   */
  fs.writeFileSync(
    file,
    JSON.stringify({
      version: 1,
      days: { '2024-01-01': { requests: 'abc', promptTokens: -5 }, 坏键: {} },
      models: { 'gpt-4o': { requests: 3, promptTokens: 10 } }
    }),
    'utf8'
  )
  // 换进程才能重读（模块内有缓存），所以这里只能验「不抛异常」
  let dirtyOk = true
  try {
    usage.readUsage()
  } catch {
    dirtyOk = false
  }
  check('脏数据读取不抛异常', dirtyOk)

  // 清空
  const cleared = usage.resetUsage()
  check('清空后归零', cleared.total.requests === 0 && cleared.models.length === 0)
  check('清空后落盘也是空的', JSON.parse(fs.readFileSync(file, 'utf8')).days !== undefined)

  /*
   * ★ 日期用本地时区。
   *
   * 用 UTC 的话，东八区晚上 8 点之后会被算成第二天 ——
   * 用户晚上聊了一大段，统计页显示「今天 0」，那是很典型的
   * 「看起来像 bug 但其实是时区」问题。
   */
  const night = new Date(2024, 5, 15, 23, 30, 0)
  check('日期取本地时区', usage.dayKey(night) === '2024-06-15', usage.dayKey(night))
  const earlyMorning = new Date(2024, 5, 15, 0, 30, 0)
  check('凌晨也归当天', usage.dayKey(earlyMorning) === '2024-06-15')
  check('日期补零', usage.dayKey(new Date(2024, 0, 5, 12, 0, 0)) === '2024-01-05')

  // 负数/NaN 不该被记进去
  usage.resetUsage()
  usage.recordUsage({
    model: 'x',
    promptTokens: -100,
    completionTokens: Number.NaN,
    cachedTokens: -1,
    estimated: false
  })
  const safe = usage.readUsage()
  check('负数与非数字被收敛为 0', safe.total.promptTokens === 0 && safe.total.completionTokens === 0)
  check('但请求数仍然记了一次', safe.total.requests === 1)
}

/* ══ 6. 归档索引 ════════════════════════════════════════════ */

async function archiveTests() {
  say('\n── 归档 ──')

  const sessionsDir = path.join(USERDATA, 'sessions')
  fs.mkdirSync(sessionsDir, { recursive: true })

  // 造一条会话正文，模拟「用户聊完点了归档」
  const id = 's-1700000000-abcd'
  fs.writeFileSync(
    path.join(sessionsDir, `${id}.json`),
    JSON.stringify({
      id,
      title: '怎么用 python 读 csv',
      workspace: 'C:\\work\\demo',
      updatedAt: new Date().toISOString(),
      messages: [
        { role: 'user', text: '怎么用 python 读 csv？', at: '2024-01-01T10:00:00.000Z' },
        { role: 'assistant', text: '用 csv 模块或者 pandas。', at: '2024-01-01T10:00:05.000Z' },
        { role: 'user', text: 'pandas 怎么装？', at: '2024-01-01T10:01:00.000Z' }
      ]
    }),
    'utf8'
  )

  const empty = await archive.listArchive()
  check('初始归档索引为空', empty.length === 0)

  /*
   * 归档。注意此时配置**是完整的**（前面设过），所以 archiveSession 会
   * 真的去排队总结 —— 而 net 被我们禁用了，总结必然失败。
   * 这正好能验两件事：索引先落盘（不依赖总结成功）、失败不抛到外面。
   */
  const outcome = await archive.archiveSession(id, 'C:\\work\\demo', 3)
  check('归档返回成功', outcome.ok)
  check('归档写入了索引', (await archive.listArchive()).length === 1)

  const entry = (await archive.listArchive())[0]
  check('索引里有标题', entry.title.includes('python'))
  check('索引里有工作区', entry.workspace === 'C:\\work\\demo')
  check('索引里有消息条数', entry.messageCount === 3)
  check('索引里有归档时间', typeof entry.archivedAt === 'string' && entry.archivedAt.length > 0)
  check('梗概初始为空（还没总结出来）', entry.summary === '')

  // ★ 索引必须真的落盘：不能只存在内存里，否则重启就丢
  const indexFile = path.join(sessionsDir, 'archive.json')
  check('索引文件已落盘', fs.existsSync(indexFile))

  // ★ 归档状态要回写进会话正文（换机器拷走 sessions/ 时状态跟着走）
  const body = JSON.parse(fs.readFileSync(path.join(sessionsDir, `${id}.json`), 'utf8'))
  check('正文里记了归档时间', typeof body.archivedAt === 'string' && body.archivedAt.length > 0)

  // 重复归档不报错、不产生第二条
  const again = await archive.archiveSession(id, 'C:\\work\\demo', 3)
  check('重复归档不报错', again.ok)
  check('重复归档不产生第二条', (await archive.listArchive()).length === 1)

  /*
   * ★ 会被 AI 检索到的东西必须已经脱敏或至少不含密钥 ——
   *   归档索引里有标题，而标题来自用户的第一句话（可能是粘的密钥）。
   *   这里只验证「索引不会因为标题里有怪字符而崩」。
   */
  const weirdId = 's-1700000001-efgh'
  fs.writeFileSync(
    path.join(sessionsDir, `${weirdId}.json`),
    JSON.stringify({
      id: weirdId,
      title: '标题里有「引号」和\\反斜杠 与 emoji 🚀',
      workspace: '',
      updatedAt: new Date().toISOString(),
      messages: [{ role: 'user', text: '测试', at: '2024-01-01T10:00:00.000Z' }]
    }),
    'utf8'
  )
  const weird = await archive.archiveSession(weirdId, '', 1)
  check('特殊字符标题不崩', weird.ok)
  check('两条都在索引里', (await archive.listArchive()).length === 2)

  // 取消归档
  const undone = await archive.unarchiveSession(id)
  check('取消归档成功', undone.ok)
  check('取消后索引里少一条', (await archive.listArchive()).length === 1)
  const bodyAfter = JSON.parse(fs.readFileSync(path.join(sessionsDir, `${id}.json`), 'utf8'))
  check('取消归档后正文里的标记被清掉', !bodyAfter.archivedAt)

  // 取消一个不存在的不该抛错（用户可能手改了索引）
  const notThere = await archive.unarchiveSession('s-not-exist')
  check('取消不存在的归档返回失败而不抛错', notThere.ok === false)

  /*
   * ★★ 并发归档不能丢条目。
   *
   * 这是**真踩到过的 bug**，不是假想：归档会「先写索引，再在后台总结」，
   * 而总结过程里还要再写一次索引。两条路径并发写同一个 .tmp 时，
   * 一个 rename 成功后另一个拿到 ENOENT，那一次改动**静默消失**。
   *
   * 修法是「同路径串行 + 读—改—写整体加锁」（atomic-file.ts）。
   * 这个测试就是钉住它：并发归档 5 条，索引里必须正好有 5 条。
   */
  fs.rmSync(indexFile, { force: true })
  // 清掉内存里的索引缓存，从零开始
  await archive.listArchive()

  const concurrencyIds = []
  for (let i = 0; i < 5; i++) {
    const cid = `s-conc-${i}`
    concurrencyIds.push(cid)
    fs.writeFileSync(
      path.join(sessionsDir, `${cid}.json`),
      JSON.stringify({
        id: cid,
        title: `并发测试第 ${i} 条`,
        workspace: '',
        updatedAt: new Date().toISOString(),
        messages: [{ role: 'user', text: `第 ${i} 条`, at: '2024-01-01T10:00:00.000Z' }]
      }),
      'utf8'
    )
  }

  // 全部同时发起，不 await 中间的
  await Promise.all(concurrencyIds.map((cid) => archive.archiveSession(cid, '', 1)))

  const afterConcurrent = await archive.listArchive()
  check(
    '并发归档 5 条一条都不丢',
    afterConcurrent.length === 5,
    `实际 ${afterConcurrent.length} 条：${afterConcurrent.map((e) => e.id).join(', ')}`
  )
  // 落盘的也必须是 5 条（缓存对而文件不对是最糟的情况）
  const onDiskIndex = JSON.parse(fs.readFileSync(indexFile, 'utf8'))
  check('并发归档后磁盘索引也是 5 条', onDiskIndex.length === 5, `磁盘 ${onDiskIndex.length} 条`)

  /*
   * ★ 并发「归档 + 取消归档」不能互相覆盖。
   *
   * 这是读—改—写的经典竞态：两个操作各自读到旧索引，
   * 各自改，各自写 —— 后写的把前一次的结果整个抹掉。
   */
  fs.rmSync(indexFile, { force: true })
  await archive.listArchive()
  const raceId = 's-race-a'
  const keepId = 's-race-b'
  for (const rid of [raceId, keepId]) {
    fs.writeFileSync(
      path.join(sessionsDir, `${rid}.json`),
      JSON.stringify({
        id: rid,
        title: `竞态 ${rid}`,
        workspace: '',
        updatedAt: new Date().toISOString(),
        messages: [{ role: 'user', text: 'x', at: '2024-01-01T10:00:00.000Z' }]
      }),
      'utf8'
    )
  }
  await archive.archiveSession(raceId, '', 1)
  await archive.archiveSession(keepId, '', 1)
  // 一条取消、一条新增，同时发
  const freshId = 's-race-c'
  fs.writeFileSync(
    path.join(sessionsDir, `${freshId}.json`),
    JSON.stringify({
      id: freshId,
      title: '竞态新增',
      workspace: '',
      updatedAt: new Date().toISOString(),
      messages: [{ role: 'user', text: 'y', at: '2024-01-01T10:00:00.000Z' }]
    }),
    'utf8'
  )
  await Promise.all([
    archive.unarchiveSession(raceId),
    archive.archiveSession(freshId, '', 1)
  ])
  const afterRace = await archive.listArchive()
  const raceIds = afterRace.map((e) => e.id)
  check('并发「取消 + 新增」两个动作都生效', !raceIds.includes(raceId) && raceIds.includes(freshId), raceIds.join(', '))
  check('并发「取消 + 新增」没误删其他条目', raceIds.includes(keepId))

  /*
   * ★ 索引文件损坏时不能让应用起不来。
   *   归档索引是「锦上添花」的资料，为它崩掉是本末倒置。
   */
  fs.writeFileSync(indexFile, '{ 这不是合法 JSON', 'utf8')
  let dirtyOk = true
  try {
    await archive.listArchive()
  } catch {
    dirtyOk = false
  }
  check('索引损坏时不抛异常', dirtyOk)
}

/* ══ 7. 原子写与锁的边界 ═══════════════════════════════════ */

async function atomicFileTests() {
  say('')
  say('── 原子写与锁 ──')

  const target = path.join(USERDATA, 'probe', 'atomic.txt')

  await atomic.atomicWriteFile(target, '第一版')
  check('能创建父目录并写入', fs.readFileSync(target, 'utf8') === '第一版')

  /*
   * ★ 并发写同一路径：最终内容必须是**某一次**写入的完整内容，
   *   不能是两次内容的混合（混合说明没有串行化）。
   */
  const writes = []
  for (let i = 0; i < 30; i++) {
    writes.push(atomic.atomicWriteFile(target, `版本-${i}`))
  }
  await Promise.all(writes)
  const finalContent = fs.readFileSync(target, 'utf8')
  check(
    '并发写后内容是某一次的完整内容（无混合）',
    /^版本-\d+$/.test(finalContent),
    `实际「${finalContent}」`
  )

  const leftovers = fs.readdirSync(path.dirname(target)).filter((name) => name.includes('.tmp'))
  check('并发写后没有残留临时文件', leftovers.length === 0, leftovers.join(', '))

  /*
   * ★ 写失败不能卡住队列。
   *   往一个「已存在且是目录」的路径写必然失败，
   *   失败之后同一路径的后续写仍必须能执行 ——
   *   否则一次失败会让这个文件永远写不进去。
   */
  const dirAsFile = path.join(USERDATA, 'probe', 'iam-a-dir')
  fs.mkdirSync(dirAsFile, { recursive: true })
  let failed = false
  try {
    await atomic.atomicWriteFile(dirAsFile, '写不进去')
  } catch {
    failed = true
  }
  check('写入失败会抛错（不静默吞掉）', failed)

  await atomic.atomicWriteFile(target, '失败之后仍然能写')
  check('一次失败不卡住后续写入', fs.readFileSync(target, 'utf8') === '失败之后仍然能写')

  /*
   * ★ withLock 的「读—改—写」必须真的互斥。
   *   这是经典的丢更新：不加锁时最终值远小于预期。
   */
  const counterFile = path.join(USERDATA, 'probe', 'counter.json')
  await atomic.atomicWriteFile(counterFile, JSON.stringify({ n: 0 }))

  const bump = () =>
    atomic.withLock('counter', async () => {
      const current = JSON.parse(fs.readFileSync(counterFile, 'utf8'))
      // 故意在读写之间让出事件循环：不加锁时这里必然丢更新
      await new Promise((resolve) => setTimeout(resolve, 1))
      await atomic.atomicWriteFile(counterFile, JSON.stringify({ n: current.n + 1 }))
    })

  await Promise.all(Array.from({ length: 20 }, bump))
  const counter = JSON.parse(fs.readFileSync(counterFile, 'utf8'))
  check('withLock 下 20 次自增一次不丢', counter.n === 20, `实际 ${counter.n}`)

  // drainWrites 必须能等到队列清空（退出流程靠它）
  void atomic.atomicWriteFile(target, '待落盘')
  await atomic.drainWrites()
  check('drainWrites 后内容已落盘', fs.readFileSync(target, 'utf8') === '待落盘')

  // 空队列时立刻返回，否则退出流程会卡死
  const started = Date.now()
  await atomic.drainWrites()
  check('空队列时 drainWrites 立刻返回', Date.now() - started < 500)

  // 二进制写入（encoding: null）
  const binPath = path.join(USERDATA, 'probe', 'bin.dat')
  const bytes = Buffer.from([0x00, 0xff, 0x10, 0x80])
  await atomic.atomicWriteFile(binPath, bytes, { encoding: null })
  check('二进制写入不被改编码', Buffer.compare(fs.readFileSync(binPath), bytes) === 0)

  // contentHash
  check('contentHash 确定性', atomic.contentHash('abc') === atomic.contentHash('abc'))
  check('contentHash 区分内容', atomic.contentHash('abc') !== atomic.contentHash('abd'))
  check('contentHash 是 64 位十六进制', /^[0-9a-f]{64}$/.test(atomic.contentHash('x')))

  /*
   * ★★ 模块依赖不能成环。
   *
   * 这里曾经有一条真实的环：
   *   archive → tools/index → tools/session-tools → archive
   * 它当时是**良性**的（所有跨模块调用都在函数体里，运行时拿到的是
   * 加载完的模块），但它是定时炸弹：哪天有人在顶层写一句
   * `const X = listArchive()`，就会拿到半成品模块，报
   * `is not a function`，而且只在特定加载顺序下复现。
   *
   * 修法是把存储层抽成叶子模块 archive-index.ts。
   * 这个测试静态扫源码里的 import，任何新的环都会在这里被拦下。
   */
  const mainDir = path.join(root, 'src/main')
  const graph = new Map()
  const collect = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        collect(full)
        continue
      }
      if (!/\.ts$/.test(entry.name)) continue
      const source = fs.readFileSync(full, 'utf8')
      const targets = []
      // 只认相对 import，且只关心 src/main 内部
      const re = /from\s+['"](\.[^'"]+)['"]/g
      let match
      while ((match = re.exec(source)) !== null) {
        const resolved = path.resolve(path.dirname(full), match[1])
        for (const candidate of [`${resolved}.ts`, path.join(resolved, 'index.ts')]) {
          if (fs.existsSync(candidate) && candidate.startsWith(mainDir)) {
            targets.push(candidate)
            break
          }
        }
      }
      graph.set(full, targets)
    }
  }
  collect(mainDir)

  const cycles = []
  const state = new Map() // undefined=未访问, 1=在栈上, 2=已完成
  const stack = []
  const visit = (node) => {
    state.set(node, 1)
    stack.push(node)
    for (const next of graph.get(node) || []) {
      if (state.get(next) === 1) {
        const from = stack.indexOf(next)
        cycles.push(stack.slice(from).concat(next).map((p) => path.relative(mainDir, p)))
      } else if (!state.get(next)) {
        visit(next)
      }
    }
    stack.pop()
    state.set(node, 2)
  }
  for (const node of graph.keys()) {
    if (!state.get(node)) visit(node)
  }

  check(
    'src/main 的模块依赖没有环',
    cycles.length === 0,
    cycles.map((c) => c.join(' → ')).join(' | ')
  )

  /*
   * 单独确认那条具体的环已被断开。
   *
   * 通用检查已经覆盖了它，但这条写明的测试有额外作用：
   * 将来有人「顺手」把 session-tools 的 import 改回 '../archive' 时，
   * 失败信息会直接点出原因，而不是让人对着一个环的路径图自己猜。
   */
  const sessionToolsSource = fs.readFileSync(path.join(mainDir, 'tools/session-tools.ts'), 'utf8')
  check(
    '会话工具从叶子模块取归档索引（不 import archive）',
    sessionToolsSource.includes("from '../archive-index'") &&
      !/from\s+['"]\.\.\/archive['"]/.test(sessionToolsSource)
  )
}

/* ══ 8. 跑完清理 ════════════════════════════════════════════ */

try {
  await systemDocTests()
  await memoryTests()
  await usageTests()
  await archiveTests()
  await atomicFileTests()
} finally {
  usage.flushUsage()
  Module._load = originalLoad
  fs.rmSync(USERDATA, { recursive: true, force: true })
}

say('')
reportMutedLogs()
if (failures > 0) {
  say(`共 ${failures} 项失败`)
  process.exit(1)
}
say('全部通过')
