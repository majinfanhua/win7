/**
 * 护栏：聊天正文的换行清理。
 *
 * ## 为什么需要它
 *
 * 一次带工具的回答是**好几轮拼起来**的，每轮正文模型都习惯带一两个换行。
 * 不清理的话「每执行一次工具，气泡就多一片空白」，正文被越推越远 ——
 * 这正是用户看到的「AI 执行了查看命令，聊天气泡就换一个行，
 * 再执行一个又换了一行」。
 *
 * ## 为什么单独一个脚本
 *
 * `shared/chat-text.ts` 是纯函数，没有依赖，但它有三条**很容易写错**的规则：
 *   1. 只能压「连续空行」，不能把空行全删掉 —— 模型用空行分段是有意义的排版
 *   2. 只能动**行尾**空白，动行首就把 AI 给的代码缩进改坏了，
 *      而且这个结果会存进会话记录，改坏了会一直留在历史里
 *   3. 必须幂等 —— 显示路径与落盘路径都会调它，同一段文本可能被处理两次
 *
 * 三条都属于「看起来对、实际错」的写法，而且错了以后在界面上很难一眼看出来
 * （只是空白多寡的差别）。所以钉在测试里。
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

function loadModule() {
  const esbuild = require('esbuild')
  const source = path.join(root, 'src/shared/chat-text.ts')
  const code = esbuild.transformSync(fs.readFileSync(source, 'utf8'), {
    loader: 'ts',
    format: 'cjs',
    target: 'node16'
  }).code
  const tmp = path.join(os.tmpdir(), `chat-text-${process.pid}.cjs`)
  fs.writeFileSync(tmp, code)
  const mod = require(tmp)
  fs.rmSync(tmp, { force: true })
  return mod
}

const { normalizeChatText, isBlankChatText } = loadModule()

/** 把结果里的换行写成可见形式，失败时能一眼看出差在哪 */
const show = (s) => JSON.stringify(s)

/* ── 1. 用户报的那个场景：每轮都带换行，拼起来一片空白 ───────── */
{
  // 三轮正文，每轮前后各带换行 —— 工具调用的典型形态
  const joined = '我先读一下这个文件。\n\n' + '\n接下来改第 12 行。\n\n' + '\n\n改好了。'
  const out = normalizeChatText(joined)
  check(
    '多轮拼接：连续空行被压成一个',
    out === '我先读一下这个文件。\n\n接下来改第 12 行。\n\n改好了。',
    show(out)
  )
  // 修复前的样子：4 个换行连在一起
  check('多轮拼接：不再出现 3 个以上连续换行', !/\n{3,}/.test(out), show(out))
}

/* ── 2. 正常的空行分段必须保留 ─────────────────────────────── */
{
  const out = normalizeChatText('第一段\n\n第二段')
  check('单个空行分段被保留', out === '第一段\n\n第二段', show(out))
}

/* ── 3. 行首缩进绝不能动（这是代码）───────────────────────── */
{
  const code = '```\nif (a) {\n    return 1\n}\n```'
  const out = normalizeChatText(code)
  check('行首缩进原样保留', out.includes('\n    return 1'), show(out))
}

/* ── 4. 行尾空白要去掉 ────────────────────────────────────── */
{
  const out = normalizeChatText('一行   \n二行\t\t\n三行')
  check('行尾空格与制表符被去掉', out === '一行\n二行\n三行', show(out))
}

/* ── 5. 首尾空行去掉（气泡有自己的内边距）────────────────── */
{
  const out = normalizeChatText('\n\n正文\n\n\n')
  check('首尾空行被去掉', out === '正文', show(out))
}

/* ── 6. CRLF 统一 ─────────────────────────────────────────── */
{
  const out = normalizeChatText('一行\r\n二行\r三行')
  check('CRLF / CR 统一成 LF', out === '一行\n二行\n三行', show(out))
}

/* ── 7. 幂等：显示路径与落盘路径都会调它 ───────────────────── */
{
  const raw = '\n\n甲\n\n\n\n乙  \r\n\n丙\n\n'
  const once = normalizeChatText(raw)
  const twice = normalizeChatText(once)
  check('幂等：跑两次结果一致', once === twice, `${show(once)} vs ${show(twice)}`)
}

/* ── 8. 只吐换行的那一轮，清理后是空串 ─────────────────────── */
{
  const out = normalizeChatText('\n\n\n')
  check('纯换行输入 → 空串（不撑出空行）', out === '', show(out))
  check('空输入 → 空串', normalizeChatText('') === '', show(normalizeChatText('')))
  check('undefined 不炸', normalizeChatText(undefined) === '', show(normalizeChatText(undefined)))
}

/* ── 9. isBlankChatText 的判定 ─────────────────────────────── */
{
  check('空白文本被判定为空', isBlankChatText('  \n\t\n ') === true)
  check('有内容的文本不被判定为空', isBlankChatText('a') === false)
}

/* ── 10. 正文里的代码块不该被压坏 ──────────────────────────── */
{
  // 代码里连续两个空行是有意的（分隔函数），最多压成一个空行
  const code = '```js\nconst a = 1\n\n\n\nconst b = 2\n```'
  const out = normalizeChatText(code)
  check('代码块内的连续空行也被压（最多一个空行）', out === '```js\nconst a = 1\n\nconst b = 2\n```', show(out))
}

console.log(failures === 0 ? '\n聊天正文清理校验：全部通过' : `\n聊天正文清理校验：${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)
