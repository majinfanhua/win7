/**
 * editFile 宽容匹配级联的离线校验。
 *
 * 为什么单独一个脚本：这套级联是纯字符串算法，跑起来不需要窗口、不需要
 * 文件系统、不需要 AI —— 但它的分支很多（4 级匹配 × 是否 replaceAll ×
 * CRLF/LF × BOM），靠手点界面根本覆盖不到。放进 smoke 又会被窗口的不稳定
 * 拖累。所以单独一个纯 Node 脚本，几毫秒跑完，改坏了立刻能发现。
 *
 * 用法：npm run check:editmatch
 *
 * 编译方式：直接用 esbuild（vite 的依赖里带）把 TS 转成 CJS 再 require，
 * 避免为了一个测试引入 ts-node / tsx 这类额外工具链。
 */
import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const require = createRequire(import.meta.url)

let failures = 0
function check(name, ok, detail = '') {
  console.log(`${ok ? '通过' : '失败'}  ${name}${detail ? `  ${detail}` : ''}`)
  if (!ok) failures += 1
}

/** 把 TS 源码就地编译成 CJS 再加载 */
async function loadModule() {
  const esbuild = require('esbuild')
  const source = path.join(root, 'src/main/tools/edit-match.ts')
  const code = fs.readFileSync(source, 'utf8')
  const out = esbuild.transformSync(code, { loader: 'ts', format: 'cjs', target: 'node16' })
  const tmp = path.join(os.tmpdir(), `edit-match-${process.pid}.cjs`)
  fs.writeFileSync(tmp, out.code)
  const mod = require(tmp)
  fs.rmSync(tmp, { force: true })
  return mod
}

const { findEditMatches, applyEditReplacements } = await loadModule()

/** 跑一次替换，返回 [结果文本, 策略, 替换处数]；匹配不上返回 null */
function run(text, oldString, newString, replaceAll = false) {
  const outcome = findEditMatches(text, oldString, newString)
  if (!outcome) return null
  const used = replaceAll ? outcome.replacements : outcome.replacements.slice(0, 1)
  return [applyEditReplacements(text, used), outcome.strategy, outcome.replacements.length]
}

function eq(actual, expected) {
  return JSON.stringify(actual) === JSON.stringify(expected)
}

function failure(name, actual, expected) {
  check(name, false, `期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`)
}

/* ── 1. 精确匹配：历史行为不能变 ───────────────────────────── */
{
  const r = run('let x = 1;\nlet y = 2;\n', 'x = 1', 'x = 9')
  eq(r, ['let x = 9;\nlet y = 2;\n', 'exact', 1])
    ? check('精确匹配：逐字节替换', true)
    : failure('精确匹配：逐字节替换', r, ['let x = 9;\nlet y = 2;\n', 'exact', 1])
}

/* ── 2. 行尾符：CRLF 文件配 LF 的 oldString ────────────────── */
{
  const text = 'a\r\nb\r\nc\r\n'
  const r = run(text, 'b\nc', 'B\nC')
  // 文件是 CRLF，替换文本必须重新渲染回 CRLF，否则会留下 \r\r\n
  r && r[0] === 'a\r\nB\r\nC\r\n' && r[1] === 'line-endings'
    ? check('行尾符：CRLF 文件接受 LF 的 oldString 并保持 CRLF', true)
    : failure('行尾符：CRLF 文件接受 LF 的 oldString 并保持 CRLF', r, [
        'a\r\nB\r\nC\r\n',
        'line-endings',
        1
      ])
}

/* ── 3. 行尾符：LF 文件配 CRLF 的 oldString ────────────────── */
{
  const r = run('a\nb\nc\n', 'b\r\nc', 'B\nC')
  r && r[0] === 'a\nB\nC\n' && r[1] === 'line-endings'
    ? check('行尾符：LF 文件接受 CRLF 的 oldString', true)
    : failure('行尾符：LF 文件接受 CRLF 的 oldString', r, ['a\nB\nC\n', 'line-endings', 1])
}

/* ── 4. BOM：带 BOM 的文件、不带 BOM 的 oldString ──────────── */
{
  const r = run('\u{feff}hello\nworld\n', 'hello', 'HELLO')
  r && r[0] === '\u{feff}HELLO\nworld\n'
    ? check('BOM：忽略 BOM 匹配且保留 BOM', true)
    : failure('BOM：忽略 BOM 匹配且保留 BOM', r, ['\u{feff}HELLO\nworld\n', 'line-endings', 1])
}

/* ── 5. 行尾空白：模型少给了行尾空格 ───────────────────────── */
{
  const text = 'def f():   \n    return 1  \n'
  const r = run(text, 'def f():\n    return 1', 'def f():\n    return 2')
  r && r[1] === 'trailing-whitespace' && r[0] === 'def f():\n    return 2\n'
    ? check('行尾空白：忽略行尾空白后匹配', true)
    : failure('行尾空白：忽略行尾空白后匹配', r, ['def f():\n    return 2\n', 'trailing-whitespace', 1])
}

/* ── 6. 缩进：整段多一级缩进，替换后应贴合文件缩进 ─────────── */
{
  // 文件整体比模型给的缩进多 4 空格（每一行都多同样的 4 空格）——
  // 这才是「统一偏移」。注意相对缩进必须一致：
  // 文件 4/8，模型给 0/4，两行都差 4，平移成立。
  const text = 'if x:\n    a = 1\n    b = 2\n'
  const r = run(text, 'a = 1\nb = 2', 'a = 9\nb = 9')
  // 期望：替换文本被加上 4 空格前缀，变成 4 空格缩进，与文件一致
  r && r[1] === 'indentation' && r[0] === 'if x:\n    a = 9\n    b = 9\n'
    ? check('缩进：统一偏移后匹配，且替换文本按文件缩进重排', true)
    : failure('缩进：统一偏移后匹配，且替换文本按文件缩进重排', r, [
        'if x:\n    a = 9\n    b = 9\n',
        'indentation',
        1
      ])
}

/* ── 6b. 相对缩进不一致时必须拒绝（这是上面那个例子的反面）───── */
{
  // 文件 8/16，模型给 4/8 —— 虽然「看起来」都是差一级，
  // 但两行的绝对偏移不同（+4 与 +8），不是一个整块平移。
  // 这种情况必须拒绝：硬套一个前缀会把代码结构改错。
  const text = 'class A:\n        def f(self):\n                return 1\n'
  const r = run(text, '    def f(self):\n        return 1', '    def f(self):\n        return 2')
  r === null
    ? check('缩进：相对缩进不一致时拒绝（平移不成立）', true)
    : failure('缩进：相对缩进不一致时拒绝（平移不成立）', r, null)
}

/* ── 7. 缩进偏移不统一时必须拒绝，不能瞎猜 ─────────────────── */
{
  // 两行缩进差异不一致：一行差 4 空格，另一行差 0 —— 不是整块平移
  const text = 'x\n        a\nb\n'
  const r = run(text, '    a\n    b', 'q\nq')
  r === null
    ? check('缩进：偏移不统一时拒绝匹配（不瞎猜）', true)
    : failure('缩进：偏移不统一时拒绝匹配（不瞎猜）', r, null)
}

/* ── 8. 完全对不上时返回 null，交给上层报错 ────────────────── */
{
  const r = run('hello\n', '完全不存在的内容', 'x')
  r === null
    ? check('无匹配：返回 null 而不是乱改', true)
    : failure('无匹配：返回 null 而不是乱改', r, null)
}

/* ── 9. 空 oldString 拒绝（否则会在每个位置插入）──────────── */
{
  const r = run('hello\n', '', 'x')
  r === null
    ? check('空 oldString：拒绝匹配', true)
    : failure('空 oldString：拒绝匹配', r, null)
}

/* ── 10. replaceAll：多处替换 ─────────────────────────────── */
{
  const r = run('a\nb\na\nb\n', 'a\nb', 'Z', true)
  r && r[0] === 'Z\nZ\n' && r[2] === 2
    ? check('replaceAll：替换全部出现处', true)
    : failure('replaceAll：替换全部出现处', r, ['Z\nZ\n', 'exact', 2])
}

/* ── 11. 单处模式下多匹配时不静默改第一个 ──────────────────── */
{
  // 级联本身会返回 2 处；由上层判断 count>1 && !replaceAll 后报错。
  // 这里确认级联如实报出 2，不被悄悄截断成 1。
  const outcome = findEditMatches('a\na\n', 'a', 'b')
  outcome && outcome.replacements.length === 2
    ? check('多处匹配：级联如实报出 2 处（由上层决定是否拒绝）', true)
    : failure('多处匹配：级联如实报出 2 处（由上层决定是否拒绝）', outcome?.replacements.length, 2)
}

/* ── 12. 级联优先级：更严格的解释优先 ──────────────────────── */
{
  // 这段既能精确匹配，也「差一点」能按行尾空白匹配 —— 必须走 exact
  const r = run('a = 1\n', 'a = 1', 'a = 2')
  r && r[1] === 'exact'
    ? check('优先级：能精确匹配时不会降级到宽容匹配', true)
    : failure('优先级：能精确匹配时不会降级到宽容匹配', r?.[1], 'exact')
}

/* ── 13. 替换区间非法时必须抛错，不能写出坏内容 ────────────── */
{
  let threw = false
  try {
    applyEditReplacements('abc', [{ start: 2, end: 1, text: 'x' }])
  } catch {
    threw = true
  }
  threw
    ? check('非法区间：抛错而不是静默写坏', true)
    : check('非法区间：抛错而不是静默写坏', false, '没有抛错')
}

/* ── 14. 中文与 emoji 不能被切坏（UTF-16 码元边界）──────────── */
{
  const r = run('const s = "中文🎉测试"\n', '"中文🎉测试"', '"改过了"')
  r && r[0] === 'const s = "改过了"\n'
    ? check('多字节：中文与 emoji 替换后不乱码', true)
    : failure('多字节：中文与 emoji 替换后不乱码', r?.[0], 'const s = "改过了"\n')
}

/* ── 15. 文件末尾无换行的整行替换 ──────────────────────────── */
{
  const r = run('a\nb', 'a\nb', 'Z')
  r && r[0] === 'Z' && r[1] !== undefined
    ? check('末尾无换行：整行替换不额外补换行', true)
    : failure('末尾无换行：整行替换不额外补换行', r, ['Z', r?.[1], 1])
}

console.log(failures === 0 ? '\nEdit 匹配级联校验：全部通过' : `\nEdit 匹配级联校验：${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)
