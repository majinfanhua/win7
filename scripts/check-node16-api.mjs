/**
 * Node 16 API 边界检查。
 *
 * 背景：主进程跑在 Electron 22 内置的 Node 16.17.1 上，
 * 而构建工具链要求 @types/node >= 18（vite 的 peer 依赖），
 * 因此类型层面守不住「误用 Node 18+ 才有的 API」。
 *
 * 这里用静态扫描补上这道防线：一旦主进程代码里出现 Node 16 没有的全局 API，
 * 构建直接失败，而不是等到 Win7 真机上运行时才报错。
 *
 * 只扫描 src/main 与 src/shared（这两处跑在 Node 16 环境）；
 * src/renderer 跑在 Chromium 108，不受此限。
 */
import fs from 'node:fs'
import path from 'node:path'

const ROOTS = ['src/main', 'src/shared']

/** [正则, 说明] */
const BANNED = [
  [/\bfetch\s*\(/, 'fetch（Node 18+ 才有，改用 Electron net 模块）'],
  [/\bstructuredClone\s*\(/, 'structuredClone（Node 17+ 才有）'],
  [/\bObject\.groupBy\s*\(/, 'Object.groupBy（Node 21+ 才有）'],
  [/\.findLast(Index)?\s*\(/, 'Array.findLast / findLastIndex（Node 18+ 才有）'],
  [/\bAbortSignal\.timeout\s*\(/, 'AbortSignal.timeout（Node 17.3+ 才有）'],
  [/\bfs\.statfs(Sync)?\s*\(/, 'fs.statfs（Node 18.15+ 才有）'],
  [/\bnew\s+FormData\s*\(/, 'FormData 全局（Node 18+ 才有）'],
  [/\bnew\s+Response\s*\(/, 'Response 全局（Node 18+ 才有）'],
  [/\bnew\s+Headers\s*\(/, 'Headers 全局（Node 18+ 才有）'],
  [/\bimport\s*\(\s*['"]node:test['"]/, 'node:test（Node 18+ 才有）'],
  [/require\(\s*['"]node:test['"]/, 'node:test（Node 18+ 才有）']
]

/** 去掉注释和字符串字面量，避免文档里提到 fetch 就误报 */
function stripNoise(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')
    .replace(/'(\\.|[^'\\])*'/g, "''")
    .replace(/"(\\.|[^"\\])*"/g, '""')
    .replace(/`(\\.|[^`\\])*`/g, '``')
}

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(full, out)
    else if (/\.(ts|tsx|mts|cts)$/.test(entry.name)) out.push(full)
  }
  return out
}

const files = ROOTS.flatMap((root) => walk(root))
const problems = []

for (const file of files) {
  const lines = stripNoise(fs.readFileSync(file, 'utf8')).split('\n')
  lines.forEach((line, index) => {
    for (const [pattern, label] of BANNED) {
      if (pattern.test(line)) problems.push(`${file}:${index + 1}  使用了 ${label}`)
    }
  })
}

if (problems.length > 0) {
  console.error('')
  console.error('[node16-check] 主进程代码中出现了 Node 16 不支持的 API：')
  for (const p of problems) console.error(`  - ${p}`)
  console.error('')
  console.error('[node16-check] Electron 22 内置 Node 16.17.1，这些 API 在 Win7 上会直接报错。')
  console.error('')
  process.exit(1)
}

console.log(`[node16-check] 通过，已扫描 ${files.length} 个文件`)
