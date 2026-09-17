/**
 * 护栏：分块读取文件时必须用 StringDecoder。
 *
 * ## 为什么需要它
 *
 * 按固定大小（本项目是 64KB）分块读文件时，块边界会**切断 UTF-8 多字节字符**
 * （一个汉字 3 字节）。对每一块直接 `.toString('utf8')` 的话，
 * 被切断的两半会各自解出一个 U+FFFD（�），于是文件内容出现乱码。
 *
 * 实测：把 `中` 摆在 65534 字节处（占 65534/65535/65536），
 * 64KB 分块直接 toString 会得到 **2 处乱码**，而全篇没有别的错。
 *
 * ## 为什么这条值得单独一道护栏
 *
 * 后果不只是显示难看：这是给 AI 读代码的通道，而模型会**照着读到的内容写回去**。
 * 一旦读到乱码，它会把乱码当成"原文件就是这样"，于是把学生源码里的中文
 * 永久改坏。中文教学场景下这是最高频的路径。
 *
 * 而且这个 bug 极容易复现、也极容易被重新引入 —— 写分块读取的人
 * 十有八九会顺手写 `chunk.toString('utf8')`。项目里
 * `exec.ts` 早就为此写了注释，`file-tools.ts` 却漏了，正是"靠注释拦不住"的例子。
 *
 * ## 检查方式
 *
 * 找同时出现「分块读」（handle.read / createReadStream / 'data' 事件）
 * 与 `.toString('utf8')` 的文件，要求它 import 了 StringDecoder。
 *
 * 允许的例外：一次性把整个文件读进内存的场景（`fsp.readFile`）没有分块问题，
 * 但那种情况不会出现 handle.read，自然不在检查范围。
 */
import fs from 'node:fs'
import path from 'node:path'

const ROOTS = ['src/main']

/** 出现这些就说明在分块读 */
const CHUNKED = [/handle\.read\s*\(/, /createReadStream\s*\(/, /\.on\(\s*['"]data['"]/]
/** 危险写法 */
const RAW_DECODE = /\.toString\(\s*['"]utf8['"]\s*\)/

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(full, out)
    else if (/\.(ts|tsx)$/.test(entry.name)) out.push(full)
  }
  return out
}

/** 去掉注释，避免说明文字里的示例被当成真实代码 */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1) => p1 + ' '.repeat(m.length - p1.length))
}

const files = ROOTS.flatMap((r) => walk(r))
const problems = []

for (const file of files) {
  const raw = fs.readFileSync(file, 'utf8')
  const code = stripComments(raw)
  const chunked = CHUNKED.some((re) => re.test(code))
  if (!chunked) continue
  if (!RAW_DECODE.test(code)) continue
  // 分块 + 裸 toString：必须同时 import 了 StringDecoder 才算安全
  const usesDecoder = /StringDecoder/.test(code)
  if (!usesDecoder) {
    problems.push(file)
  }
}

if (problems.length > 0) {
  console.error('')
  console.error('[utf8-check] 这些文件在分块读取，却对块直接 toString(\'utf8\')：')
  for (const p of problems) console.error(`  - ${p}`)
  console.error('')
  console.error('[utf8-check] 块边界会切断 UTF-8 多字节字符（汉字 3 字节），')
  console.error('[utf8-check] 两半各自解出 U+FFFD（�），中文内容出现乱码。')
  console.error('[utf8-check] 而 AI 会照着乱码写回去，把学生源码改坏。')
  console.error('[utf8-check] 修法：import { StringDecoder } from \'node:string_decoder\'，')
  console.error('[utf8-check]       用 decoder.write(chunk) 代替 chunk.toString(\'utf8\')，')
  console.error('[utf8-check]       收尾时 decoder.end()。参考 tools/exec.ts。')
  console.error('')
  process.exit(1)
}

console.log(`[utf8-check] 通过，已扫描 ${files.length} 个主进程文件（分块解码均用 StringDecoder）`)
