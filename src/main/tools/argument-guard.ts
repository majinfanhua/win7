/**
 * 工具调用参数「截断」守卫。
 *
 * 背景：流式返回的 tool_calls 参数是分片拼起来的（见 ai.ts 的 absorb）。
 * 如果连接在参数传到一半时断掉，拼出来的就是一个**残缺的 JSON**。
 * 危险的地方不在于它拼不出来 —— 而在于有些残缺片段恰好能被「宽容修复」
 * 成一个看起来合理、实际错误的值：
 *
 *   {"path":"C:\\Users\\
 *
 * 这种截断如果被补成 {"path":"C:\\Users\\"}，模型本意是要读某个具体文件，
 * 结果变成了另一个（可能存在的）路径，执行下去就是改了不该改的东西。
 * 更隐蔽的是 arguments 为空串的情况，会被当成「无参数」而放行。
 *
 * 这个模块只做**判定**，不改事件、不重排、不中断：
 * 把「参数流没传完」这件事识别出来，交给调用方拒绝执行并说明原因，
 * 让模型有机会重试。绝不静默「修复」后照跑。
 *
 * 三种流形态都要能正确区分（这是本模块最容易写错的地方）：
 *   1. 正常增量流：分片拼起来就是完整 JSON → 健康
 *   2. 累计快照流：每片都是「到目前为止的完整内容」，拼起来是坏的，
 *      但**最后一片单独看是完整 JSON** → 健康，不能误报
 *   3. 重复帧流：同一份内容被重复送，拼起来是坏的，但单帧完整 → 健康
 *   4. 真截断：拼起来坏，且**没有任何单独一片是完整的** → 报错
 */
import { logger } from '../logger'

export interface GuardedToolCall {
  id: string
  function: { name?: string; arguments?: string }
}

/** 判定结果：这些调用是「参数没传完」的，不能执行 */
export interface TruncationReport {
  /** 有问题的工具调用 id 集合 */
  truncated: Set<string>
  /** 每个有问题的 id 对应的人类可读原因 */
  reasons: Map<string, string>
}

/**
 * 尝试用「宽容」方式把流式片段补成合法 JSON。
 *
 * 只处理补括号这一种情况（未闭合的 { [ 和未闭合的字符串），
 * 这是流式分片最常见的残尾。补不出来就返回 null。
 *
 * 刻意保持保守：宁可返回 null（上层据此报错），也不要猜出一个
 * 语义上不同但语法合法的结构。
 */
export function parseStreamingJson(raw: string): unknown | null {
  const text = (raw || '').trim()
  if (!text) return null
  try {
    return JSON.parse(text)
  } catch {
    /* 走补全 */
  }

  // 逐字符扫描，记录未闭合的括号与是否停在字符串里
  const stack: string[] = []
  let inString = false
  let escaped = false
  for (const ch of text) {
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') inString = true
    else if (ch === '{' || ch === '[') stack.push(ch)
    else if (ch === '}' || ch === ']') stack.pop()
  }

  // 停在字符串中间：不能简单补个引号就算数 —— 后面可能还有内容，
  // 补出来的值会与模型本意不同。这种情况判定为「修不了」。
  if (inString || escaped) return null

  let patched = text
  // 去掉可能悬空的尾逗号，否则补括号后仍是坏的
  patched = patched.replace(/,\s*$/, '')
  for (let i = stack.length - 1; i >= 0; i--) {
    patched += stack[i] === '{' ? '}' : ']'
  }
  try {
    return JSON.parse(patched)
  } catch {
    return null
  }
}

function isCompleteJson(text: string): boolean {
  const t = (text || '').trim()
  if (!t) return false
  try {
    JSON.parse(t)
    return true
  } catch {
    return false
  }
}

/**
 * 一轮流式响应收到的原始分片记录。
 *
 * 由 streamRound 在解析 SSE 时顺手填，而不是事后再猜 ——
 * 拼好的 arguments 已经把「分片边界」这个信息丢掉了，
 * 只看最终字符串无法区分「真截断」和「累计快照流」。
 */
export class ToolArgumentTracker {
  /** contentIndex/工具下标 -> 拼接起来的原始参数 */
  private buffers = new Map<number, string>()
  /** contentIndex -> 最后一片原文（用于识别累计快照流） */
  private lastDeltas = new Map<number, string>()

  reset(): void {
    this.buffers.clear()
    this.lastDeltas.clear()
  }

  noteDelta(index: number, fragment: string): void {
    if (!fragment) return
    this.buffers.set(index, (this.buffers.get(index) ?? '') + fragment)
    this.lastDeltas.set(index, fragment)
  }

  /**
   * 一轮结束时判定。
   *
   * @param calls 已经拼好的工具调用（id + 最终 arguments）
   */
  report(calls: GuardedToolCall[]): TruncationReport {
    const truncated = new Set<string>()
    const reasons = new Map<string, string>()

    for (const [index, call] of calls.entries()) {
      const buffer = this.buffers.get(index) ?? ''
      const lastDelta = this.lastDeltas.get(index) ?? ''

      // 一片都没收到：参数是**在 end 事件里整体送来**的，不是流式的。
      // 这是正常形态（有些中转站就这么发），不能报错。
      if (!buffer.trim()) continue

      // 拼起来就是完整 JSON → 健康
      if (isCompleteJson(buffer)) continue

      /*
       * 累计快照流 / 重复帧流：拼起来是坏的，但最后一片单独看是完整 JSON，
       * 且它就是最终参数 —— 这种流是健康的，误报会白白打断正常对话。
       */
      if (lastDelta.trim() && isCompleteJson(lastDelta)) continue

      /*
       * 走到这里说明：分片存在、拼起来却不是完整 JSON，而且最后一片
       * 也不是一份独立的完整参数（否则上面已经放行了）——
       * 提供方没有给我们任何一份完整来源，参数确实没传完。
       *
       * 这里曾经只判「残缺 buffer 的宽容补全恰好等于最终参数」，
       * 结果漏掉了**最危险**的一类：停在字符串中间的截断
       * （例如 {"path":"C:\Users\ 被切断），它补不成合法 JSON，
       * 于是被判成「无害」，最后以空参数执行下去。
       * 现在统一为：凡是没能形成完整 JSON、又没有独立完整副本的，一律报截断。
       */
      truncated.add(call.id)
      reasons.set(
        call.id,
        '参数 JSON 在传完之前就断了（很可能是网络中断或中转站提前结束响应）'
      )
    }

    if (truncated.size > 0) {
      logger.warn(
        'ai',
        `检测到 ${truncated.size} 个工具调用的参数不完整，已拒绝执行: ${[...truncated].join(', ')}`
      )
    }
    return { truncated, reasons }
  }
}

/**
 * 给模型的拒绝说明。
 *
 * 要明确说「不要照这个参数重试」，否则模型可能原样再发一次；
 * 同时告诉它正确做法是重新读取/重新确认后再调用。
 */
export function describeTruncatedCall(name: string, reason: string): string {
  return (
    `TOOL_ARGUMENTS_TRUNCATED: ${name} 的参数没有完整传过来（${reason}）。` +
    '为避免用残缺参数执行造成误改，本次调用已被拒绝，文件未改动。' +
    '请重新发起这次工具调用；如果需要依据文件当前内容，请先重新读取确认，不要凭记忆重发同样的参数。'
  )
}
