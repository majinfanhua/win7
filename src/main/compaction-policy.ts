/**
 * 长对话的上下文预算与压缩策略。
 *
 * ## 要解决的问题
 *
 * 一次提问里，历史消息是**全部**发给模型的。教学场景下学生经常在一个
 * 会话里连续问十几轮，还夹着 readFile 读进来的整段源码 —— 上下文很快就
 * 撞上模型窗口上限，中转站直接返回 400，表现为「聊到一半突然不能用了」。
 *
 * ## 做法
 *
 * 借鉴 LiveAgent 的策略层（policy.ts），但只取**判定**这部分，
 * 不引入它那套完整的 Segment + Summary Checkpoint 存储：
 *
 *   1. 先**裁剪**历史里最占地方的旧工具输出（不花钱、无副作用），
 *      这是第一道防线，多数情况到这一步就够了
 *   2. 裁剪还不够，才提示「需要压缩」——由上层决定是否总结
 *
 * 阈值取 `contextWindow - maxOutputToken * factor`，而不是整个窗口：
 * 必须给模型的回答留出空间，否则输入刚好占满、输出没地方放，照样报错。
 *
 * ## 为什么因子是 1.2 / 1.5
 *
 * 日常主动压缩留更多余量（1.5），运行中被迫保护时收紧（1.2）。
 * 数值直接照搬 LiveAgent，它们是与真实中转站磨合出来的经验值。
 */

/** 主动（发请求前）判断时的余量因子 */
export const OPTIMIZATION_THRESHOLD_FACTOR = 1.5
/** 运行中保护性判断时的余量因子 */
export const PROTECTION_THRESHOLD_FACTOR = 1.2

/** 两次压缩之间的最短间隔，避免刚压完又立刻压 */
export const MIN_COMPACTION_INTERVAL_MS = 60_000
/** 用户消息少于这个数就不压 —— 太短的对话压了反而丢信息 */
export const MIN_COMPACTION_USER_MESSAGES = 3
/** 超过这个时长没有新压缩，压力等级归零 */
export const RECENT_COMPACTION_WINDOW_MS = 5 * 60_000
/** 压缩后仍高于阈值的这个比例，算「低效压缩」，推高压力等级 */
export const INEFFECTIVE_COMPACTION_RATIO = 0.9
/** 压力等级上限 */
export const MAX_PRESSURE_LEVEL = 2

/** 一次裁剪至少释放这么多 token 才值得做 */
export const PRUNE_MINIMUM_TOKENS = 20_000
/** 各压力等级下保护的旧工具输出 token 数（等级越高保护越少） */
const PRUNE_PROTECT_TOKENS_BY_LEVEL = [40_000, 20_000, 10_000] as const
/** 各压力等级下保护的最近用户轮数 */
const PRUNE_PROTECT_USER_TURNS_BY_LEVEL = [2, 2, 1] as const

export type PressureLevel = 0 | 1 | 2

/**
 * 压力状态。
 *
 * 用来替代「压缩次数硬上限」：连续压不动时逐级加大力度，
 * 而不是直接拒绝压缩 —— 拒绝的后果是上下文继续涨到报错为止。
 */
export interface CompactionPressure {
  level: PressureLevel
  consecutiveIneffective: number
  compactionsApplied: number
  /** 上次压缩时间戳（毫秒），0 表示还没压过 */
  lastCompactionAt: number
}

export function createCompactionPressure(): CompactionPressure {
  return { level: 0, consecutiveIneffective: 0, compactionsApplied: 0, lastCompactionAt: 0 }
}

/** 静默一段时间后把压力等级归零 */
export function normalizePressure(p: CompactionPressure, now: number): CompactionPressure {
  if (
    p.lastCompactionAt > 0 &&
    now - p.lastCompactionAt > RECENT_COMPACTION_WINDOW_MS &&
    (p.level > 0 || p.consecutiveIneffective > 0)
  ) {
    return { ...p, level: 0, consecutiveIneffective: 0 }
  }
  return p
}

/** 记录一次压缩的结果，据此升降压力等级 */
export function notePressureAfterCompaction(
  p: CompactionPressure,
  params: { totalTokensAfter: number; threshold: number; now: number }
): CompactionPressure {
  const ineffective =
    params.threshold > 0 && params.totalTokensAfter > params.threshold * INEFFECTIVE_COMPACTION_RATIO
  const consecutiveIneffective = ineffective ? p.consecutiveIneffective + 1 : 0
  return {
    level: Math.min(MAX_PRESSURE_LEVEL, consecutiveIneffective) as PressureLevel,
    consecutiveIneffective,
    compactionsApplied: p.compactionsApplied + 1,
    lastCompactionAt: params.now
  }
}

export interface PruneOptions {
  minimumReleasedTokens: number
  protectedToolTokens: number
  protectedRecentUserTurns: number
}

/** 按压力等级决定裁剪力度 */
export function resolvePruneOptions(p: CompactionPressure): PruneOptions {
  return {
    minimumReleasedTokens: PRUNE_MINIMUM_TOKENS,
    protectedToolTokens: PRUNE_PROTECT_TOKENS_BY_LEVEL[p.level],
    protectedRecentUserTurns: PRUNE_PROTECT_USER_TURNS_BY_LEVEL[p.level]
  }
}

/** 压力等级 >= 1、或刚压过不久，就先做一轮裁剪 */
export function shouldPruneBeforeCompaction(p: CompactionPressure, now: number): boolean {
  if (p.level >= 1) return true
  return p.lastCompactionAt > 0 && now - p.lastCompactionAt <= RECENT_COMPACTION_WINDOW_MS
}

/*
 * ── 模型上下文窗口 ────────────────────────────────────────────
 *
 * ⚠️ 这些数字是**按模型名匹配的保守估计**，不是权威数据。
 *
 * 为什么需要它：中转站的 /models 接口只给模型名，不给窗口大小，
 * 而用户填什么模型名我们无法预知。没有这张表就只能「全都按最小值算」，
 * 白白浪费长上下文模型的能力（学生读个大文件就触发压缩）。
 *
 * 匹配不到就退到 DEFAULT_CONTEXT_WINDOW —— 刻意取偏小的值：
 * 估大了会直接撞墙报错（用户看到的是一次失败的提问），
 * 估小了只是提前压缩（还能继续用）。代价不对称，所以往小里取。
 */

const DEFAULT_CONTEXT_WINDOW = 32_000
const DEFAULT_MAX_OUTPUT = 4_000

interface ModelLimits {
  contextWindow: number
  maxOutputToken: number
}

/**
 * 按子串匹配的窗口表。
 *
 * 顺序有意义：先匹配到的先用，所以**更具体的写前面**。
 * 例如 `gpt-4o-mini` 必须排在 `gpt-4o` 之前。
 */
const MODEL_TABLE: Array<[RegExp, ModelLimits]> = [
  // —— OpenAI ——
  [/gpt-4o-mini/i, { contextWindow: 128_000, maxOutputToken: 16_384 }],
  [/gpt-4o/i, { contextWindow: 128_000, maxOutputToken: 16_384 }],
  [/gpt-4-turbo/i, { contextWindow: 128_000, maxOutputToken: 4_096 }],
  [/gpt-4\.1/i, { contextWindow: 128_000, maxOutputToken: 16_384 }],
  [/gpt-4/i, { contextWindow: 8_192, maxOutputToken: 4_096 }],
  [/gpt-3\.5/i, { contextWindow: 16_385, maxOutputToken: 4_096 }],
  [/o1-mini|o3-mini/i, { contextWindow: 128_000, maxOutputToken: 16_384 }],
  [/^o1|^o3|^o4/i, { contextWindow: 200_000, maxOutputToken: 32_000 }],
  // —— Anthropic ——
  [/claude-3[-.]?5|claude-3-5/i, { contextWindow: 200_000, maxOutputToken: 8_192 }],
  [/claude-3/i, { contextWindow: 200_000, maxOutputToken: 4_096 }],
  [/claude/i, { contextWindow: 200_000, maxOutputToken: 8_192 }],
  // —— Google ——
  [/gemini-1\.5|gemini-2/i, { contextWindow: 1_000_000, maxOutputToken: 8_192 }],
  [/gemini/i, { contextWindow: 128_000, maxOutputToken: 8_192 }],
  // —— 国内常见 ——
  [/deepseek-reasoner/i, { contextWindow: 64_000, maxOutputToken: 8_192 }],
  [/deepseek/i, { contextWindow: 64_000, maxOutputToken: 8_192 }],
  [/qwen|通义/i, { contextWindow: 128_000, maxOutputToken: 8_192 }],
  [/glm|chatglm/i, { contextWindow: 128_000, maxOutputToken: 4_096 }],
  [/moonshot|kimi/i, { contextWindow: 128_000, maxOutputToken: 4_096 }],
  [/yi-|零一/i, { contextWindow: 16_000, maxOutputToken: 4_096 }],
  [/ernie|文心/i, { contextWindow: 8_000, maxOutputToken: 2_048 }],
  [/spark|星火/i, { contextWindow: 8_000, maxOutputToken: 4_096 }]
]

/**
 * 查一个模型的窗口与输出上限。
 *
 * @param model 用户填的模型名，可能带中转站前缀（如 `openai/gpt-4o`）
 * @param override 用户在设置里手填的值，优先于内置表
 */
export function resolveModelLimits(model: string, override?: Partial<ModelLimits>): ModelLimits {
  const name = (model || '').trim()

  for (const [pattern, limits] of MODEL_TABLE) {
    if (pattern.test(name)) {
      return {
        contextWindow: override?.contextWindow ?? limits.contextWindow,
        maxOutputToken: override?.maxOutputToken ?? limits.maxOutputToken
      }
    }
  }

  return {
    contextWindow: override?.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
    maxOutputToken: override?.maxOutputToken ?? DEFAULT_MAX_OUTPUT
  }
}

/** 内置表是否认识这个模型（设置页据此提示「用的是保守估计」） */
export function isModelKnown(model: string): boolean {
  const name = (model || '').trim()
  return MODEL_TABLE.some(([pattern]) => pattern.test(name))
}

/**
 * 解析出真正要用的窗口与输出上限，并把「用户留 0 = 自动」这条规则收在这里。
 *
 * ⚠️ 这个函数存在的唯一理由：`contextWindow: 0` 在配置里表示「按模型名自动判断」，
 * 但 0 直接传进 decideCompaction 会被当成「窗口未知」而永久禁用压缩。
 * 两者语义相反，很容易接错 —— 所以统一走这里，不要在调用处各自判断。
 */
export function resolveBudgetForModel(ai: {
  model: string
  contextWindow?: number
  maxOutputTokens?: number
}): ModelLimits {
  return resolveModelLimits(ai.model, {
    // 0 / undefined / 负数都视为「没填」，交给内置表
    contextWindow: ai.contextWindow && ai.contextWindow > 0 ? ai.contextWindow : undefined,
    maxOutputToken: ai.maxOutputTokens && ai.maxOutputTokens > 0 ? ai.maxOutputTokens : undefined
  })
}

/* ── 判定 ─────────────────────────────────────────────────── */

export type CompactionIntent = 'optimization' | 'protection'

export type CompactionReason =
  | 'disabled'
  | 'no-active-messages'
  | 'below-threshold'
  | 'cooldown'
  | 'threshold-exceeded'

export interface CompactionDecision {
  shouldCompact: boolean
  reason: CompactionReason
  /** 触发阈值（token） */
  threshold: number
  totalTokens: number
  contextWindow: number
  maxOutputToken: number
}

/**
 * 阈值 = 窗口 − 输出预留 × 因子。
 *
 * 下限 1024 保证小窗口模型（如 8k）也有个正数阈值，
 * 不会因为算出来是负数而永远不触发。
 */
export function resolveThreshold(params: {
  intent: CompactionIntent
  contextWindow: number
  maxOutputToken: number
  pressureLevel: PressureLevel
}): number {
  const factor =
    params.intent === 'optimization' ? OPTIMIZATION_THRESHOLD_FACTOR : PROTECTION_THRESHOLD_FACTOR
  // 压力到顶时把保护因子也降到 1.0：余量已经保不住了，先保证能发出去
  const effective =
    params.intent === 'protection' && params.pressureLevel >= MAX_PRESSURE_LEVEL ? 1.0 : factor
  return Math.max(1024, Math.floor(params.contextWindow - params.maxOutputToken * effective))
}

/**
 * 是否该压缩。
 *
 * 判定顺序即优先级：
 *   窗口未知（disabled）→ 没有活跃消息 → 低于阈值 → 冷却中 → 该压了
 *
 * 冷却期只在「刚压完又立刻越阈值」时挡一下，且要求用户消息数够多；
 * 否则一次超大粘贴会把正常对话永久卡在冷却里。
 */
export function decideCompaction(params: {
  intent: CompactionIntent
  totalTokens: number
  contextWindow: number
  maxOutputToken: number
  activeMessageCount: number
  userMessageCount: number
  lastCompactionAt: number
  pressure: CompactionPressure
  now: number
  /** 手动压缩：跳过阈值与冷却，硬守卫仍然生效 */
  bypassThresholdAndCooldown?: boolean
}): CompactionDecision {
  const contextWindow = Math.max(0, Math.floor(params.contextWindow || 0))
  const maxOutputToken = Math.max(0, Math.floor(params.maxOutputToken || 0))
  const totalTokens = Math.max(0, Math.floor(params.totalTokens || 0))

  const base = { totalTokens, contextWindow, maxOutputToken }

  if (contextWindow <= 0 || maxOutputToken <= 0) {
    return { ...base, shouldCompact: false, reason: 'disabled', threshold: 0 }
  }

  const threshold = resolveThreshold({
    intent: params.intent,
    contextWindow,
    maxOutputToken,
    pressureLevel: params.pressure.level
  })

  if (params.activeMessageCount <= 0) {
    return { ...base, shouldCompact: false, reason: 'no-active-messages', threshold }
  }

  if (!params.bypassThresholdAndCooldown && totalTokens < threshold) {
    return { ...base, shouldCompact: false, reason: 'below-threshold', threshold }
  }

  if (
    !params.bypassThresholdAndCooldown &&
    params.lastCompactionAt > 0 &&
    params.now - params.lastCompactionAt < MIN_COMPACTION_INTERVAL_MS &&
    params.userMessageCount < MIN_COMPACTION_USER_MESSAGES
  ) {
    return { ...base, shouldCompact: false, reason: 'cooldown', threshold }
  }

  return { ...base, shouldCompact: true, reason: 'threshold-exceeded', threshold }
}

/**
 * 粗略估 token 数。
 *
 * 中文约 1 字 1 token，英文约 4 字符 1 token，这里按 2 字符 1 个折中。
 * 只用于**触发判断**，不用于计费 —— 真实用量以中转站返回的 usage 为准。
 * 估偏一点没关系：偏大只会提前压缩，偏小也只是晚一点压。
 */
export function roughTokens(text: string): number {
  return Math.ceil((text || '').length / 2)
}
