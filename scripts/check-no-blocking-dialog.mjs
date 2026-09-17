/**
 * 护栏：禁止渲染层使用阻塞式原生弹窗。
 *
 * ## 为什么需要它
 *
 * Electron 里 `window.confirm` / `alert` / `prompt` 会**阻塞渲染进程**：
 * 弹出期间整个界面不响应，而且原生模态框会吞掉 `mouseup` ——
 * 渲染层于是认为鼠标一直按着，之后**点什么都点不中**（输入框也进不去），
 * 只能重启应用。
 *
 * 这个坑项目里踩过两次：
 *   1. `ConfirmDialog.tsx` 的文件头专门写明了这条，权限模式改用了自绘弹层
 *   2. 但**删除文件**和**未保存改动**两条路仍在用 `window.confirm` ——
 *      用户报的「删掉一个文件后输入框选不中，需要重启」正是它
 *
 * 第 2 次说明「写一条注释」是拦不住的：注释只有读那个文件的人才看得到，
 * 而新写代码的人不会去读。所以用这道静态扫描兜住。
 *
 * ## 允许的例外
 *
 * `dev-api-stub.ts` 里的 `window.prompt` 是有意的：它只在
 * **普通浏览器预览**下可达（Electron 里那份桩不会安装），
 * 而且代码里已经做了 `typeof === 'function'` 判断。
 * 这里用白名单显式登记，让例外可审计。
 */
import fs from 'node:fs'
import path from 'node:path'

const ROOT = 'src/renderer'

/** [正则, 说明] */
const BANNED = [
  [/\bwindow\.confirm\s*\(/, 'window.confirm（阻塞渲染进程，会吞 mouseup）'],
  [/\bwindow\.alert\s*\(/, 'window.alert（阻塞渲染进程）'],
  [/\bconfirm\s*\(\s*['"`]/, '裸 confirm（等同 window.confirm）'],
  [/\balert\s*\(\s*['"`]/, '裸 alert（等同 window.alert）']
]

/**
 * 允许出现的例外。
 *
 * 目前只有一处：浏览器预览桩里的 prompt。它：
 *   - 只在浏览器里可达（Electron 里这份桩不安装）
 *   - 已经用 `typeof window.prompt === 'function'` 判过
 * 注意 prompt 本身不在 BANNED 里 —— 它在 Electron 里根本不存在，
 * 误调会直接抛错、不会静默阻塞，风险形态与 confirm/alert 不同。
 */
const ALLOWED = [{ file: 'dev-api-stub.ts', why: '浏览器预览专用，已判 typeof' }]

/**
 * 去掉注释与字符串，避免文档/提示文案里提到这些词就误报。
 *
 * ⚠️ 这一步是必须的：这个仓库有大量中文注释解释「为什么不用 window.confirm」，
 * 不剥注释的话每一条说明都会被当成违规。第一次写这个护栏时就踩了
 * （与 check-no-native-select.mjs 同一个坑）。
 */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1) => p1 + ' '.repeat(m.length - p1.length))
}

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(full, out)
    else if (/\.(ts|tsx)$/.test(entry.name)) out.push(full)
  }
  return out
}

const files = walk(ROOT)
const problems = []

for (const file of files) {
  if (ALLOWED.some((a) => file.endsWith(a.file))) continue
  const raw = fs.readFileSync(file, 'utf8')
  const code = stripComments(raw)
  const lines = code.split('\n')
  lines.forEach((line, i) => {
    // 提示文案里可能出现这些词，用字符串占位后再扫（stripCode 已处理大部分）
    for (const [pattern, label] of BANNED) {
      if (pattern.test(line)) {
        problems.push(`${file}:${i + 1}  ${label}  →  ${raw.split('\n')[i].trim().slice(0, 60)}`)
      }
    }
  })
}

if (problems.length > 0) {
  console.error('')
  console.error('[dialog-check] 渲染层出现了阻塞式原生弹窗：')
  for (const p of problems) console.error(`  - ${p}`)
  console.error('')
  console.error('[dialog-check] Electron 里原生模态框会阻塞渲染进程并吞掉 mouseup，')
  console.error('[dialog-check] 之后整个界面点不中（含输入框），只能重启应用。')
  console.error('[dialog-check] 请改用：')
  console.error('[dialog-check]   要问用户   → store/confirm.ts 的 askConfirm / askUnsaved')
  console.error('[dialog-check]   只是通知   → useAppStore.getState().pushLog({...})')
  console.error('')
  process.exit(1)
}

console.log(`[dialog-check] 通过，已扫描 ${files.length} 个渲染层文件（无阻塞式原生弹窗）`)
