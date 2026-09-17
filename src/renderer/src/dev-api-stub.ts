/**
 * 浏览器预览用的 window.api 桩（仅开发态生效）
 *
 * 为什么需要它：
 *   渲染进程的一切能力都来自 preload 通过 contextBridge 注入的 window.api。
 *   用普通浏览器直接打开 dev server（http://<host>:5173）时没有 preload，
 *   window.api === undefined，App.tsx 里 `window.api.onLog(...)` 立即抛错，
 *   React 会把整棵树卸载 → 白屏。
 *
 * 它做三件事：
 *   1. 补齐 AppApi 的全部方法，让界面能正常渲染、按钮都能点
 *   2. 用一个内存虚拟文件系统代替真实磁盘，打开工作区 / 文件树 / 编辑 / 保存全流程可走通
 *   3. 用定时器模拟 AI 流式返回，AI 面板也能演示（含「停止」）
 *
 * 它绝不会影响打包产物：
 *   - 只在 import.meta.env.DEV 为真时安装（打包后为 false）
 *   - 只在非 Electron 环境安装（UA 里带 Electron/ 就直接跳过）
 *   - 只在 window.api 尚不存在时安装（Electron 下 preload 已注入，直接返回）
 */

import type { AppApi } from '@shared/api'
import { languageFromPath } from '@shared/language'
import { buildSystemDoc } from '@shared/system-doc'
import { textOf } from '@shared/types'
import {
  DEFAULT_CONFIG,
  RECENT_SESSIONS_MAX,
  SESSION_TITLE_MAX,
  type AiStreamChunk,
  type AiUsage,
  type AppConfig,
  type CapabilityInfo,
  type ChatMessage,
  type DoctorReport,
  type EditorSession,
  type FileChangeEvent,
  type LoadedFile,
  type LogLevel,
  type LogLine,
  type RuntimeInfo,
  type SessionEntry,
  type SnapshotSummary,
  type StoredSession,
  type ToolName,
  type UsageStats,
  type WorkspaceEntry,
  type ArchivedSession
} from '@shared/types'
import {
  DEMO_ROOT,
  baseNameOf,
  dirs,
  ensureParents,
  files,
  joinPath,
  normalize,
  parentOf,
  readDirSync
} from './dev-stub-fs'

/** 桩里的最近工作区 / 最近会话：初始为空，用着用着就长出来 */
let stubWorkspaces: WorkspaceEntry[] = []
let stubSessions: SessionEntry[] = []

/** 浏览器桩里的归档索引与用量统计，都只在内存里 */
let stubArchive: ArchivedSession[] = []

function emptyStubUsage(): UsageStats {
  const bucket = {
    requests: 0,
    estimatedRequests: 0,
    promptTokens: 0,
    completionTokens: 0,
    cachedTokens: 0
  }
  return { today: { ...bucket }, week: { ...bucket }, total: { ...bucket }, days: [], models: [], since: '' }
}

/**
 * 桩里的 `系统.md` 内容。
 *
 * 直接复用真实的组装规则（buildSystemDoc）而不是手写一段假文本 ——
 * 这样在浏览器里看到的排版、分段、说明文字与真机完全一致，
 * 改组装规则时桩也跟着变，不会出现「桩里好看、真机不一样」。
 */
function stubSystemDoc(): string {
  return buildSystemDoc({
    aiName: stubConfig.ai.aiName,
    userName: stubConfig.ai.userName,
    habits: stubConfig.ai.habits,
    runtimes: [
      { name: 'python', version: '3.11.4', note: '可以跑 .py 脚本' },
      { name: 'node', version: 'v18.17.0', note: '可以跑 .js 脚本与 npm' }
    ],
    environmentNote: '用户的操作系统：Windows 10 22H2，64 位。（浏览器桩示例）',
    permissionMode: stubConfig.permission.mode
  })
}

let stubUsage: UsageStats = emptyStubUsage()
/** 会话正文（索引里没有，单独存，和真机的 sessions/*.json 对应） */
const stubBodies = new Map<string, StoredSession>()
/** 编辑器状态：打开过哪些文件。桩里也放内存，和真机落 config.json 对应 */
let stubEditorSession: EditorSession = { tabs: [], activePath: '', split: 0.62 }
/** 可撤销记录。真机由 tools/snapshot.ts 维护，这里放几条假的给界面演示 */
let stubSnapshots: SnapshotSummary[] = []

/** 文件变化事件的订阅者（桩里只有模拟的 AI 写入会触发） */
const stubFileWatchers = new Set<(event: FileChangeEvent) => void>()

/**
 * 广播一次文件变化（桩内部用）。
 *
 * 同时补一条可撤销记录，这样界面上的「撤销」按钮点下去有反馈 ——
 * 桩里没有真实快照，不补的话按钮永远是死的，看不出设计意图。
 */
function emitFileChanged(filePath: string, origin: FileChangeEvent['origin']): void {
  const event: FileChangeEvent = { path: filePath, origin, at: new Date().toISOString() }
  stubSnapshots = [
    ...stubSnapshots,
    {
      id: `snap-${Date.now()}`,
      time: event.at,
      path: filePath,
      source: origin === 'ai' ? 'writeFile' : 'manual',
      lineDelta: 1
    }
  ].slice(-20)
  for (const cb of stubFileWatchers) cb(event)
}

/* ------------------------------------------------------------------ *
 * 内存虚拟文件系统
 * ------------------------------------------------------------------ */

/*
 * 实现已经搬到 dev-stub-fs.ts（本文件曾到 780 行，逼近 800 行红线）。
 * 那边只管「路径 → 内容」这层数据；这里只做转出，
 * 让下面所有 window.api 的实作继续用同一批名字，不用满文件改引用。
 */
export { DEMO_ROOT, dirs, files, joinPath, normalize, parentOf, readDirSync } from './dev-stub-fs'/* ------------------------------------------------------------------ *
 * 事件总线（替代 ipcRenderer 的 on / send）
 * ------------------------------------------------------------------ */

type Listener<T> = (payload: T) => void

const logListeners = new Set<Listener<LogLine>>()
const aiListeners = new Set<Listener<AiStreamChunk>>()
const menuListeners = new Set<Listener<string>>()

/** 订阅发生在 React 挂载之前，早于第一个订阅者的日志先攒着，有人听了再补发 */
const earlyLogs: LogLine[] = []

function emitLog(scope: string, text: string, level: LogLevel = 'info'): void {
  const line: LogLine = {
    time: new Date().toLocaleTimeString('zh-CN', { hour12: false }),
    level,
    scope,
    text
  }
  if (logListeners.size === 0) {
    earlyLogs.push(line)
    return
  }
  for (const cb of logListeners) cb(line)
}

function emitAi(chunk: AiStreamChunk): void {
  for (const cb of aiListeners) cb(chunk)
}

function subscribe<T>(set: Set<Listener<T>>, cb: Listener<T>): () => void {
  set.add(cb)
  return () => {
    set.delete(cb)
  }
}

/* ------------------------------------------------------------------ *
 * 运行环境 / 体检
 * ------------------------------------------------------------------ */

function browserChromeVersion(): string {
  const m = navigator.userAgent.match(/Chrom(?:e|ium)\/([\d.]+)/)
  return m ? m[1] : '未知'
}

function stubRuntime(): RuntimeInfo {
  return {
    appVersion: '0.1.0（浏览器预览）',
    electron: '未连接',
    chrome: browserChromeVersion(),
    node: '未连接',
    v8: '未连接',
    platform: 'browser',
    arch: navigator.platform || 'unknown',
    osRelease: navigator.userAgent,
    osName: '浏览器预览',
    osTier: 'other',
    osBuild: 0,
    osSupport: 'incidental',
    osSupportNote: '当前不是 Electron 环境：window.api 由 dev 桩提供，仅用于界面开发调试',
    softwareRendering: false,
    compatNotes: ['dev 桩模式：文件操作全部在内存中，不落盘'],
    userDataPath: '(内存，不落盘)',
    logsPath: '(内存，不落盘)',
    locale: navigator.language
  }
}

function buildDoctor(): DoctorReport {
  return {
    runtime: stubRuntime(),
    checks: [
      {
        id: 'env',
        label: '运行环境',
        status: 'warn',
        detail: '浏览器预览模式，未连接主进程（真实环境体检请在 Electron 里运行）'
      },
      {
        id: 'api',
        label: 'window.api',
        status: 'warn',
        detail: '由 dev 桩提供，文件读写仅作用于内存虚拟目录'
      },
      { id: 'ui', label: '界面渲染', status: 'pass', detail: 'React 与 Monaco 已挂载' }
    ],
    // 浏览器里没法探测本机装了 python / node 没有（那是主进程的活），
    // 给几条假的让界面能演示这一块
    runtimes: [
      { name: 'python', version: 'Python 3.11.4', path: 'C:\\Python311\\python.exe', note: '可以跑 .py 脚本' },
      { name: 'node', version: 'v18.17.0', path: 'C:\\Program Files\\nodejs\\node.exe', note: '可以跑 .js 脚本与 npm' }
    ],
    generatedAt: new Date().toISOString()
  }
}

/* ------------------------------------------------------------------ *
 * 模拟 AI 流式回答
 * ------------------------------------------------------------------ */

interface PendingStream {
  timers: number[]
  finish: () => void
}

const pending = new Map<string, PendingStream>()

function fakeReply(question: string): string {
  const q = question.trim().split('\n')[0].slice(0, 40) || '你的问题'
  return [
    '（浏览器预览模式的模拟回答，不会真的调用模型）',
    '',
    `你问的是「${q}」。`,
    '',
    '这段代码在做的事：把几个分数放进列表，再逐个打印出来。',
    '',
    '问题在这里：range(len(scores)) 的下标是 0 到 2，写成别的上界就会越界，',
    'Python 会抛 IndexError: list index out of range。',
    '',
    '```python',
    'scores = [90, 85, 77]',
    '',
    'for i in range(len(scores)):   # 上界用 len，不要手写数字',
    '    print(scores[i])',
    '```',
    '',
    '改完就能正常输出了。'
  ].join('\n')
}

/** 上一次请求的 prompt，用于和主进程同一套逻辑估算缓存命中 */
let lastPromptText = ''

function flatten(messages: ChatMessage[]): string {
  return messages.map((m) => `${m.role}\u0000${m.content}`).join('\u0001')
}

/** 桩里没有真实用量，按“与上一次请求的公共前缀”估一个，和主进程的算法保持一致 */
function buildStubUsage(messages: ChatMessage[], reply: string): AiUsage {
  const prompt = flatten(messages)
  const promptTokens = Math.max(1, Math.round(prompt.length / 2))
  const max = Math.min(prompt.length, lastPromptText.length)
  let common = 0
  while (common < max && prompt.charCodeAt(common) === lastPromptText.charCodeAt(common)) common++
  const cachedTokens = Math.round(promptTokens * (common / Math.max(1, prompt.length)))
  return {
    promptTokens,
    completionTokens: Math.max(1, Math.round(reply.length / 2)),
    cachedTokens,
    cacheHitRate: cachedTokens / promptTokens,
    source: 'estimate'
  }
}

function streamReply(requestId: string, messages: ChatMessage[]): Promise<void> {
  const lastUser = [...messages].reverse().find((m) => m.role === 'user')
  // 桩里只认文本部分：图片 base64 对假回答没有意义
  const reply = fakeReply(lastUser?.content ? textOf(lastUser.content) : '')
  const chunks = `${reply}\n`.match(/[\s\S]{1,4}/g) ?? []
  const promptText = flatten(messages)
  const timers: number[] = []

  /**
   * 模拟工具调用过程，让「工具能力」这个功能在浏览器预览里也能看见。
   * 真实环境里这些事件由主进程的工具循环发出，格式完全一致。
   */
  const demoCalls: Array<{ name: string; summary: string }> = [
    { name: 'listDir', summary: '列出目录 demo' },
    { name: 'readFile', summary: '读取 hello.py' },
    { name: 'editFile', summary: '替换一处 hello.py' }
  ]

  return new Promise<void>((resolve) => {
    let settled = false
    const finish = (): void => {
      if (settled) return
      settled = true
      resolve()
    }

    const lead = demoCalls.length * 200 + 120
    demoCalls.forEach((call, index) => {
      const at = 120 + index * 200
      timers.push(
        window.setTimeout(
          () =>
            emitAi({
              requestId,
              kind: 'tool',
              tool: { name: call.name, phase: 'start', summary: call.summary }
            }),
          0
        )
      )
      timers.push(
        window.setTimeout(
          () =>
            emitAi({
              requestId,
              kind: 'tool',
              tool: { name: call.name, phase: 'done', summary: call.summary, ok: true }
            }),
          at
        )
      )
    })

    chunks.forEach((text, index) => {
      timers.push(
        window.setTimeout(() => emitAi({ requestId, kind: 'delta', text }), lead + 40 * (index + 1))
      )
    })
    timers.push(
      window.setTimeout(() => {
        pending.delete(requestId)
        emitAi({ requestId, kind: 'done', usage: buildStubUsage(messages, reply) })
        lastPromptText = promptText
        finish()
      }, lead + 40 * (chunks.length + 1))
    )

    pending.set(requestId, { timers, finish })
  })
}

/* ------------------------------------------------------------------ *
 * 桩本体
 * ------------------------------------------------------------------ */

let stubConfig: AppConfig = JSON.parse(JSON.stringify(DEFAULT_CONFIG)) as AppConfig

/** 跨系统的文件工具，与主进程的 CROSS_OS_TOOLS 一致 */
const STUB_FILE_TOOLS: ToolName[] = [
  'readFile',
  'writeFile',
  'editFile',
  'multiEdit',
  'listDir',
  'glob',
  'grep',
  'undoSnapshot'
]

/** 需要命令执行能力的工具。浏览器里没有系统探测，因此永远拿不到这些能力 */
const STUB_COMMAND_TOOLS: ToolName[] = ['runCommand', 'jobRun', 'jobPoll', 'jobKill']

/**
 * 记忆与会话检索工具。
 *
 * 浏览器桩里**照常提供**（不像命令类那样永远拿不到）：
 * 它们不需要任何外部程序，真机与桩机的差别只在数据从哪来。
 * 打开它们能让「设置 → 工具能力」这一页在预览时也能完整演示。
 */
const STUB_MEMORY_TOOLS: ToolName[] = ['listSessions', 'readSession', 'memoryGet', 'memoryWrite']

/** 技能工具：纯读用户自己的文件，浏览器里没有真实目录，但界面要能演示 */
const STUB_SKILL_TOOLS: ToolName[] = ['listSkills', 'readSkill']

/** 全部工具，与主进程的 ALL_TOOLS 一致 */
const STUB_ALL_TOOLS: ToolName[] = [
  ...STUB_FILE_TOOLS,
  ...STUB_COMMAND_TOOLS,
  ...STUB_MEMORY_TOOLS,
  ...STUB_SKILL_TOOLS
]

const STUB_TOOL_LABELS: Record<ToolName, string> = {
  readFile: '读取文件',
  writeFile: '写入文件',
  editFile: '替换一处',
  multiEdit: '替换多处',
  listDir: '列出目录',
  glob: '查找文件',
  grep: '搜索内容',
  undoSnapshot: '撤销修改',
  runCommand: '执行命令',
  jobRun: '后台任务',
  jobPoll: '查询任务',
  jobKill: '终止任务',
  listSessions: '翻归档会话',
  readSession: '读会话记录',
  memoryGet: '读记忆',
  memoryWrite: '记一笔',
  listSkills: '查看技能',
  readSkill: '读取技能'
}

/**
 * 桩里的能力信息。
 * 浏览器里没有系统探测，但「设置」这一层照算 —— 否则预览时改放开程度 /
 * 逐个工具开关会看起来没反应，界面调不到真实效果。
 * 过滤顺序与主进程 getCapabilityInfo() 保持一致。
 */
function stubCapability(): CapabilityInfo {
  const { mode, disabled } = stubConfig.capability
  const effective: ToolName[] = []
  const filtered: Array<{ name: ToolName; reason: string }> = []

  // 过滤顺序与主进程 getCapabilityInfo() 逐条对应：
  // 设置上限 → 逐个关闭 → 本机能力。
  // 浏览器里探测结果就是「没有命令执行能力」，所以命令类工具在这里的结论
  // 与主进程在 Win7 / 非 Windows 上的结论一致。
  const allowed = mode === 'conservative' ? new Set<ToolName>(STUB_FILE_TOOLS) : new Set<ToolName>(STUB_ALL_TOOLS)

  for (const name of STUB_ALL_TOOLS) {
    if (!allowed.has(name)) {
      filtered.push({ name, reason: '设置未放开（保守模式）' })
      continue
    }
    if (disabled.includes(name)) {
      filtered.push({ name, reason: '已在设置中关闭' })
      continue
    }
    // mode === 'full' 时故意跳过能力检查，与主进程一致：
    // 真调用了会在工具层拿到 TOOL_UNAVAILABLE 的可读错误
    if (STUB_COMMAND_TOOLS.includes(name) && mode !== 'full') {
      filtered.push({ name, reason: '本机不支持（命令执行能力）' })
      continue
    }
    effective.push(name)
  }

  return {
    profile: '浏览器预览（非 Electron，无系统探测）',
    detected: { none: true, commandExec: false, backgroundJobs: false },
    notes: ['浏览器预览模式：能力由 dev 桩给出，仅用于界面调试'],
    mode,
    effective,
    filtered,
    labels: STUB_TOOL_LABELS,
    overridden: false
  }
}

function createApi(): AppApi {
  return {
    runtime: async () => stubRuntime(),
    doctor: async () => buildDoctor(),
    openLogs: async () => {
      emitLog('stub', '浏览器预览模式没有日志文件，日志只显示在底部输出面板', 'warn')
      return '(浏览器预览模式：无日志文件)'
    },
    capabilities: async () => stubCapability(),

    getConfig: async () => stubConfig,
    setConfig: async (patch: Partial<AppConfig>) => {
      stubConfig = { ...stubConfig, ...patch }
      emitLog('config', '配置已在内存中更新（浏览器预览模式，不落盘）')
      return stubConfig
    },

    /*
     * 权限模式。
     *
     * 浏览器预览里没有主进程，也就没有真正的边界判定 ——
     * 这份桩只让设置界面能切、能读回，并明确记一条日志说明它是假的。
     * 别在这里「模拟审批」：那会让人误以为浏览器里验证过权限逻辑了。
     */
    getPermissionMode: async () => stubConfig.permission.mode,
    setPermissionMode: async (mode: string) => {
      stubConfig = {
        ...stubConfig,
        permission: { mode: mode as AppConfig['permission']['mode'] }
      }
      emitLog('permission', `权限模式已切到 ${mode}（浏览器预览模式，无真实边界判定）`, 'warn')
      return stubConfig
    },
    startExecuting: async (_sessionId: string) => {
      emitLog('permission', '已批准执行（浏览器预览模式，无实际效果）')
      return true
    },
    resolveApproval: async () => false,
    // 浏览器预览里不会有越界请求（没有主进程），但接口要能对上
    onApprovalRequest: () => () => {},

    /*
     * 技能：浏览器里没有真实文件系统，给一份**固定的示例数据**。
     * 不用内存虚拟 FS 造：那样用户会以为在浏览器里建的技能真能生效。
     * 列表里明确写着「示例」，点开也能看到说明。
     */
    listSkills: async () => [
      {
        id: 'example',
        name: '示例技能',
        description: '浏览器预览模式的固定示例。真实技能在 userData/skills 下。',
        source: 'user' as const,
        path: '(浏览器预览模式：无真实路径)'
      }
    ],
    readSkillText: async (id: string) =>
      `【技能：${id}】\n----\n（浏览器预览模式）这是桩数据。\n` +
      '真实环境下这里会显示 skills/<id>/SKILL.md 的正文。',
    openSkillsDir: async () => {
      emitLog('skill', '浏览器预览模式无法打开系统文件管理器', 'warn')
      return false
    },

    /* MCP：浏览器里没有子进程，不假装能连 */
    mcpStatus: async () => [],
    mcpReconnect: async () => {
      emitLog('mcp', '浏览器预览模式无法启动 MCP 子进程', 'warn')
      return []
    },

    openWorkspace: async (preset?: string) => {
      /*
       * 浏览器预览模式才用 prompt（在浏览器里是好的）。
       * 但这份桩会被打进渲染层包，而 Electron 里 window.prompt 不存在 ——
       * 所以这里必须判一下再用，不能直接调：真实运行时若误走到桩，
       * 直接调 prompt 会抛错，而抛错信息与「新建文件没反应」完全不像，很难查。
       */
      const ask = typeof window.prompt === 'function' ? window.prompt : null
      const input = ask
        ? ask('浏览器预览模式：输入要打开的虚拟目录', preset || DEMO_ROOT)
        : preset || DEMO_ROOT
      if (input === null) return ''
      const dir = normalize(input)
      if (!dirs.has(dir)) {
        emitLog('ws', `目录不存在：${dir}（演示目录是 ${DEMO_ROOT}）`, 'warn')
        return ''
      }
      emitLog('ws', `打开工作区：${dir}`)
      return dir
    },

    readDir: async (dir: string) => {
      const nodes = readDirSync(dir)
      emitLog('tree', `读取目录 ${dir}：${nodes.length} 项`)
      return nodes
    },

    readFile: async (file: string) => {
      const key = normalize(file)
      const content = files.get(key)
      if (content === undefined) throw new Error(`文件不存在: ${key}`)
      const loaded: LoadedFile = {
        path: key,
        content,
        language: languageFromPath(key),
        truncated: false
      }
      return loaded
    },

    writeFile: async (file: string, content: string) => {
      const key = normalize(file)
      ensureParents(key)
      files.set(key, content)
      emitLog('file', `已保存 ${key}（内存，${content.length} 字符）`)
      // 真机里这个动作会被 fs.watch 捕到，桩里手动广播一次，
      // 好让「外部改动 → 编辑器自动重载」这条链路在浏览器里也能演示
      emitFileChanged(key, 'external')
      return true
    },

    createEntry: async (parent: string, name: string, kind: 'file' | 'dir') => {
      const target = joinPath(normalize(parent), name)
      if (kind === 'dir') {
        dirs.add(target)
      } else {
        ensureParents(target)
        files.set(target, '')
      }
      emitLog('ws', `新建${kind === 'dir' ? '目录' : '文件'}：${target}`)
      return target
    },

    rename: async (from: string, newName: string) => {
      const src = normalize(from)
      const target = joinPath(parentOf(src), newName)
      const content = files.get(src)
      if (content !== undefined) {
        files.set(target, content)
        files.delete(src)
      } else if (dirs.has(src)) {
        dirs.delete(src)
        dirs.add(target)
        for (const [p, c] of [...files]) {
          if (p.startsWith(`${src}/`)) {
            files.delete(p)
            files.set(target + p.slice(src.length), c)
          }
        }
      }
      emitLog('ws', `重命名：${src} → ${target}`)
      return target
    },

    moveEntry: async (from: string, destDir: string) => {
      const src = normalize(from)
      const dir = normalize(destDir)
      const target = joinPath(dir, baseNameOf(src))
      if (target === src) return src
      // 与主进程一致的守卫：不允许移进自己的子孙目录
      if (dir.startsWith(`${src}/`)) throw new Error('不能把一个文件夹移动到它自己里面')
      if (files.has(target) || dirs.has(target)) {
        throw new Error(`目标文件夹里已经有「${baseNameOf(src)}」了`)
      }
      const content = files.get(src)
      if (content !== undefined) {
        files.set(target, content)
        files.delete(src)
      } else if (dirs.has(src)) {
        dirs.delete(src)
        dirs.add(target)
        for (const p of [...dirs]) {
          if (p.startsWith(`${src}/`)) {
            dirs.delete(p)
            dirs.add(target + p.slice(src.length))
          }
        }
        for (const [p, c] of [...files]) {
          if (p.startsWith(`${src}/`)) {
            files.delete(p)
            files.set(target + p.slice(src.length), c)
          }
        }
      }
      emitLog('ws', `移动：${src} → ${target}`)
      return target
    },

    remove: async (target: string) => {
      const key = normalize(target)
      if (files.has(key)) {
        files.delete(key)
      } else if (dirs.has(key)) {
        dirs.delete(key)
        for (const p of [...files.keys()]) if (p.startsWith(`${key}/`)) files.delete(p)
      }
      emitLog('ws', `删除：${key}`, 'warn')
      return true
    },

    /**
     * @ 引用的候选列表。
     *
     * 浏览器预览里的「工作区」就是内存虚拟目录，所以直接列出 files 里
     * 相对 DEMO_ROOT 的路径 —— 与真实主进程返回「相对工作区根」的路径语义一致。
     */
    listFiles: async () =>
      [...files.keys()]
        .filter((p) => p.startsWith(`${DEMO_ROOT}/`))
        .map((p) => p.slice(DEMO_ROOT.length + 1))
        .sort((a, b) => a.localeCompare(b, 'zh-Hans-CN')),

    // 以下这批只在浏览器预览里能跑，用来核对左边侧栏与右键菜单的交互
    listWorkspaces: async () => stubWorkspaces,

    removeRecentWorkspace: async (target: string) => {
      stubWorkspaces = stubWorkspaces.filter((w) => w.path !== normalize(target))
      emitLog('ws', `从最近列表移除：${target}`)
      return stubWorkspaces
    },

    revealInOs: async (target: string) => {
      emitLog('ws', `浏览器预览模式不能调系统程序：${target}`, 'warn')
      return false
    },

    previewInBrowser: async (target: string) => {
      // 桩里没法起临时静态服务，用一个空白页告诉学生「真机上会在这里打开」
      const win = window.open('', '_blank')
      if (win) {
        win.document.title = '预览（浏览器桩）'
        win.document.body.innerHTML = `<pre style="font:13px/1.6 monospace;padding:24px">浏览器预览模式

真实应用里会用系统浏览器打开：
${target}

（桩不会起临时服务，所以这里看不到页面）</pre>`
      }
      emitLog('ws', `预览：${target}`)
      return true
    },

    /*
     * 内嵌预览的 previewUrl 已随面板一起去掉。
     * 浏览器预览模式下 openExternal 打不开真实浏览器（没有主进程），
     * 所以只记一条日志说明「这里点了不会真的开浏览器」——
     * 假装成功会让人以为浏览器预览里验证过这条路径了。
     */
    setShowHidden: async (showHidden: boolean) => {
      stubConfig = { ...stubConfig, explorer: { ...stubConfig.explorer, showHidden } }
      emitLog('tree', `显示隐藏文件：${showHidden ? '开' : '关'}`)
      return stubConfig
    },

    listSessions: async () => stubSessions,

    touchSession: async (entry: { id: string; title: string; workspace: string; messageCount: number }) => {
      const next = {
        id: entry.id,
        title: entry.title.slice(0, SESSION_TITLE_MAX) || '（未命名会话）',
        workspace: entry.workspace,
        updatedAt: new Date().toISOString(),
        messageCount: entry.messageCount
      }
      stubSessions = [next, ...stubSessions.filter((s) => s.id !== entry.id)].slice(0, RECENT_SESSIONS_MAX)
      return stubSessions
    },

    removeSession: async (id: string) => {
      stubSessions = stubSessions.filter((s) => s.id !== id)
      stubBodies.delete(id)
      emitLog('session', `删除会话记录：${id}`)
      return stubSessions
    },

    // 浏览器桩里会话正文只存内存，刷新页面就没了 —— 真机是落 userData/sessions/*.json
    loadSession: async (id: string) => stubBodies.get(id) ?? null,

    saveSession: async (session: StoredSession) => {
      stubBodies.set(session.id, session)
      return true
    },

    /*
     * 归档相关：桩里只维护内存里的一份索引与一段假梗概。
     *
     * 假梗概是**故意**的：真机上的梗概要发一次模型请求才拿到，
     * 而浏览器桩没有主进程、也没有密钥。写一句假的能让设置页
     * 与 AI 工具的界面在 `npm run dev:web` 下也能完整走一遍。
     */
    archiveSession: async (id: string) => {
      const entry = stubSessions.find((item) => item.id === id)
      if (!entry) throw new Error('找不到这条会话')
      entry.archived = true
      if (!stubArchive.some((item) => item.id === id)) {
        stubArchive = [
          {
            id,
            title: entry.title,
            summary: '（浏览器桩生成的示例梗概，真机会由模型总结。）',
            archivedAt: new Date().toISOString(),
            workspace: entry.workspace,
            messageCount: entry.messageCount
          },
          ...stubArchive
        ]
      }
      emitLog('session', `归档会话：${id}`)
      return { message: '已归档（浏览器桩）', entries: stubArchive }
    },

    unarchiveSession: async (id: string) => {
      const entry = stubSessions.find((item) => item.id === id)
      if (entry) entry.archived = false
      stubArchive = stubArchive.filter((item) => item.id !== id)
      return { message: '已取消归档（浏览器桩）', entries: stubArchive }
    },

    listArchive: async () => stubArchive,

    // ---- 系统设定与用量：桩里给一份能看的静态内容 ----
    getSystemDoc: async () => ({
      path: '(浏览器桩没有真实文件)',
      content: stubSystemDoc(),
      inSync: true,
      exists: true
    }),

    regenerateSystemDoc: async () => ({
      path: '(浏览器桩没有真实文件)',
      content: stubSystemDoc(),
      inSync: true,
      exists: true
    }),

    openSystemDoc: async () => {
      emitLog('session', '浏览器桩不支持打开文件')
      return false
    },

    getUsageStats: async () => stubUsage,
    resetUsageStats: async () => {
      stubUsage = emptyStubUsage()
      return stubUsage
    },

    // ---- 编辑器会话与撤销：桩里都放内存，刷新即失 ----
    getEditorSession: async () => stubEditorSession,

    setEditorSession: async (session: EditorSession) => {
      stubEditorSession = session
      return true
    },

    listSnapshots: async () => stubSnapshots,

    undoChange: async (target?: string) => {
      const index = target
        ? stubSnapshots.findIndex((s) => s.path === target)
        : stubSnapshots.length - 1
      if (index < 0) {
        return { ok: false, message: '没有可撤销的修改' }
      }
      const [item] = stubSnapshots.splice(index, 1)
      emitLog('file', `撤销：${item.path}`)
      return { ok: true, message: `已把 ${item.path} 恢复到修改前`, path: item.path }
    },

    // sessionId 在桩里用不到（没有真实的 system prompt 组装），收下即可
    aiChat: async (requestId: string, messages: ChatMessage[], _sessionId?: string) =>
      streamReply(requestId, messages),

    aiAbort: async (requestId: string) => {
      const item = pending.get(requestId)
      if (!item) return false
      item.timers.forEach((t) => window.clearTimeout(t))
      pending.delete(requestId)
      emitAi({ requestId, kind: 'done' })
      item.finish()
      emitLog('ai', '已停止本次生成')
      return true
    },

    aiTest: async () => ({
      ok: false,
      detail: '浏览器预览模式不会真的发起网络请求；测试连接请在 Electron 里做'
    }),

    aiListModels: async () => ({
      ok: false,
      models: [],
      detail: '浏览器预览模式不拉取模型列表；请在 Electron 里获取'
    }),

    onAiStream: (cb) => subscribe(aiListeners, cb),
    onLog: (cb) => {
      const off = subscribe(logListeners, cb)
      while (earlyLogs.length) {
        const line = earlyLogs.shift()
        if (line) cb(line)
      }
      return off
    },
    onMenu: (cb) => subscribe(menuListeners, cb),

    onFileChanged: (cb) => {
      stubFileWatchers.add(cb)
      return () => {
        stubFileWatchers.delete(cb)
      }
    }
  }
}

/**
 * 安装桩。返回是否真的安装了（Electron 里或打包后返回 false）。
 */
export function installDevApiStub(): boolean {
  if (!import.meta.env.DEV) return false
  // Electron 里 preload 已经注入真实 api，绝不能覆盖
  if (typeof window.api !== 'undefined') return false
  if (/\bElectron\//.test(navigator.userAgent)) return false

  Object.defineProperty(window, 'api', {
    value: createApi(),
    writable: true,
    configurable: true
  })
  window.__DEV_API_STUB__ = true

  emitLog('stub', '浏览器预览模式：window.api 由 dev 桩提供，文件操作只在内存中', 'warn')
  emitLog('stub', `内置演示目录：${DEMO_ROOT}（点「打开文件夹」即可打开）`)
  return true
}
