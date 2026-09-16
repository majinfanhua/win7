/**
 * 渲染层 CSS 的 Chromium 108 边界检查。
 *
 * 背景（这道护栏是怎么来的）：
 *   打包版的渲染进程跑在 Electron 22 内置的 Chromium **108** 上，
 *   而 `electron.vite.config.ts` 里写的 `build.target: 'chrome108'` 只约束 **JS** ——
 *   它交给 esbuild 做语法降级，降不了就报错。CSS 不在这条链路上：
 *   esbuild 对 CSS 的属性/at-rule 支持度**不做任何目标校验**，
 *   实测 `color-mix()`、`@container`、`light-dark()` 在 `--target=chrome108`
 *   下既不报错也不告警，原样输出。
 *
 *   后果正是最该防的那类偏差：用浏览器打开 5173（跑在最新 Chrome 上）看着一切正常，
 *   打包发到 Win7 后属性被静默丢弃 —— 没有报错、没有白屏，只是"样式没生效"。
 *
 * 所以这里用静态扫描补上这道防线：出现 Chromium 108 之后才支持的 CSS 特性，
 * 构建直接失败，而不是等真机上肉眼看出来。
 *
 * 只扫描 CSS 文件（`src/renderer` 下的 .css）。
 * 允许清单里的特性都是 108 及以前就有的，不要因为"看起来新"就加进来。
 */
import fs from 'node:fs'
import path from 'node:path'

const ROOT = 'src/renderer'

/**
 * 每个特性的支持版本都注明了来源版本号。
 * 只列**确认晚于 Chromium 108** 的，宁少勿多 —— 误报会让护栏失去信任。
 */
const BANNED = [
  [/color-mix\s*\(/, 'color-mix()（Chromium 111+）'],
  [/(?<![\w-])oklch\s*\(/, 'oklch() 颜色空间（Chromium 111+）'],
  [/(?<![\w-])oklab\s*\(/, 'oklab() 颜色空间（Chromium 111+）'],
  [/light-dark\s*\(/, 'light-dark()（Chromium 123+）'],
  [/(^|[\s,{])&(?=[\s.:,>+~[#&])/m, 'CSS 嵌套的 & 选择器（Chromium 112+），现在请写完整的后代选择器'],
  [/text-wrap\s*:\s*(balance|pretty)/, 'text-wrap: balance/pretty（Chromium 114/117+）'],
  [/grid-template-(columns|rows)\s*:\s*subgrid/, 'grid subgrid（Chromium 117+）'],
  [/@scope\b/, '@scope（Chromium 118+）'],
  [/@starting-style\b/, '@starting-style（Chromium 117+）'],
  [/@position-try\b/, '@position-try（Chromium 125+）'],
  [/(?<![\w-])anchor\s*\(/, 'anchor() 定位（Chromium 125+）'],
  [/field-sizing\s*:/, 'field-sizing（Chromium 123+）'],
  [/(interpolate-size|calc-size)\s*[:(]/, 'interpolate-size / calc-size()（Chromium 129+）'],
  [/view-transition-name\s*:/, 'view-transition-name（Chromium 111+）'],
  [/text-box-(trim|edge)\s*:/, 'text-box-trim / text-box-edge（Chromium 133+）'],
  [/@container\s+style\s*\(/, '@container 样式查询（Chromium 111+；尺寸查询 105 可用）'],
  [/@media\s*\(\s*scripting\s*\)/, '@media (scripting)（Chromium 120+）'],
  [/:nth-(child|last-child)\s*\([^)]*\bof\b/, ':nth-child(An+B of S)（Chromium 111+）'],
  [/(?<![\w-])(round|mod|rem)\s*\(/, 'CSS round()/mod()/rem() 数学函数（Chromium 125+）']
]

/** 去掉注释，避免文档里提到某个特性就误报 */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ')
}

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(full, out)
    else if (entry.name.endsWith('.css')) out.push(full)
  }
  return out
}

const files = walk(ROOT)
const problems = []

for (const file of files) {
  const lines = stripComments(fs.readFileSync(file, 'utf8')).split('\n')
  lines.forEach((line, index) => {
    for (const [pattern, label] of BANNED) {
      if (pattern.test(line)) problems.push(`${file}:${index + 1}  使用了 ${label}`)
    }
  })
}

if (problems.length > 0) {
  console.error('')
  console.error('[css108-check] 渲染层 CSS 里出现了 Chromium 108 不支持的特性：')
  for (const p of problems) console.error(`  - ${p}`)
  console.error('')
  console.error('[css108-check] 打包版内置 Chromium 108（Electron 22）。')
  console.error('[css108-check] 这些写法在开发浏览器里正常，到 Win7 上会被静默丢弃。')
  console.error('[css108-check] 注意 build.target=chrome108 只管 JS，管不了 CSS —— 这道护栏就是补这个洞。')
  console.error('')
  process.exit(1)
}

console.log(`[css108-check] 通过，已扫描 ${files.length} 个 CSS 文件`)
