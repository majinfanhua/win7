/**
 * 工具调用参数截断守卫的离线校验。
 *
 * 这块逻辑的价值全在「区分四种流形态」上，而它们的最终字符串长得几乎一样：
 *
 *   1. 正常增量流     —— 分片拼起来是完整 JSON
 *   2. 累计快照流     —— 拼起来是坏的，但最后一片单独看是完整的
 *   3. 重复帧流       —— 同一份内容重复送，同样是最后一片完整
 *   4. 真截断         —— 拼起来坏，且没有任何单独一片完整
 *
 * 2/3 必须放行（误报会白白打断正常对话），4 必须拦住（漏报会让残缺参数
 * 被执行，可能改错文件）。两者的差别只体现在分片上，事后再看最终字符串
 * 是分不出来的 —— 所以只能靠这个脚本守住。
 *
 * 用法：npm run check:argguard
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

/**
 * 载入被测模块。
 *
 * argument-guard.ts 依赖 ../logger（会 import electron），
 * 纯 Node 下起不来，所以编译后把 logger 的 require 换成一个空壳。
 */
async function loadModule() {
  const esbuild = require('esbuild')
  const source = path.join(root, 'src/main/tools/argument-guard.ts')
  let code = esbuild.transformSync(fs.readFileSync(source, 'utf8'), {
    loader: 'ts',
    format: 'cjs',
    target: 'node16'
  }).code
  code = code.replace(/require\("\.\.\/logger"\)/g, '({logger:{warn(){},info(){},error(){},debug(){}}})')
  const tmp = path.join(os.tmpdir(), `arg-guard-${process.pid}.cjs`)
  fs.writeFileSync(tmp, code)
  const mod = require(tmp)
  fs.rmSync(tmp, { force: true })
  return mod
}

const { ToolArgumentTracker, parseStreamingJson } = await loadModule()

/** 按分片序列喂进 tracker，返回 report 结果 */
function feed(fragments) {
  const t = new ToolArgumentTracker()
  fragments.forEach((f, i) => t.noteDelta(0, f))
  const joined = fragments.join('')
  return { report: t.report([{ id: 'c1', function: { name: 'readFile', arguments: joined } }]), joined }
}

/* ── 1. 正常增量流：分片拼起来就是完整 JSON ───────────────── */
{
  const { report } = feed(['{"path":', '"a.txt"', '}'])
  check('正常增量流：不报截断', report.truncated.size === 0, `truncated=${report.truncated.size}`)
}

/* ── 2. 单帧整体送达（没有分片）──────────────────────────── */
{
  // 一片都没收到：参数是在 end 事件里整体给的，属正常形态
  const t = new ToolArgumentTracker()
  const report = t.report([{ id: 'c1', function: { name: 'readFile', arguments: '{"path":"a.txt"}' } }])
  check('无分片：不报截断（参数整体送达）', report.truncated.size === 0, `truncated=${report.truncated.size}`)
}

/* ── 3. 累计快照流：拼起来坏，但最后一片完整 ──────────────── */
{
  // 每片都是「到目前为止的完整内容」，拼起来是 `{}{"a":1}` 这种坏串
  const { report } = feed(['{"path":"a', '{"path":"a.txt"}'])
  check('累计快照流：不误报截断', report.truncated.size === 0, `truncated=${report.truncated.size}`)
}

/* ── 4. 重复帧流：同一份内容重复送 ────────────────────────── */
{
  const one = '{"path":"a.txt"}'
  const { report } = feed([one, one])
  check('重复帧流：不误报截断', report.truncated.size === 0, `truncated=${report.truncated.size}`)
}

/* ── 5. 真截断：停在字符串中间 ───────────────────────────── */
{
  // 这是最危险的一类：路径被切断，其余部分都合法
  const { report } = feed(['{"path":"C:\\\\Users\\\\'])
  check(
    '真截断（停在字符串中）：必须报截断',
    report.truncated.has('c1'),
    `truncated=${[...report.truncated].join(',') || '无'}`
  )
}

/* ── 6. 真截断：对象没闭合，但没有哪一片是完整的 ──────────── */
{
  const { report } = feed(['{"path":"a.txt"', ',"limit":10'])
  check(
    '真截断（对象未闭合）：必须报截断',
    report.truncated.has('c1'),
    `truncated=${[...report.truncated].join(',') || '无'}`
  )
}

/* ── 7. 空参数：不能当成截断 ─────────────────────────────── */
{
  // 无参工具（如 listSnapshots）的 arguments 就是空串，属正常
  const t = new ToolArgumentTracker()
  const report = t.report([{ id: 'c1', function: { name: 'listDir', arguments: '' } }])
  check('空参数：不报截断（无参工具是正常的）', report.truncated.size === 0)
}

/* ── 8. 没有任何一片完整时绝不"修复"放行 ─────────────────── */
{
  // 语义检查：残缺 buffer 能被补成合法 JSON，但正因为「补出来的」
  // 恰好等于最终参数，才判定为截断。这里确认补全确实发生了，
  // 而判定依然拦住它 —— 即「能修复」不等于「可以执行」。
  const repaired = parseStreamingJson('{"path":"a.txt"')
  check(
    '宽容修复确实能补全残缺 JSON（所以必须单独拦）',
    repaired !== null && repaired.path === 'a.txt',
    `repaired=${JSON.stringify(repaired)}`
  )
}

/* ── 9. parseStreamingJson：停在字符串中间不补 ────────────── */
{
  // 补一个引号能让它合法，但值可能与模型本意不同 —— 必须返回 null
  const r = parseStreamingJson('{"path":"C:\\\\Users\\\\')
  check('停在中途的字符串：不强行补全（返回 null）', r === null, `得到 ${JSON.stringify(r)}`)
}

/* ── 10. parseStreamingJson：悬空尾逗号要能收拾 ───────────── */
{
  const r = parseStreamingJson('{"a":1,')
  check('悬空尾逗号：补全为合法对象', r !== null && r.a === 1, `得到 ${JSON.stringify(r)}`)
}

/* ── 11. 嵌套结构补全 ────────────────────────────────────── */
{
  const r = parseStreamingJson('{"edits":[{"oldString":"a","newString":"b"}')
  check(
    '嵌套未闭合：能补全为合法对象',
    r !== null && Array.isArray(r.edits) && r.edits.length === 1,
    `得到 ${JSON.stringify(r)}`
  )
}

/* ── 12. 多个工具调用互不干扰 ────────────────────────────── */
{
  const t = new ToolArgumentTracker()
  t.noteDelta(0, '{"path":"a.txt"}')
  t.noteDelta(1, '{"path":"b')
  const report = t.report([
    { id: 'ok', function: { name: 'readFile', arguments: '{"path":"a.txt"}' } },
    { id: 'bad', function: { name: 'readFile', arguments: '{"path":"b' } }
  ])
  check(
    '多调用：只标记出有问题的那个',
    report.truncated.has('bad') && !report.truncated.has('ok'),
    `truncated=${[...report.truncated].join(',')}`
  )
}

/* ── 13. reset 后不残留上一轮的状态 ──────────────────────── */
{
  const t = new ToolArgumentTracker()
  t.noteDelta(0, '{"path":"broken')
  t.reset()
  t.noteDelta(0, '{"path":"a.txt"}')
  const report = t.report([{ id: 'c1', function: { name: 'readFile', arguments: '{"path":"a.txt"}' } }])
  check('reset：清空上一轮的分片状态', report.truncated.size === 0, `truncated=${report.truncated.size}`)
}

console.log(failures === 0 ? '\n参数截断守卫校验：全部通过' : `\n参数截断守卫校验：${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)
