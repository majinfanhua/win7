/**
 * 上下文预算与压缩策略的离线校验。
 *
 * 这块是纯计算，但错法很隐蔽：阈值算错只会表现为「压缩得太早/太晚」，
 * 在几十轮的对话里慢慢积累，很难在界面上看出是 bug。
 * 所以把阈值公式、判定顺序、压力升降都用测试钉住。
 *
 * 用法：npm run check:budget
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

async function loadModule() {
  const esbuild = require('esbuild')
  const out = esbuild.transformSync(
    fs.readFileSync(path.join(root, 'src/main/compaction-policy.ts'), 'utf8'),
    { loader: 'ts', format: 'cjs', target: 'node16' }
  )
  const tmp = path.join(os.tmpdir(), `budget-${process.pid}.cjs`)
  fs.writeFileSync(tmp, out.code)
  const mod = require(tmp)
  fs.rmSync(tmp, { force: true })
  return mod
}

const {
  resolveModelLimits,
  isModelKnown,
  resolveThreshold,
  decideCompaction,
  createCompactionPressure,
  notePressureAfterCompaction,
  normalizePressure,
  resolvePruneOptions,
  resolveBudgetForModel,
  roughTokens,
  MIN_COMPACTION_INTERVAL_MS
} = await loadModule()

const W = 128_000
const OUT = 16_384

/* ══ 1. 阈值公式 ════════════════════════════════════════════ */

{
  // optimization 因子 1.5：128000 - 16384*1.5 = 128000 - 24576 = 103424
  const t = resolveThreshold({
    intent: 'optimization',
    contextWindow: W,
    maxOutputToken: OUT,
    pressureLevel: 0
  })
  check('阈值：主动压缩用 1.5 因子', t === 103_424, `得到 ${t}`)
}

{
  // protection 因子 1.2：128000 - 16384*1.2 = 128000 - 19660.8 → floor 108339
  const t = resolveThreshold({
    intent: 'protection',
    contextWindow: W,
    maxOutputToken: OUT,
    pressureLevel: 0
  })
  check('阈值：保护性压缩用 1.2 因子（更晚触发）', t === 108_339, `得到 ${t}`)
}

{
  // 压力到顶时 protection 降到 1.0，阈值变高（更晚压缩）
  const t = resolveThreshold({
    intent: 'protection',
    contextWindow: W,
    maxOutputToken: OUT,
    pressureLevel: 2
  })
  check('阈值：压力到顶时保护因子降到 1.0', t === W - OUT, `得到 ${t}`)
}

{
  // ★ 小窗口模型不能算出负数阈值，否则永远不触发
  const t = resolveThreshold({
    intent: 'optimization',
    contextWindow: 8_000,
    maxOutputToken: 8_192,
    pressureLevel: 0
  })
  check('阈值：小窗口下仍为正数（下限 1024）', t === 1024, `得到 ${t}`)
}

{
  // 阈值必须**小于**窗口，否则输入还没满就已经超了
  const t = resolveThreshold({
    intent: 'optimization',
    contextWindow: 32_000,
    maxOutputToken: 4_000,
    pressureLevel: 0
  })
  check('阈值：恒小于窗口本身', t < 32_000, `得到 ${t}`)
}

/* ══ 2. 模型窗口表 ══════════════════════════════════════════ */

{
  const cases = [
    ['gpt-4o', 128_000],
    ['gpt-4o-mini', 128_000],
    ['gpt-3.5-turbo', 16_385],
    ['claude-3-5-sonnet-20241022', 200_000],
    ['claude-sonnet-4', 200_000],
    ['gemini-1.5-pro', 1_000_000],
    ['deepseek-chat', 64_000],
    ['qwen-max', 128_000],
    ['glm-4', 128_000]
  ]
  for (const [model, expected] of cases) {
    const got = resolveModelLimits(model).contextWindow
    check(`窗口表：${model}`, got === expected, got === expected ? '' : `期望 ${expected}，得到 ${got}`)
  }
}

{
  // 带中转站前缀也要认得
  const got = resolveModelLimits('openai/gpt-4o').contextWindow
  check('窗口表：认得「中转站前缀/模型名」形式', got === 128_000, `得到 ${got}`)
}

{
  // ★ 更具体的要排在更宽的前面：gpt-4o-mini 不能命中 gpt-4 的 8k
  const mini = resolveModelLimits('gpt-4o-mini').contextWindow
  check('窗口表：gpt-4o-mini 不被 gpt-4 规则抢走', mini === 128_000, `得到 ${mini}`)
}

{
  // 认不出来的模型走保守值，且要如实报告「不认识」
  const unknown = resolveModelLimits('some-unknown-model-xyz')
  check('窗口表：未知模型退到保守值', unknown.contextWindow === 32_000, `得到 ${unknown.contextWindow}`)
  check('窗口表：未知模型如实标记为不认识', isModelKnown('some-unknown-model-xyz') === false)
  check('窗口表：已知模型标记为认识', isModelKnown('gpt-4o') === true)
}

{
  // 用户手填优先于内置表 —— 这是「内置表过时」的自救口子
  const got = resolveModelLimits('gpt-4o', { contextWindow: 999_999 })
  check('窗口表：用户手填覆盖内置值', got.contextWindow === 999_999, `得到 ${got.contextWindow}`)

  const partial = resolveModelLimits('gpt-4o', { maxOutputToken: 1_234 })
  check(
    '窗口表：只覆盖其中一项时另一项仍用内置值',
    partial.maxOutputToken === 1_234 && partial.contextWindow === 128_000,
    `得到 ${JSON.stringify(partial)}`
  )
}

/* ══ 3. 判定顺序 ════════════════════════════════════════════ */

const base = {
  intent: 'optimization',
  contextWindow: W,
  maxOutputToken: OUT,
  activeMessageCount: 10,
  userMessageCount: 5,
  lastCompactionAt: 0,
  pressure: createCompactionPressure(),
  now: 1_000_000
}

{
  const d = decideCompaction({ ...base, contextWindow: 0, totalTokens: 200_000 })
  check('判定：窗口为 0 时 disabled', d.shouldCompact === false && d.reason === 'disabled',
    `得到 ${d.reason}`)
}

/* ══ 3b. 0 值语义（配置里 0 = 自动，不能直接进判定）═════════ */

{
  // ★ 这是接错就静默失效的地方：配置留 0 表示「按模型名自动判断」，
  //   而 decideCompaction 里 0 表示「窗口未知 → 禁用压缩」。
  //   所以必须先过 resolveBudgetForModel 换成真实窗口。
  const b = resolveBudgetForModel({ model: 'gpt-4o', contextWindow: 0, maxOutputTokens: 0 })
  check(
    '0 值语义：留 0 时换成内置表的真实窗口',
    b.contextWindow === 128_000 && b.maxOutputToken === 16_384,
    `得到 ${JSON.stringify(b)}`
  )

  const d = decideCompaction({
    ...base,
    contextWindow: b.contextWindow,
    maxOutputToken: b.maxOutputToken,
    totalTokens: 200_000
  })
  check('0 值语义：留 0 时压缩仍然生效（不会静默禁用）', d.shouldCompact === true, `得到 ${d.reason}`)

  // 填了就用填的
  const filled = resolveBudgetForModel({ model: 'gpt-4o', contextWindow: 5_000, maxOutputTokens: 500 })
  check(
    '0 值语义：填了就用填的值',
    filled.contextWindow === 5_000 && filled.maxOutputToken === 500,
    `得到 ${JSON.stringify(filled)}`
  )

  // 负数与 undefined 也当没填
  const weird = resolveBudgetForModel({ model: 'gpt-4o', contextWindow: -1, maxOutputTokens: undefined })
  check(
    '0 值语义：负数与 undefined 都当没填',
    weird.contextWindow === 128_000 && weird.maxOutputToken === 16_384,
    `得到 ${JSON.stringify(weird)}`
  )
}

{
  const d = decideCompaction({ ...base, totalTokens: 200_000, activeMessageCount: 0 })
  check('判定：没有活跃消息时不压', d.shouldCompact === false && d.reason === 'no-active-messages',
    `得到 ${d.reason}`)
}

{
  const d = decideCompaction({ ...base, totalTokens: 1_000 })
  check('判定：低于阈值时不压', d.shouldCompact === false && d.reason === 'below-threshold',
    `得到 ${d.reason}`)
}

{
  const d = decideCompaction({ ...base, totalTokens: 200_000 })
  check('判定：超过阈值时该压', d.shouldCompact === true && d.reason === 'threshold-exceeded',
    `得到 ${d.reason}`)
}

{
  // 刚压完 + 用户消息很少 → 冷却
  const d = decideCompaction({
    ...base,
    totalTokens: 200_000,
    lastCompactionAt: base.now - 1_000,
    userMessageCount: 1
  })
  check('判定：刚压完且消息少时进冷却', d.shouldCompact === false && d.reason === 'cooldown',
    `得到 ${d.reason}`)
}

{
  // ★ 冷却不能把用户永久卡住：消息够多就该压
  const d = decideCompaction({
    ...base,
    totalTokens: 200_000,
    lastCompactionAt: base.now - 1_000,
    userMessageCount: 10
  })
  check('判定：消息够多时冷却不生效', d.shouldCompact === true, `得到 ${d.reason}`)
}

{
  // 冷却窗口过去后正常触发
  const d = decideCompaction({
    ...base,
    totalTokens: 200_000,
    lastCompactionAt: base.now - MIN_COMPACTION_INTERVAL_MS - 1,
    userMessageCount: 1
  })
  check('判定：冷却期过后恢复触发', d.shouldCompact === true, `得到 ${d.reason}`)
}

{
  // 手动触发跳过阈值与冷却，但硬守卫仍生效
  const manual = decideCompaction({ ...base, totalTokens: 10, bypassThresholdAndCooldown: true })
  check('判定：手动触发跳过阈值', manual.shouldCompact === true, `得到 ${manual.reason}`)

  const guarded = decideCompaction({
    ...base,
    totalTokens: 10,
    activeMessageCount: 0,
    bypassThresholdAndCooldown: true
  })
  check('判定：手动触发仍受硬守卫约束', guarded.shouldCompact === false, `得到 ${guarded.reason}`)
}

/* ══ 4. 压力升降 ════════════════════════════════════════════ */

{
  let p = createCompactionPressure()
  check('压力：初始为 0 级', p.level === 0)

  // 压完仍在阈值的 90% 以上 → 低效，升到 1
  p = notePressureAfterCompaction(p, { totalTokensAfter: 100_000, threshold: 100_000, now: 1 })
  check('压力：一次低效压缩升到 1 级', p.level === 1, `得到 ${p.level}`)

  p = notePressureAfterCompaction(p, { totalTokensAfter: 100_000, threshold: 100_000, now: 2 })
  check('压力：连续低效升到 2 级', p.level === 2, `得到 ${p.level}`)

  p = notePressureAfterCompaction(p, { totalTokensAfter: 100_000, threshold: 100_000, now: 3 })
  check('压力：不超过上限 2 级', p.level === 2, `得到 ${p.level}`)
}

{
  // 压得有效（降到阈值 90% 以下）→ 归零
  let p = createCompactionPressure()
  p = notePressureAfterCompaction(p, { totalTokensAfter: 100_000, threshold: 100_000, now: 1 })
  p = notePressureAfterCompaction(p, { totalTokensAfter: 50_000, threshold: 100_000, now: 2 })
  check('压力：压缩有效时回到 0 级', p.level === 0 && p.consecutiveIneffective === 0,
    `得到 level=${p.level}`)
}

{
  // 静默 5 分钟后归零
  const p = { level: 2, consecutiveIneffective: 2, compactionsApplied: 3, lastCompactionAt: 1_000 }
  const after = normalizePressure(p, 1_000 + 5 * 60_000 + 1)
  check('压力：静默期过后归零', after.level === 0 && after.consecutiveIneffective === 0)

  const fresh = normalizePressure(p, 1_000 + 1_000)
  check('压力：静默期内保持不变', fresh.level === 2, `得到 ${fresh.level}`)
}

{
  // 压力越高，保护越少（裁剪越狠）
  const l0 = resolvePruneOptions({ level: 0, consecutiveIneffective: 0, compactionsApplied: 0, lastCompactionAt: 0 })
  const l2 = resolvePruneOptions({ level: 2, consecutiveIneffective: 2, compactionsApplied: 2, lastCompactionAt: 0 })
  check(
    '压力：等级越高保护的旧输出越少',
    l2.protectedToolTokens < l0.protectedToolTokens,
    `0级=${l0.protectedToolTokens} 2级=${l2.protectedToolTokens}`
  )
  check(
    '压力：等级越高保护的最近轮数越少',
    l2.protectedRecentUserTurns <= l0.protectedRecentUserTurns,
    `0级=${l0.protectedRecentUserTurns} 2级=${l2.protectedRecentUserTurns}`
  )
}

/* ══ 5. token 估算 ══════════════════════════════════════════ */

{
  check('估算：空串为 0', roughTokens('') === 0)
  check('估算：4 个字符约 2 token', roughTokens('abcd') === 2, `得到 ${roughTokens('abcd')}`)
  // 中文按 2 字符 1 token 折中：8 个汉字 ≈ 4 token，偏乐观但可用于触发
  check('估算：中文按 2 字符 1 token', roughTokens('你好世界你好世界') === 4, `得到 ${roughTokens('你好世界你好世界')}`)
  check('估算：null/undefined 不炸', roughTokens(undefined) === 0 && roughTokens(null) === 0)
}

console.log(failures === 0 ? '\n上下文预算校验：全部通过' : `\n上下文预算校验：${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)
