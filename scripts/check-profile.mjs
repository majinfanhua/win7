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

/**
 * 把一个 TS 模块打成 CJS 再 require。
 *
 * ⚠️ 必须用 buildSync 而**不是** transformSync：后者只翻译单个文件、
 * 不解析 import，一旦被测模块 depend on 别的本地模块就会在 require 时
 * 报「Cannot find module」。system-doc.ts 现在 import 了 prompt-contract.ts，
 * 所以这里必须 bundle。
 */
function loadTs(relPath) {
  const esbuild = require('esbuild')
  const out = esbuild.buildSync({
    stdin: {
      contents: `export * from ${JSON.stringify(path.join(root, relPath))}`,
      resolveDir: root,
      loader: 'ts'
    },
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node16',
    write: false,
    logLevel: 'silent'
  })
  const tmp = path.join(os.tmpdir(), `profile-${process.pid}-${path.basename(relPath)}.cjs`)
  fs.writeFileSync(tmp, out.outputFiles[0].text)
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
    habits: '- 我只用 Windows\n- 解释尽量短',
    runtimes: [
      { name: 'python', version: 'Python 3.11.4', note: '可以跑 .py 脚本' },
      { name: 'node', version: 'v18.17.0', note: '可以跑 .js 脚本与 npm' }
    ],
    environmentNote: '用户的操作系统：Windows 10，64 位。',
    permissionMode: 'chat'
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
  check('包含习惯', first.includes('我只用 Windows'))
  check('包含运行时清单', first.includes('python') && first.includes('3.11.4'))
  check('包含系统环境说明', first.includes('Windows 10'))
}

/* ══ 2. 顺序约定：稳定在前，易变在后 ════════════════════════ */

{
  const text = buildSystemDoc({
    aiName: '小助',
    userName: '同学',
    habits: '习惯内容',
    runtimes: [{ name: 'python', version: '3.11', note: '跑脚本' }],
    environmentNote: '环境说明',
    permissionMode: 'chat'
  })
  const atPlatform = text.indexOf('## 平台')
  const atTools = text.indexOf('## 怎么用工具干活')
  const atDiscipline = text.indexOf('## 工作纪律')
  const atState = text.indexOf('## 当前运行状态')
  const atEnv = text.indexOf('## 本机环境')
  const atMark = text.indexOf('以下可以用「设置 → AI 设定」修改')
  const atIdentity = text.indexOf('## 你的身份')
  const atHabits = text.indexOf('## 用户的习惯')

  /*
   * 契约内部顺序固定：平台 → 工具 → 纪律。
   * 它们只随应用升级变，是最稳定的内容，所以排在最前面。
   */
  check('平台在工具之前', atPlatform > 0 && atPlatform < atTools)
  check('工具在纪律之前', atTools > 0 && atTools < atDiscipline)
  check('纪律在运行状态之前', atDiscipline > 0 && atDiscipline < atState)
  // ★ 运行状态随权限模式变、环境随项目/机器变，都排在契约之后 ——
  //   这样换个模式或换个项目，前面几百字契约照样命中缓存
  check('运行状态在环境之前', atState > 0 && atState < atEnv)

  /*
   * 用户可改区必须在**所有**程序维护段之后。
   * 这条是这次改造的核心：用户打开系统.md 要能一眼看出分界。
   */
  check('分界存在', atMark > 0)
  check('分界在全部契约段之后', atPlatform < atMark && atTools < atMark && atDiscipline < atMark)
  check('分界在运行状态之后', atState < atMark)
  check('分界在环境之后', atEnv < atMark)
  check('身份在分界之后', atIdentity > atMark)
  check('习惯在分界之后', atHabits > atMark)
}

/* ══ 3. 空值处理：绝不产生空壳段落 ══════════════════════════ */

{
  const bare = buildSystemDoc({
    aiName: '',
    userName: '',
    habits: '',
    runtimes: [],
    environmentNote: '',
    permissionMode: 'chat'
  })
  // 查段**标题**而不是字样：文件头注释里提到了「你的身份」
  //   （说明哪部分可改），那是文字说明不是段
  check('全空时不出现「你的身份」段', !/^## 你的身份/m.test(bare))
  // 契约段**永远在**（由程序维护，与用户填了什么无关）—— 这是这次改造的设计
  check('全空时契约段仍然在', bare.includes('## 平台') && bare.includes('## 工作纪律'))
  check('全空时不出现空名字「」', !bare.includes('「」'))
  check('全空时不出现「你要做什么」段', !bare.includes('你要做什么'))
  // 注意：契约里有一句「见下面的「本机环境」段」是对模型的指引，
  //   所以这里查的是**段标题**而不是字样
  check('全空时不出现「本机环境」段标题', !/^## 本机环境/m.test(bare))
  check('全空时仍然有文件头说明', bare.includes('系统设定') && bare.includes('自动生成'))

  // 只有名字没有称呼：不该出现「称呼用户为「」」
  const onlyName = buildSystemDoc({
    aiName: '小助',
    userName: '',
    habits: '',
    runtimes: []
  })
  check('只有名字时不写空称呼', onlyName.includes('小助') && !onlyName.includes('称呼用户为「」'))

  // 只有称呼没有名字：同理
  const onlyUser = buildSystemDoc({
    aiName: '',
    userName: '同学',
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
    habits: 'y'.repeat(HABITS_MAX + 500),
    runtimes: [],
    permissionMode: 'chat'
  })
  check('超长名字被夹到上限', long.includes('一二三四五') && !long.includes('一二三四五六'))
  check('超长称呼被夹到上限', long.includes('甲乙丙丁戊') && !long.includes('甲乙丙丁戊己'))
  // 契约段让总长度不再是「习惯长度」，所以断言习惯内容本身被夹住
  check('习惯被夹到上限', !long.includes('y'.repeat(HABITS_MAX + 100)) && long.includes('y'.repeat(100)))

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

/* ══ 10. 仓库里不能有「看起来像真凭证」的字面量 ══════════════ */

{
  /*
   * ★★ 这一组是**被 GitHub 教会的**。
   *
   * 第一次提交时推送被拦下：
   *   remote: error: GH013: Repository rule violations found
   *   remote:   - GITHUB PUSH PROTECTION
   *   remote:     - Push cannot contain secrets
   *   remote:       —— Slack API Token —— path: scripts/check-profile.mjs:202
   *
   * 原因是**本项目自己的敏感信息扫描器的测试样本**触发了
   * GitHub 的推送保护。两边都没错：仓库要拦真密钥，
   * 测试要形状逼真的样本（不像真凭证就匹配不上，测试也就没意义）。
   *
   * 解法是样本在运行时拼出来（scripts/lib/fake-secrets.mjs）。
   * 这个检查就是那道自动化守卫 —— 本地跑一次比等推送被拒快得多，
   * 而且推送被拒时 GitHub **只报第一个命中点**，得反复试才能清干净。
   */
  const secretShapes = [
    [/sk-[A-Za-z0-9_-]{20,}/, 'OpenAI/Anthropic 风格的密钥'],
    [/gh[pousr]_[A-Za-z0-9]{20,}/, 'GitHub token'],
    [/xox[baprs]-[A-Za-z0-9-]{10,}/, 'Slack token'],
    [/AKIA[0-9A-Z]{16}/, 'AWS Access Key'],
    [/AIza[0-9A-Za-z_-]{35}/, 'Google API Key'],
    [/-----BEGIN[ A-Z]*PRIVATE KEY-----/, 'PEM 私钥头']
  ]

  const offenders = []
  const scanDir = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (
        entry.name === 'node_modules' ||
        entry.name === '.git' ||
        /*
         * 构建产物与参考资料跳过。
         *
         * `out/` 是 electron-vite 的产物、`release/` 是打包结果 ——
         * 两者都在 `.gitignore` 里，扫描它们毫无意义，却会在「刚构建完
         * 就跑这个护栏」时因为产物里的字符串报假失败。
         *
         * `参考*` 与 `ref` 对应 `.gitignore` 里那两条兜底规则：
         * 那些是**别人的仓库**，本地阅读用，不进历史，也不该被扫。
         */
        entry.name === 'out' ||
        entry.name === 'release' ||
        entry.name.startsWith('参考') ||
        entry.name === 'ref'
      ) {
        continue
      }
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        scanDir(full)
        continue
      }
      if (!/\.(ts|tsx|mjs|js|md|json)$/.test(entry.name)) continue
      const text = fs.readFileSync(full, 'utf8')
      for (const [pattern, label] of secretShapes) {
        if (pattern.test(text)) offenders.push(`${path.relative(root, full)}（${label}）`)
      }
    }
  }
  scanDir(root)

  check(
    '仓库里没有「看起来像真凭证」的字面量',
    offenders.length === 0,
    offenders.length > 0
      ? `${offenders.join('、')} —— 请改成运行时拼接，见 scripts/lib/fake-secrets.mjs`
      : ''
  )

  /*
   * 守「别把样本偷偷换成占位符」。
   *
   * 用 'sk-XXXX' 能让上面的检查通过，但测试就废了：规则要求
   * sk- 后至少 20 个字符，占位符太短、压根不匹配，
   * 于是「能认出 OpenAI 密钥」证明不了任何事。
   * 所以确认拼出来的样本**确实够长、确实会被规则命中**。
   */
  const fake = await import('./lib/fake-secrets.mjs')
  check('假 OpenAI 密钥会被规则命中', scanSecrets(fake.FAKE_OPENAI).hits.length === 1)
  check('假 Slack token 会被规则命中', scanSecrets(fake.FAKE_SLACK).hits.length === 1)
  check('假 PEM 会被规则命中', scanSecrets(fake.FAKE_PEM_RSA).hits.length === 1)
  check('假 JWT 会被规则命中', scanSecrets(fake.FAKE_JWT).hits.length === 1)
  check(
    '假样本不是占位符式短串（否则测试会假通过）',
    !/sk-X{2,}/.test(fake.FAKE_OPENAI) && fake.FAKE_GITHUB.length > 24
  )
}

console.log('')
if (failures > 0) {
  console.log(`共 ${failures} 项失败`)
  process.exit(1)
}
console.log('全部通过')
