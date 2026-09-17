/**
 * 护栏：流式请求的超时必须是**停顿**判定，不是「一轮总共 120 秒」。
 *
 * ## 为什么需要它
 *
 * 用户报的现象：「AI 明明在输出，却因为 120s 的限制结束了」，
 * 以及「最后改代码的时候因为超时被中断了」。
 *
 * 根因是 `ipc/ai.ts` 里那个 `setTimeout(120_000)`：它覆盖**整次 HTTP 往返**
 * （建连 + 等首字 + 输出），是「总时长上限」而不是「多久没动静才算卡死」。
 * 每轮确实都重置 —— 问题不在重置，而在每轮给的是总时长。于是
 *   - 模型连续输出超过 2 分钟必然被砍（长代码、长解释、长思维链），
 *     哪怕那一刻分片还在源源不断地到
 *   - 要调 editFile 的那一轮，模型得先吐完思维链与正文、再分片吐工具调用参数，
 *     往返超过 120 秒时参数还没吐完就被掐断（工具**执行**不在计时范围内）
 *
 * 这类 bug 的特征是**极难在开发机上复现**：要模型恰好输出满 2 分钟。
 * 所以钉一道静态护栏，防止以后有人把「一轮总时长」的写法改回来。
 *
 * ## 检查方式
 *
 * 三件事，都对着源码做静态断言（不启动 Electron）：
 *   1. `stream-watchdog.ts` 里的停顿阈值必须足够大（≥ 3 分钟）——
 *      它防的是「上游半死不活」，不是「模型慢」
 *   2. 单轮硬上限必须存在且 ≥ 停顿阈值 —— 否则「连接活着但不给内容」
 *      会被无限重置计时器，界面永远转圈
 *   3. `streamRound` 里必须**同时**有 progress()（收到数据就重置）
 *      与 ceiling（单轮硬上限），且 SSE 的 data 回调里调了 progress()
 *
 * 第 3 条是关键：只把常量改大不算修好 ——
 * 如果 data 回调里没有重置，那仍然是一个「每轮固定 N 分钟」的定时炸弹。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')

let failures = 0
function check(name, ok, detail = '') {
  console.log(`${ok ? '通过' : '失败'}  ${name}${detail ? `  ${detail}` : ''}`)
  if (!ok) failures += 1
}

const watchdogFile = path.join(root, 'src/main/stream-watchdog.ts')
const aiFile = path.join(root, 'src/main/ipc/ai.ts')

for (const file of [watchdogFile, aiFile]) {
  if (!fs.existsSync(file)) {
    console.error(`[timeout-check] 找不到 ${path.relative(root, file)}`)
    process.exit(1)
  }
}

const watchdog = fs.readFileSync(watchdogFile, 'utf8')
const ai = fs.readFileSync(aiFile, 'utf8')

/**
 * 去掉注释后的源码。
 *
 * 有些断言查的是「这句话还在不在文案里」，而注释里**故意**引用了旧文案
 * （说明修复的是什么）。不剥注释的话，文档写得越清楚，护栏越会误报 ——
 * 误报一次这道护栏就没人信了。
 */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')
}

/** 从 `export const NAME = 5 * 60 * 1000` 这类写法里算出毫秒数 */
function readMs(source, name) {
  const re = new RegExp(`export const ${name}\\s*=\\s*([0-9_\\s*]+)`)
  const match = re.exec(source)
  if (!match) return null
  const expr = match[1].replace(/_/g, '')
  if (!/^[0-9\s*]+$/.test(expr)) return null
  const value = expr
    .split('*')
    .map((part) => Number(part.trim()))
    .reduce((a, b) => a * b, 1)
  return Number.isFinite(value) ? value : null
}

const STALL_MIN_MS = 3 * 60 * 1000

/* ── 1. 停顿阈值 ───────────────────────────────────────────── */
const stall = readMs(watchdog, 'STREAM_STALL_TIMEOUT_MS')
check(
  '停顿阈值存在且 ≥ 3 分钟',
  stall !== null && stall >= STALL_MIN_MS,
  stall === null ? '没找到 STREAM_STALL_TIMEOUT_MS' : `${stall / 1000}s`
)

/* ── 2. 单轮硬上限 ─────────────────────────────────────────── */
const ceiling = readMs(watchdog, 'STREAM_ROUND_MAX_MS')
check(
  '单轮硬上限存在且 ≥ 停顿阈值',
  ceiling !== null && stall !== null && ceiling >= stall,
  ceiling === null ? '没找到 STREAM_ROUND_MAX_MS' : `${ceiling / 1000}s`
)

/* ── 3. 旧的「一轮固定超时」写法必须已经消失 ───────────────── */
check(
  '不再有 CHAT_TIMEOUT_MS 这种「一轮总时长」常量',
  !/CHAT_TIMEOUT_MS/.test(stripComments(ai)),
  '它是一轮的总时长上限，会让长回答与慢工具被误杀'
)

/* ── 4. streamRound 里必须真的重置计时器 ───────────────────── */
{
  const hasProgress = /const progress = \(\): void => \{/.test(ai)
  check('streamRound 里有 progress()（收到数据就重新计时）', hasProgress)

  // data 回调里必须调 progress()。允许中间隔着注释
  const dataHandler = /response\.on\('data',[\s\S]{0,600}?progress\(\)/.test(ai)
  check('SSE 的 data 回调里调了 progress()', dataHandler, '漏了它 = 每轮仍是固定超时')

  check(
    '单轮硬上限在请求发出时就起表',
    /ceilingTimer = setTimeout\(\(\) => timeOut\('ceiling'/.test(ai)
  )

  // 超时必须掐断连接，否则请求会挂在后台继续烧 token
  check('超时分支会 abort 请求', /const timeOut[\s\S]{0,300}?request\.abort\(\)/.test(ai))
}

/* ── 5. 超时文案要分情况 ──────────────────────────────────── */
{
  const hasBoth = /kind === 'ceiling'/.test(watchdog) && /kind: 'stall' \| 'ceiling'/.test(watchdog)
  check('超时文案区分「停顿」与「单轮上限」两种原因', hasBoth)
  check(
    '不再一律写「请检查网络或中转站状态」',
    !/请检查网络或中转站状态/.test(stripComments(watchdog)),
    '这句对「模型太慢」是误导，会让人去查自己的网络'
  )
}

/* ── 6. 一轮结束必须停表 ──────────────────────────────────── */
{
  /*
   * 一轮结束（模型给出 tool_calls / 答完）时 settle() 必须停表。
   *
   * 这一条同时守两件事：
   *   - 工具执行期间不该有任何计时器在跑（那几分钟没有任何分片是正常的）
   *   - 下一轮要拿到**完整**的预算，而不是被上一轮用剩的时间
   *     （原代码也是这么做的 —— 这个语义不能被改回去）
   */
  const settleStops = /const settle = \(result: RoundResult\): void => \{[\s\S]{0,400}?stopWatchdog\(\)/.test(ai)
  check('一轮结束时停表（工具执行不计入超时、下一轮拿到完整预算）', settleStops)
}

console.log(
  failures === 0
    ? '\n流式超时校验：全部通过（停顿看门狗，不再是「一轮 120 秒」）'
    : `\n流式超时校验：${failures} 项失败`
)
process.exit(failures === 0 ? 0 : 1)
