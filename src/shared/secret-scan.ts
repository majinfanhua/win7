/**
 * 敏感信息扫描（纯函数，可单独测试）。
 *
 * ## 为什么需要它
 *
 * 有两个地方的内容会「离开它原本的位置」：
 *   1. AI 把对话内容写进持久记忆 → 记忆是长期保留的，一句密钥就永久留在磁盘上
 *   2. 会话记录作为工具返回给模型 → 内容重新进上下文，可能被模型复述到别处
 *
 * 这两条路径都不是用户主动「交出密钥」，而是顺手粘了一段配置。
 * 不做检查的话，学生把 `.env` 贴进对话让 AI 帮忙看，
 * 密钥就跟着进了记忆文件，之后每次对话都被发出去。
 *
 * ## 为什么不拦「看起来像密码」的东西
 *
 * 匹配太宽会频繁误报，而误报的代价是**真实的**：AI 想记一句
 * 「用户的环境变量叫 DB_PASSWORD」都被拒，那这个功能就没法用了。
 * 所以只认那些**有固定形状、几乎不可能是巧合**的凭证格式
 * （OpenAI 的 sk-、AWS 的 AKIA、PEM 私钥头…）。
 * 宁可漏掉几个自造的 token，也不要拦到正常内容 ——
 * 后者会让用户直接把这个功能关掉，那才是真的失去保护。
 *
 * ## 不做「就近模糊」
 *
 * 只做精确形状匹配，不做熵值估计。高熵字符串在正常代码里到处都是
 * （hash、base64 的图标、压缩数据），按熵拦会拦到一堆正常内容。
 */

/** 一类凭证的识别规则 */
export interface SecretRule {
  /** 给人看的中文名，用于错误提示与脱敏标记 */
  label: string
  pattern: RegExp
}

/**
 * 规则表。
 *
 * ## 关于字符集里为什么要带 `-` 与 `_`
 *
 * OpenAI 的密钥并不是 `sk-` 后面接一串纯字母数字：新格式是
 * `sk-proj-xxxx`、`sk-svcacct-xxxx` 这种**带连字符的分段**形式。
 * 早期只写 `[A-Za-z0-9]` 的版本会把这些漏掉 —— 而漏掉是静默的，
 * 测试里那个 `sk-proj-…` 的例子就是专门用来钉住这一点的。
 *
 * ## 为什么 OpenAI 规则要排除 `sk-ant-`
 *
 * 否则一个 Anthropic 密钥会同时命中两条规则，界面上报出两个类别。
 * 用否定先行断言（`(?!ant-)`）分开。**只用先行，不用后行** ——
 * 后行断言在更老的 V8 上会让 RegExp 构造直接抛错（不是不匹配，
 * 是整个扫描失效），而这个应用要跑到 Win7 上的 Electron 22，
 * 没必要冒这个险。
 *
 * ⚠️ 规则之间是**全部都要跑**的（不是命中一条就停），所以新增规则时
 * 要确认它不会把别的类别的样本也吃掉，否则用户会看到重复的类别名。
 */
export const SECRET_RULES: SecretRule[] = [
  {
    label: '私钥文件内容',
    // 覆盖 RSA / EC / OPENSSH / PGP / 通用 PRIVATE KEY
    pattern: /-----BEGIN[ A-Z]*PRIVATE KEY-----/
  },
  {
    label: 'Anthropic API Key',
    pattern: /\bsk-ant-[A-Za-z0-9_-]{16,}/
  },
  {
    label: 'OpenAI API Key',
    // (?!ant-) 把 Anthropic 的让给上面那条
    pattern: /\bsk-(?!ant-)[A-Za-z0-9_-]{20,}/
  },
  {
    label: 'GitHub Token',
    pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}/
  },
  {
    label: 'AWS Access Key',
    pattern: /\bAKIA[0-9A-Z]{16}\b/
  },
  {
    label: 'Slack Token',
    pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}/
  },
  {
    label: 'Google API Key',
    pattern: /\bAIza[0-9A-Za-z_-]{35}\b/
  },
  {
    label: 'JSON Web Token',
    // 三段 base64url。每段都要求有长度，避免把普通的 a.b.c 也认成 JWT
    pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/
  }
]

export interface SecretHit {
  label: string
  /** 命中的原文（用于脱敏时定位） */
  sample: string
}

export interface ScanResult {
  hits: SecretHit[]
  /** 命中的类别名（去重），用于给用户的一句提示 */
  labels: string[]
}

/**
 * 扫描一段文本。
 *
 * 每个类别最多记一条命中：同一份 `.env` 里可能有十几个密钥，
 * 报十几条只会让提示变得没法读，而用户需要的只是「这里面有密钥」。
 */
export function scanSecrets(text: string): ScanResult {
  if (!text) return { hits: [], labels: [] }
  const hits: SecretHit[] = []
  for (const rule of SECRET_RULES) {
    // 用 match 而不是 test：test 带 g 标志时会有 lastIndex 状态，跨调用互相干扰
    const found = text.match(rule.pattern)
    if (found && found[0]) hits.push({ label: rule.label, sample: found[0] })
  }
  return { hits, labels: hits.map((hit) => hit.label) }
}

/** 是否含有敏感信息。只关心「有没有」时用它，比 scanSecrets 快一点也更好读 */
export function hasSecret(text: string): boolean {
  return SECRET_RULES.some((rule) => rule.pattern.test(text))
}

/**
 * 脱敏：把命中的凭证换成 `[已隐去：类别]`。
 *
 * 用于「会话记录回灌给模型」这条路 —— 那里不能直接拒绝整个操作
 * （那会让 AI 读不到整段对话），但也不能把密钥原样发出去。
 *
 * 注意是**替换而不是截断**：截断会破坏对话结构，
 * 而模型看到 `[已隐去：OpenAI API Key]` 仍然能理解「这里原本有个密钥」。
 */
export function redactSecrets(text: string): { text: string; redacted: number } {
  if (!text) return { text, redacted: 0 }
  let out = text
  let redacted = 0
  for (const rule of SECRET_RULES) {
    // 需要全局匹配做替换，这里现场造一个带 g 的副本，
    // 避免修改共享的 SECRET_RULES（带 g 的 regex 有 lastIndex 状态）
    const global = new RegExp(rule.pattern.source, `${rule.pattern.flags.replace('g', '')}g`)
    out = out.replace(global, () => {
      redacted++
      return `[已隐去：${rule.label}]`
    })
  }
  return { text: out, redacted }
}

/**
 * 给模型的拒绝理由。
 *
 * 措辞要点：说清「不要记什么」以及「该怎么办」，
 * 否则模型会换个写法再试一次，而它并不知道自己错在哪。
 */
export function describeSecretBlock(labels: string[], where: string): string {
  return (
    `BLOCKED: ${where}里检测到 ${labels.join('、')}。这类凭证不能写入长期存储 —— ` +
    '它会一直留在磁盘上，并且以后每次对话都可能被发出去。\n' +
    '请改用占位符（例如 API_KEY=你的密钥），或者只记「用户配置了某个服务的密钥」这件事本身，不要记具体的值。' +
    '也不要尝试换个格式重写同样的内容，那不是解决方式。'
  )
}
