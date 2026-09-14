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
import {
  DEFAULT_CONFIG,
  type AiStreamChunk,
  type AppConfig,
  type ChatMessage,
  type DoctorReport,
  type FileNode,
  type LoadedFile,
  type LogLevel,
  type LogLine,
  type RuntimeInfo
} from '@shared/types'

/* ------------------------------------------------------------------ *
 * 内存虚拟文件系统
 * ------------------------------------------------------------------ */

const DEMO_ROOT = '/demo'

const DEMO_FILES: Record<string, string> = {
  [`${DEMO_ROOT}/README.md`]: [
    '# 演示工作区',
    '',
    '这是浏览器预览模式的内置示例目录，**所有改动只存在内存里**，刷新页面就回到初始状态。',
    '',
    '## 可以试的几件事',
    '',
    '1. 双击左侧文件树里的文件，中间会用 Monaco 打开',
    '2. 改几行字，按 Ctrl+S，看底部「输出」面板有没有保存日志',
    '3. 右侧 AI 面板先点「设置」随便填上地址 / 密钥 / 模型，就能看到模拟的流式回答',
    '',
    '> 想要真实能力（读写真实磁盘、真连模型），请在 Electron 里运行，不要用浏览器。'
  ].join('\n'),

  [`${DEMO_ROOT}/hello.py`]: [
    '# 第一课：打印和循环',
    'scores = [90, 85, 77]',
    '',
    '# 这里故意写错了一位，观察报错信息',
    'for i in range(len(scores)):',
    '    print(scores[i])',
    '',
    'print("平均分:", sum(scores) / len(scores))'
  ].join('\n'),

  [`${DEMO_ROOT}/index.html`]: [
    '<!doctype html>',
    '<html lang="zh-CN">',
    '  <head>',
    '    <meta charset="UTF-8" />',
    '    <title>示例页面</title>',
    '  </head>',
    '  <body>',
    '    <h1>你好，同学</h1>',
    '    <button id="btn">点我</button>',
    '    <script src="./src/main.js"></script>',
    '  </body>',
    '</html>'
  ].join('\n'),

  [`${DEMO_ROOT}/src/main.js`]: [
    '// 一个最小的 DOM 事件示例',
    'const btn = document.getElementById("btn")',
    '',
    'btn.addEventListener("click", () => {',
    '  btn.textContent = "已经点过了"',
    '})'
  ].join('\n'),

  [`${DEMO_ROOT}/data/scores.json`]: [
    '{',
    '  "class": "初一(2)班",',
    '  "scores": [90, 85, 77, 96]',
    '}'
  ].join('\n')
}

const files = new Map<string, string>(Object.entries(DEMO_FILES))
const dirs = new Set<string>()

function normalize(p: string): string {
  const s = p.replace(/\\/g, '/').replace(/\/+$/, '')
  return s === '' ? '/' : s
}

function parentOf(p: string): string {
  const idx = p.lastIndexOf('/')
  return idx <= 0 ? '/' : p.slice(0, idx)
}

function joinPath(base: string, name: string): string {
  return base === '/' ? `/${name}` : `${base}/${name}`
}

function ensureParents(p: string): void {
  let cur = parentOf(normalize(p))
  while (cur !== '/' && cur !== '') {
    dirs.add(cur)
    cur = parentOf(cur)
  }
}

for (const key of files.keys()) ensureParents(key)

function readDirSync(dir: string): FileNode[] {
  const base = normalize(dir)
  const prefix = base === '/' ? '/' : `${base}/`
  const out = new Map<string, FileNode>()

  for (const [p, content] of files) {
    if (!p.startsWith(prefix)) continue
    const rest = p.slice(prefix.length)
    const slash = rest.indexOf('/')
    if (slash === -1) {
      out.set(rest, { name: rest, path: p, kind: 'file', size: content.length })
    } else {
      const name = rest.slice(0, slash)
      out.set(name, { name, path: prefix + name, kind: 'dir' })
    }
  }

  for (const d of dirs) {
    if (!d.startsWith(prefix)) continue
    const rest = d.slice(prefix.length)
    if (!rest || rest.includes('/')) continue
    out.set(rest, { name: rest, path: d, kind: 'dir' })
  }

  return [...out.values()].sort((a, b) =>
    a.kind === b.kind ? a.name.localeCompare(b.name, 'zh') : a.kind === 'dir' ? -1 : 1
  )
}

/* ------------------------------------------------------------------ *
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

function streamReply(requestId: string, messages: ChatMessage[]): Promise<void> {
  const lastUser = [...messages].reverse().find((m) => m.role === 'user')
  const chunks = `${fakeReply(lastUser?.content ?? '')}\n`.match(/[\s\S]{1,4}/g) ?? []
  const timers: number[] = []

  return new Promise<void>((resolve) => {
    let settled = false
    const finish = (): void => {
      if (settled) return
      settled = true
      resolve()
    }

    chunks.forEach((text, index) => {
      timers.push(
        window.setTimeout(() => emitAi({ requestId, kind: 'delta', text }), 40 * (index + 1))
      )
    })
    timers.push(
      window.setTimeout(() => {
        pending.delete(requestId)
        emitAi({ requestId, kind: 'done' })
        finish()
      }, 40 * (chunks.length + 1))
    )

    pending.set(requestId, { timers, finish })
  })
}

/* ------------------------------------------------------------------ *
 * 桩本体
 * ------------------------------------------------------------------ */

let stubConfig: AppConfig = JSON.parse(JSON.stringify(DEFAULT_CONFIG)) as AppConfig

function createApi(): AppApi {
  return {
    runtime: async () => stubRuntime(),
    doctor: async () => buildDoctor(),
    openLogs: async () => {
      emitLog('stub', '浏览器预览模式没有日志文件，日志只显示在底部输出面板', 'warn')
      return '(浏览器预览模式：无日志文件)'
    },

    getConfig: async () => stubConfig,
    setConfig: async (patch: Partial<AppConfig>) => {
      stubConfig = { ...stubConfig, ...patch }
      emitLog('config', '配置已在内存中更新（浏览器预览模式，不落盘）')
      return stubConfig
    },

    openWorkspace: async (preset?: string) => {
      const input = window.prompt('浏览器预览模式：输入要打开的虚拟目录', preset || DEMO_ROOT)
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

    aiChat: async (requestId: string, messages: ChatMessage[]) => streamReply(requestId, messages),

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
    onMenu: (cb) => subscribe(menuListeners, cb)
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
