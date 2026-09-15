import type { FileNode } from '@shared/types'

/**
 * 浏览器预览模式的内存虚拟文件系统。
 *
 * 从 dev-api-stub.ts 里拆出来（那个文件已经 780 行，逼近 800 行红线）。
 * 拆的边界很干净：**这里只管「路径 → 内容」这层数据**，
 * 不碰任何事件派发、不 import API 类型、不知道 AppApi 的存在。
 * 上面那层（dev-api-stub.ts）负责把这里的操作翻译成 Promise 并广播日志。
 *
 * 为什么用 Map 而不是对象：路径要在遍历时保持插入顺序，
 * 而且 Map 的 keys() 是迭代器，读目录时不用先 Object.keys 复制一份。
 */

/** 演示工作区的根路径。用 `/demo` 而不是真实磁盘路径，一眼能看出是虚拟的 */
export const DEMO_ROOT = '/demo'

/** 内置示例文件。内容是刻意的教学素材，不是随手占位 */
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

  [`${DEMO_ROOT}/data/scores.json`]: ['{', '  "class": "初一(2)班",', '  "scores": [90, 85, 77, 96]', '}'].join('\n')
}

/** 文件表：路径 → 内容 */
export const files = new Map<string, string>(Object.entries(DEMO_FILES))
/** 目录集合。新建空目录时往这里加（文件表里可能一个文件都没有） */
export const dirs = new Set<string>()

/** 把反斜杠统一成正斜杠、去掉结尾斜杠。空串归一成根 */
export function normalize(p: string): string {
  const s = p.replace(/\\/g, '/').replace(/\/+$/, '')
  return s === '' ? '/' : s
}

/** 取父目录。已经在根时返回根，不会返回空串 */
export function parentOf(p: string): string {
  const idx = p.lastIndexOf('/')
  return idx <= 0 ? '/' : p.slice(0, idx)
}

/** 取末级名字。给「移动」用（目标路径 = 目标目录 + 原名） */
export function baseNameOf(p: string): string {
  const idx = p.lastIndexOf('/')
  return idx < 0 ? p : p.slice(idx + 1)
}

/** 拼一个子路径 */
export function joinPath(base: string, name: string): string {
  return base === '/' ? `/${name}` : `${base}/${name}`
}

/** 把某条路径上的所有祖先目录补进 dirs（文件表里有深层文件时用） */
export function ensureParents(p: string): void {
  let cur = parentOf(normalize(p))
  while (cur !== '/' && cur !== '') {
    dirs.add(cur)
    cur = parentOf(cur)
  }
}

// 初始文件都已在 files 里，但 dirs 还是空的 —— 这里补一遍，
// 否则 readDir('/demo') 会认得文件、却认不出 `src` 与 `data` 这两个目录
for (const key of files.keys()) ensureParents(key)

/**
 * 桩里的 mtime。
 *
 * 内存文件系统没有真实时间戳，用一个稳定的伪值（按路径哈希）代替：
 * 目的是让「按修改时间排序」这条路径在浏览器预览里能真的排序，
 * 而不是所有项都拿到 0、看起来像没生效。用哈希而不是 Date.now()，
 * 是因为后者每次 readDir 都变，列表会一直抖。
 */
export function stubMtime(path: string): number {
  let hash = 0
  for (let i = 0; i < path.length; i += 1) hash = (hash * 31 + path.charCodeAt(i)) % 100000
  return hash * 1000
}

/**
 * 读一层目录。文件夹优先 + 名称序，与主进程 wsReadDir 的排序保持一致 ——
 * 两边不一致的话，浏览器预览与真机会呈现不同的顺序，很难判断是哪边的问题。
 */
export function readDirSync(dir: string): FileNode[] {
  const base = normalize(dir)
  const prefix = base === '/' ? '/' : `${base}/`
  const out = new Map<string, FileNode>()

  for (const [p, content] of files) {
    if (!p.startsWith(prefix)) continue
    const rest = p.slice(prefix.length)
    const slash = rest.indexOf('/')
    if (slash === -1) {
      out.set(rest, { name: rest, path: p, kind: 'file', size: content.length, mtime: stubMtime(p) })
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
