/**
 * 新增能力的离线校验：系统设定组装、敏感信息扫描。
 *
 * 这两个模块都是**纯函数**，而且都有「看起来对、实际很糟」的写法：
 *
 *   1. 系统设定组装 —— 一旦引入任何不确定性（时间戳、随机顺序、
 *      平台相关的路径），prompt 缓存就会**每次都失效**。
 *      这个错误不会报错、不会崩溃，只会让账单悄悄涨上去，
 *      所以必须用测试把「两次调用逐字节相同」钉死。
 *
 *   2. 敏感信息扫描 —— 正则写错的表现是**静默漏过**，
 *      而不是抛异常。漏过的后果是密钥被永久写进记忆、
 *      以后每次对话都被发出去。同样必须钉住。
 *
 * 另外还校验「顺序约定」：越稳定的内容必须排在越前面。
 * 这条约定是缓存能命中的前提，靠人记住是不可靠的。
 *
 * 用法：npm run check:profile
 */
import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  SECRET_POSITIVES,
  SECRET_NEGATIVES,
  PER_RULE_SAMPLES,
  FAKE_OPENAI,
  FAKE_OPENAI_LEGACY,
  FAKE_GITHUB,
  FAKE_PEM_RSA,
  FAKE_JWT
} from './lib/fake-secrets.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const require = createRequire(import.meta.url)

let failures = 0
function check(name, ok, detail = '') {
  console.log(`${ok ? '通过' : '失败'}  ${name}${detail ? `  ${detail}` : ''}`)
  if (!ok) failures += 1
}

function loadTs(relPath) {
  const esbuild = require('esbuild')
  const out = esbuild.transformSync(fs.readFileSync(path.join(root, relPath), 'utf8'), {
    loader: 'ts',
    format: 'cjs',
    target: 'node16'
  })
  const tmp = path.join(os.tmpdir(), `profile-${process.pid}-${path.basename(relPath)}.cjs`)
  fs.writeFileSync(tmp, out.code)
  const mod = require(tmp)
  fs.rmSync(tmp, { force: true })
  return mod
}

const sysdoc = loadTs('src/shared/system-doc.ts')
const secret = loadTs('src/shared/secret-scan.ts')

const { buildSystemDoc, formatRuntimes, clipName, AI_NAME_MAX, USER_NAME_MAX, HABITS_MAX } = sysdoc
const { scanSecrets, hasSecret, redactSecrets, describeSecretBlock } = secret

/* ══ 1. 组装必须是确定性的 ══════════════════════════════════ */

{
  const input = {
    aiName: '小助',
    userName: '同学',
    systemPrompt: '你是一名中文技术助手。',
    habits: '- 我只用 Windows\n- 解释尽量短',
    runtimes: [
      { name: 'python', version: 'Python 3.11.4', note: '可以跑 .py 脚本' },
      { name: 'node', version: 'v18.17.0', note: '可以跑 .js 脚本与 npm' }
    ],
    environmentNote: '用户的操作系统：Windows 10，64 位。'
  }
  const first = buildSystemDoc(input)
  const second = buildSystemDoc({ ...input })
  check('同样的输入产生逐字节相同的输出', first === second)

  // ★ 反复调用也不能有随机性（比如混进一个 Date.now()）
  let stable = true
  for (let i = 0; i < 50; i++) {
    if (buildSystemDoc(input) !== first) stable = false
  }
  check('连续 50 次组装结果完全一致', stable)

  // 时间戳是缓存杀手：绝不允许出现在产物里
  check(
    '产物里没有时间戳痕迹',
    !/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(first) && !/\d{2}:\d{2}:\d{2}/.test(first)
  )

  // 内容确实被拼进去了
  check('包含 AI 名字', first.includes('小助'))
  check('包含对用户的称呼', first.includes('同学'))
  check('包含默认提示词', first.includes('你是一名中文技术助手。'))
  check('包含习惯', first.includes('我只用 Windows'))
  check('包含运行时清单', first.includes('python') && first.includes('3.11.4'))
  check('包含系统环境说明', first.includes('Windows 10'))
}

/* ══ 2. 顺序约定：稳定在前，易变在后 ════════════════════════ */

{
  const text = buildSystemDoc({
    aiName: '小助',
    userName: '同学',
    systemPrompt: '提示词内容',
    habits: '习惯内容',
    runtimes: [{ name: 'python', version: '3.11', note: '跑脚本' }],
    environmentNote: '环境说明'
  })
  const atIdentity = text.indexOf('你的身份')
  const atPrompt = text.indexOf('你要做什么')
  const atHabits = text.indexOf('用户的习惯')
  const atEnv = text.indexOf('本机环境')

  check('身份段在最前', atIdentity > 0 && atIdentity < atPrompt)
  check('提示词在身份之后', atPrompt > 0 && atPrompt < atHabits)
  check('习惯在提示词之后', atHabits > 0 && atHabits < atEnv)
  // ★ 环境最后：装了个 python 就该只影响它后面（其实没有后面），
  //   前面的稳定前缀照样命中缓存。反过来放，一次环境变化会废掉全部缓存
  check('环境段在最后', atEnv > atHabits)
}

/* ══ 3. 空值处理：绝不产生空壳段落 ══════════════════════════ */

{
  const bare = buildSystemDoc({
    aiName: '',
    userName: '',
    systemPrompt: '',
    habits: '',
    runtimes: [],
    environmentNote: ''
  })
  check('全空时不出现「你的身份」段', !bare.includes('你的身份'))
  check('全空时不出现空名字「」', !bare.includes('「」'))
  check('全空时不出现「你要做什么」段', !bare.includes('你要做什么'))
  check('全空时不出现「本机环境」段', !bare.includes('本机环境'))
  check('全空时仍然有文件头说明', bare.includes('系统设定') && bare.includes('自动生成'))

  // 只有名字没有称呼：不该出现「称呼用户为「」」
  const onlyName = buildSystemDoc({
    aiName: '小助',
    userName: '',
    systemPrompt: '',
    habits: '',
    runtimes: []
  })
  check('只有名字时不写空称呼', onlyName.includes('小助') && !onlyName.includes('称呼用户为「」'))

  // 只有称呼没有名字：同理
  const onlyUser = buildSystemDoc({
    aiName: '',
    userName: '同学',
    systemPrompt: '',
    habits: '',
    runtimes: []
  })
  check(
    '只有称呼时不写空名字',
    onlyUser.includes('同学') && !onlyUser.includes('你的名字是「」')
  )

  /*
   * ★ 没探测到运行时**不能**写成「本机没有任何运行时」。
   *   那句话会让模型以为连 python 都不能装，反而抑制它的建议。
   */
  check('无运行时不产生否定式描述', !bare.includes('没有任何'))
  check('formatRuntimes 空输入返回空串', formatRuntimes([]) === '')
}

/* ══ 4. 长度夹紧 ════════════════════════════════════════════ */

{
  check('clipName 按上限截断', clipName('一二三四五六七八', 5) === '一二三四五')
  check('clipName 去首尾空白', clipName('  小助  ', 5) === '小助')
  check('clipName 空输入返回空串', clipName('', 5) === '')

  const long = buildSystemDoc({
    aiName: '一二三四五六七八九十',
    userName: '甲乙丙丁戊己庚',
    systemPrompt: 'x',
    habits: 'y'.repeat(HABITS_MAX + 500),
    runtimes: []
  })
  check('超长名字被夹到上限', long.includes('一二三四五') && !long.includes('一二三四五六'))
  check('超长称呼被夹到上限', long.includes('甲乙丙丁戊') && !long.includes('甲乙丙丁戊己'))
  check('习惯被夹到上限', long.length < HABITS_MAX + 1000)

  check('AI_NAME_MAX 是 5', AI_NAME_MAX === 5)
  check('USER_NAME_MAX 是 5', USER_NAME_MAX === 5)
}

/* ══ 5. 敏感信息：必须认出的形状 ════════════════════════════ */

{
  /*
   * 每条都用「真实会出现的写法」，不是构造出来的理想样本 ——
   * 尤其要带上引号、赋值号、前后空白，因为实际内容是用户粘的 .env 片段。
   */
  /*
   * 样本从 scripts/lib/fake-secrets.mjs 取，理由见那个文件的开头：
   * 字面量形式的假密钥会被 GitHub 推送保护拦下来（第一次提交就撞上了），
   * 所以它们在运行时拼出来。运行时拼出来的值与真凭证格式完全一致，
   * 规则该匹配的照样匹配。
   */
  const positives = SECRET_POSITIVES

  for (const [label, text] of positives) {
    const result = scanSecrets(text)
    check(`能认出${label}`, result.hits.length > 0, result.labels.join('、'))
  }

  // 多类混合：必须都报出来，而不是只报第一个
  const mixed = scanSecrets(`A=${FAKE_OPENAI_LEGACY}\nB=${FAKE_GITHUB}`)
  check('混合内容能报出多类', mixed.labels.length >= 2, mixed.labels.join('、'))
}

/* ══ 6. 敏感信息：绝不能误报的内容 ══════════════════════════ */

{
  /*
   * 误报的代价是**真实的**：AI 想记「用户的环境变量叫 DB_PASSWORD」
   * 都被拒，这个功能就没法用了 —— 用户会直接把它关掉，
   * 那才是真的失去保护。所以这一组和上一组同样重要。
   */
  const negatives = SECRET_NEGATIVES

  for (const [label, text] of negatives) {
    check(`不误报${label}`, !hasSecret(text), scanSecrets(text).labels.join('、'))
  }
}

/* ══ 7. 脱敏替换 ════════════════════════════════════════════ */

{
  const original = `配置如下：\nOPENAI_API_KEY=${FAKE_OPENAI}\n其他正常内容也一样保留`
  const { text, redacted } = redactSecrets(original)
  check('脱敏计数正确', redacted === 1, `redacted=${redacted}`)
  check('脱敏后原密钥不再出现', !text.includes(FAKE_OPENAI))
  check('脱敏处留下可读标记', text.includes('[已隐去：'))
  // ★ 不能截断：截断会破坏对话结构，模型会以为消息本身坏了
  check('脱敏保留上下文', text.includes('配置如下：') && text.includes('其他正常内容也一样保留'))

  // 多处命中都要替换，而且计数要对
  const many = redactSecrets(`${FAKE_OPENAI_LEGACY} 和 ${FAKE_GITHUB}`)
  check('多处命中都被替换', many.redacted === 2, `redacted=${many.redacted}`)

  // ★ 同一个正则被连续用两次不能互相干扰（带 g 的 regex 有 lastIndex 状态）
  const a = scanSecrets(FAKE_OPENAI_LEGACY)
  const b = scanSecrets(FAKE_OPENAI_LEGACY)
  check('重复扫描结果一致（无 lastIndex 污染）', a.hits.length === b.hits.length && a.hits.length === 1)

  // 空输入
  check('空字符串不崩', scanSecrets('').hits.length === 0 && redactSecrets('').redacted === 0)
}

/* ══ 8. 给模型的拒绝理由 ════════════════════════════════════ */

{
  const note = describeSecretBlock(['OpenAI API Key'], '这条记忆')
  check('拒绝理由说明是哪里出问题', note.includes('这条记忆'))
  check('拒绝理由点出具体类别', note.includes('OpenAI API Key'))
  check('拒绝理由说明为什么要拦', note.includes('磁盘') || note.includes('发出去'))
  check('拒绝理由给了替代做法', note.includes('占位符'))
  /*
   * ★ 拒绝理由里不能带原文。
   *   带了的话密钥就跟着错误信息进了对话上下文与日志，
   *   本来要防的事情反而被自己做了。这个测试是给这条纪律兜底的。
   */
  const secretText = FAKE_OPENAI
  const withSecret = describeSecretBlock(['OpenAI API Key'], '这条记忆')
  check('拒绝理由里不含密钥原文', !withSecret.includes(secretText))
}

/* ══ 9. 规则本身必须可用 ════════════════════════════════════ */

{
  /*
   * 每条规则都要能构造出来、能匹配到自己的样本。
   *
   * 这一组看着和上面第 5 节重复，其实查的是另一件事：
   * 第 5 节查的是 **scanSecrets 的结果**（哪条规则命中都行），
   * 这里查的是**每条规则各自**都能工作。差别很实际 ——
   * 如果 OpenAI 那条规则因为写错而永远不匹配，第 5 节的
   * 「能认出 OpenAI 密钥」仍会通过（因为 Anthropic 那条规则恰好也能匹配上），
   * 于是错误被掩盖，直到某个只含 OpenAI 密钥的真实场景才暴露。
   *
   * 所以这里给每条规则单独准备一个**只该匹配它**的样本，逐条验。
   */
  /*
   * 每条规则单独验：给一个**只该匹配它**的样本。
   *
   * 这一步不能省：如果 OpenAI 那条规则写错了，通用的
   * 「能认出 OpenAI 密钥」仍会通过（因为 Anthropic 那条恰好也能匹配
   * 同一个样本），错误被掩盖到真实场景才暴露。
   */
  const perRule = Object.entries(PER_RULE_SAMPLES)

  let constructible = true
  for (const rule of secret.SECRET_RULES) {
    try {
      new RegExp(rule.pattern.source, rule.pattern.flags.replace('g', ''))
    } catch {
      constructible = false
    }
  }
  check('全部规则都能构造出正则', constructible)

  for (const [label, sample] of perRule) {
    const rule = secret.SECRET_RULES.find((item) => item.label === label)
    check(`规则表里有「${label}」`, Boolean(rule))
    if (!rule) continue
    const global = new RegExp(rule.pattern.source, rule.pattern.flags.replace('g', '') + 'g')
    const matched = global.exec(sample)
    check(`「${label}」能匹配自己的样本`, Boolean(matched), matched ? matched[0].slice(0, 24) : '未匹配')
  }

  /*
   * ★ 一条样本只该被一条规则认出来。
   *
   * 否则界面上会报「检测到 OpenAI API Key、Anthropic API Key」这种
   * 莫名其妙的组合（同一个密钥被算成两类），用户会以为泄漏了两样东西。
   * OpenAI 与 Anthropic 的规则最容易踩这个坑 —— 它们都以 sk- 开头。
   */
  for (const [label, sample] of perRule) {
    const labels = scanSecrets(sample).labels
    check(`「${label}」只命中一条规则`, labels.length === 1, labels.join('、'))
  }

  /*
   * 扫描规则必须是「无状态」的。
   *
   * 带 g 标志的正则有 lastIndex，跨调用互相干扰 —— 那会让同一个内容
   * 第一次报、第二次不报。这里连扫 20 次确认结果恒定。
   */
  const sample = `OPENAI_API_KEY=${FAKE_OPENAI}`
  let stableHits = true
  for (let i = 0; i < 20; i++) {
    if (scanSecrets(sample).hits.length !== 1) stableHits = false
  }
  check('反复扫描结果恒定（无 lastIndex 污染）', stableHits)
}

console.log('')
if (failures > 0) {
  console.log(`共 ${failures} 项失败`)
  process.exit(1)
}
console.log('全部通过')
