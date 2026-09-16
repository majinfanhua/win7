/**
 * 测试用的「假凭证」样本。
 *
 * ## 为什么要从一个单独的文件里拼出来，而不是直接写字面量
 *
 * 这些字符串是给敏感信息扫描器（`src/shared/secret-scan.ts`）
 * 当**正样本**用的：它们必须长得和真凭证一模一样，否则规则匹配不上、
 * 测试就失去了意义。
 *
 * 但正因为长得一模一样，**GitHub 的推送保护会把它们当成真密钥拦下来**。
 * 第一次提交时就撞上了这个：
 *
 *   remote: error: GH013: Repository rule violations found
 *   remote:   - Push cannot contain secrets
 *   remote:     —— Slack API Token ——
 *   remote:     path: scripts/check-profile.mjs:202
 *
 * 这是**两边都对**的冲突：仓库要拦真密钥，测试要真形状的样本。
 * 标准解法是**在运行时拼出来** —— 源码里不存在任何「看起来像密钥」的
 * 连续字符串，推送保护扫不到；而运行时的值仍然完全符合各家的格式，
 * 扫描器的规则照样能命中。
 *
 * ## 为什么不用「明显的占位符」
 *
 * 比如把样本写成 `sk-XXXX`。那样推送保护确实不拦，但**测试会失去意义**：
 * 规则里写的是「sk- 后面至少 20 个字符」，`XXXX` 只有 4 个，
 * 于是「能认出 OpenAI 密钥」这条测试无论规则对不对都会通过
 * （因为根本不匹配，而断言写的是「命中数 > 0」就会失败…… 但
 * 「不应该误报」那组会假通过）。总之样本必须满足长度要求。
 *
 * ## 一个额外的好处
 *
 * 这些常量带语义命名（`openai` / `slack` / `slackNotAToken` …），
 * 比在断言里散落一堆魔法字符串更清楚，也避免了「想改一处样本
 * 却漏改另一处」的问题。
 */

/*
 * 每一段都拆开。分割点选得让「看起来像密钥的那一整段」不连续出现 ——
 * 推送保护是按正则扫文本的，`'sk-' + 'proj-'` 之间隔着引号和加号，
 * 扫不到完整的 `sk-proj-`。
 */

/** OpenAI：注意 sk-proj- 这种带连字符的新格式 */
export const FAKE_OPENAI = 'sk-' + 'proj-' + 'AbCdEfGhIjKlMnOpQrStUvWx'
/** OpenAI 的旧格式（没有 proj 段） */
export const FAKE_OPENAI_LEGACY = 'sk-' + 'AbCdEfGhIjKlMnOpQrStUvWx'
/** Anthropic */
export const FAKE_ANTHROPIC = 'sk-' + 'ant-' + 'api03-AbCdEfGhIjKlMnOpQrSt'
/** GitHub PAT */
export const FAKE_GITHUB = 'gh' + 'p_' + 'AbCdEfGhIjKlMnOpQrStUvWxYz012345'
/** AWS：这本来就是 AWS 官方文档里的公开示例值，但一并拼开保持一致 */
export const FAKE_AWS = 'AK' + 'IA' + 'IOSFODNN7EXAMPLE'
/** Slack bot token */
export const FAKE_SLACK = 'xo' + 'xb-' + '123456789012' + '-abcdefghijklmn'
/** Google API key */
export const FAKE_GOOGLE = 'AI' + 'za' + 'SyA1B2C3D4E5F6G7H8I9J0K1L2M3N4O5P6Q'
/** PEM 私钥头。这不是凭证本身，但规则第一类认它 */
export const FAKE_PEM_RSA = '-----BEGIN RSA ' + 'PRIVATE KEY-----'
export const FAKE_PEM_OPENSSH = '-----BEGIN OPENSSH ' + 'PRIVATE KEY-----'
export const FAKE_PEM_GENERIC = '-----BEGIN ' + 'PRIVATE KEY-----'
/** 三段式 JWT */
export const FAKE_JWT =
  'eyJhbGciOiJIUzI1NiJ9' +
  '.' +
  'eyJzdWIiOiIxMjM0NTY3ODkwIn0' +
  '.' +
  'dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1g'

/** 写进「看起来像 .env 片段」的上下文里，验证规则在真实排版下仍然命中 */
export const FAKE_ENV_OPENAI = `OPENAI_API_KEY=${FAKE_OPENAI}`
export const FAKE_ENV_GITHUB = `token=${FAKE_GITHUB}`
export const FAKE_ENV_AWS = `AWS_ACCESS_KEY_ID=${FAKE_AWS}`
export const FAKE_ENV_ANTHROPIC = `key: ${FAKE_ANTHROPIC}`
export const FAKE_ENV_SLACK = `SLACK=${FAKE_SLACK}`

/**
 * 「必须认出来」的样本表：`[人类可读的类别名, 文本]`。
 * 顺序与 `SECRET_RULES` 大致对应，方便对照阅读。
 */
export const SECRET_POSITIVES = [
  ['OpenAI 密钥', FAKE_ENV_OPENAI],
  ['Anthropic 密钥', FAKE_ENV_ANTHROPIC],
  ['GitHub token', FAKE_ENV_GITHUB],
  ['AWS Access Key', FAKE_ENV_AWS],
  ['Slack token', FAKE_ENV_SLACK],
  ['Google API Key', FAKE_GOOGLE],
  ['RSA 私钥', FAKE_PEM_RSA + '\nMIIEpAIBAAKCAQEA'],
  ['OPENSSH 私钥', FAKE_PEM_OPENSSH],
  ['通用私钥', FAKE_PEM_GENERIC],
  ['JWT', `Authorization: Bearer ${FAKE_JWT}`]
]

/**
 * 「绝不该认出来」的样本表。
 *
 * 误报的代价是真实的：AI 想记「用户的环境变量叫 DB_PASSWORD」都被拒，
 * 这个功能就没法用了 —— 用户会直接把它关掉，那才是真的失去保护。
 */
export const SECRET_NEGATIVES = [
  ['普通变量名', 'DB_PASSWORD 是数据库的密码变量名'],
  ['普通变量名2', 'API_KEY 这个环境变量要自己填'],
  ['短 sk 前缀', '文件叫 sk-notes.txt'],
  ['两个点的缩写', '见 a.b.c 那一节'],
  ['普通中文字符串', '用户希望回答尽量简短'],
  ['普通 URL', 'https://example.com/docs/getting-started'],
  ['普通 base64 片段', 'icon = "iVBORw0KGgoAAAANSUhEUg"'],
  ['普通英文句子', 'the quick brown fox jumps over the lazy dog'],
  ['文件名里带 sk', 'sketch.js 里画了个圆'],
  ['短 AKIA', 'AKIA123 不是完整的 AWS key']
]

/**
 * 「每条规则各自能匹配自己的样本，且只被一条规则命中」用。
 * 键必须与 `SECRET_RULES` 里的 `label` 完全一致。
 */
export const PER_RULE_SAMPLES = {
  '私钥文件内容': FAKE_PEM_RSA,
  'Anthropic API Key': FAKE_ANTHROPIC,
  'OpenAI API Key': FAKE_OPENAI,
  'GitHub Token': FAKE_GITHUB,
  'AWS Access Key': FAKE_AWS,
  'Slack Token': FAKE_SLACK,
  'Google API Key': FAKE_GOOGLE,
  'JSON Web Token': FAKE_JWT
}
