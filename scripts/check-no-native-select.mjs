/**
 * 禁止在渲染层使用原生 `<select>` 的护栏。
 *
 * ## 为什么需要它
 *
 * 原生 `<select>` 的**展开列表由操作系统绘制**，CSS 完全管不到。
 * 在 Windows 7 上这一点尤其致命：即使声明了 `color-scheme: dark`，
 * 系统主题引擎仍然把列表画成**白底**，而选项文字继承我们设的浅色变量 ——
 * 结果是「深色模式下下拉文字看不见」。
 *
 * 这个问题的麻烦之处在于**开发机上复现不了**：
 * Chromium 108 在 Linux 上渲染的 `option` 是深色（实测 `rgb(23,27,34)`），
 * 所以本地怎么试都是好的，只有到 Win7 真机上才暴露。
 * 历史上已经为此打过两次补丁（explorer.css 里的 `option` 配色、
 * 以及各处对 `select` 的去边框覆盖），都没有治本 ——
 * 因为改不动「列表背景由系统画」这件事。
 *
 * 所以现在统一用自绘的 `components/ui/Select.tsx`，并用这道护栏
 * 防止以后有人图省事又写回原生标签。
 *
 * ## 只扫 JSX 标签
 *
 * 只匹配真实的 `<select` 标签起始，不匹配注释或字符串里提到它 ——
 * 说明性文字（比如「不用原生 select」这类注释）到处都是，
 * 误报会让护栏失去信任，所以这里匹配得很窄。
 */
import fs from 'node:fs'
import path from 'node:path'

const ROOT = 'src/renderer'

/**
 * 允许出现的例外。
 *
 * 目前为空：全部换成自绘组件了。
 * 如果将来某处确实必须用原生（例如需要系统级的首字母跳转），
 * 在这里登记并写明理由 —— 让例外是**显式且可审计**的，
 * 而不是悄悄出现。
 */
const ALLOWED = []

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(full, out)
    else if (/\.tsx?$/.test(entry.name)) out.push(full)
  }
  return out
}

const files = walk(ROOT)
const problems = []

/**
 * 去掉注释，只留真实代码。
 *
 * ⚠️ 这一步是**必须的**，而且第一版写错过：当时只按「行首是不是 * 或 //」
 * 排除，结果 `⚠️ 这里原来用**原生 <select>**` 这种**块注释里的普通行**
 * （不以 * 开头）被误报了 —— 而那正是我自己写的说明文字。
 * 误报会让护栏失去信任，所以改成先整体剥注释再逐行扫。
 *
 * 用占位符替换而不是直接删：保留换行与列数，报错时的行号仍然准。
 */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/\/\/[^\n]*/g, (m) => ' '.repeat(m.length))
}

for (const file of files) {
  const src = fs.readFileSync(file, 'utf8')
  const code = stripComments(src)
  const lines = code.split('\n')
  lines.forEach((line, i) => {
    /*
     * 只看真实代码里有没有 `<select`。
     * `<Select`（自绘组件，大写 S）不会命中 —— 这里区分大小写。
     */
    if (!/<select[\s>]/.test(line)) return
    if (ALLOWED.some((a) => file.endsWith(a.file))) return
    problems.push(`${file}:${i + 1}  ${src.split('\n')[i].trim().slice(0, 70)}`)
  })
}

if (problems.length > 0) {
  console.error('')
  console.error('[select-check] 渲染层出现了原生 <select>：')
  for (const p of problems) console.error(`  - ${p}`)
  console.error('')
  console.error('[select-check] 原生下拉的展开列表由操作系统绘制，CSS 改不到它。')
  console.error('[select-check] 在 Windows 7 上深色模式会白底浅字（开发机上复现不了）。')
  console.error('[select-check] 请改用 components/ui/Select.tsx：')
  console.error('[select-check]   <Select value={v} options={[{value,label}]} onChange={fn} ariaLabel="..." />')
  console.error('')
  process.exit(1)
}

console.log(`[select-check] 通过，已扫描 ${files.length} 个渲染层文件（无原生 <select>）`)
