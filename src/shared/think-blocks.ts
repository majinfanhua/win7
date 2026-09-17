/**
 * 把模型的输出切成「思考过程」与「正文」两段。
 *
 * ## 为什么需要这个
 *
 * 带推理的模型（DeepSeek-R1 系列、QwQ 等）会把思考过程也吐进同一个
 * 文本流里，用标签包起来：
 *
 *     用户在问 X。嗯，我先看看 <文件>… 这样不对，应该先读配置。
 *     </think>
 *     结论是：把 a.ts 第 12 行改成 b。
 *
 * 如果原样显示，学生看到的是一大段自言自语，真正的答案被埋在几千字之后 ——
 * 而这恰恰是「AI 在解释自己的推理」这种内容最该折叠的场景。
 *
 * ## 为什么几种标签都要认
 *
 * 不同模型/中转站用的标记不一样，实测至少这三种：
 *   - ` thinking…<｜end▁of▁thinking｜>`   DeepSeek 官方
 *   - `<thinking>…</thinking>` 部分模型
 *   - `…</think>`              只有**闭合**标签 —— 中转站常常把开标签
 *     或 `reasoning_content` 字段拼回正文时丢掉前半截，
 *     这时「第一个 </think> 之前的一切」都是思考过程
 *
 * ## 为什么不用正则一把梭
 *
 * 流式输出是**逐字到达**的，标签本身也可能被切成 `</thi` + `nk>`。
 * 所以这里的判定必须容忍「末尾有个不完整的标签」：
 * 宁可先当成正文显示一瞬，也不能把半截标签当正文渲染出来。
 * 做法是把「末尾可能是标签前缀」的部分留到最后再定（见 splitStreaming）。
 */

/** 一段内容：是思考过程还是正文 */
export interface TextSegment {
  kind: 'reasoning' | 'text'
  content: string
}

/** 能识别的一对标签 */
const PAIRS: Array<[string, string]> = [
  [' thinking', '<｜end▁of▁thinking｜>'],
  ['<thinking>', '</thinking>'],
  ['<reasoning>', '</reasoning>']
]

/** 只认闭合标签的兜底（中转站丢了开标签的情况） */
const LONE_CLOSE = ['</think>', '</thinking>', '</reasoning>']

/**
 * 所有可能出现标签的**前缀**集合。
 *
 * 流式时用来判断「末尾这几个字符会不会是标签的开头」：
 * 如果是，就先不渲染它们，等下一批字符到了再定。
 * 不做这件事的话，`</thi` 会一闪而过地被当成正文。
 */
export function tagPrefixLength(tail: string): number {
  let best = 0
  for (const tag of [...PAIRS.flat(), ...LONE_CLOSE]) {
    // 从最长可能的前缀开始试：tail 的后缀是否是 tag 的前缀
    for (let len = Math.min(tail.length, tag.length - 1); len > 0; len--) {
      if (tail.endsWith(tag.slice(0, len))) {
        if (len > best) best = len
        break
      }
    }
  }
  return best
}

/**
 * 切分完整文本（流结束后用，或对历史消息用）。
 *
 * 规则，按优先级：
 *   1. 成对标签：里面的内容是 reasoning
 *   2. 只出现闭合标签（且没有开标签）：**它之前**的一切都是 reasoning ——
 *      这是中转站丢掉开标签时的形态
 *   3. 什么都没有：整段是正文
 */
export function splitReasoning(raw: string): TextSegment[] {
  if (!raw) return []
  const out: TextSegment[] = []

  // 逐个启用「成对标签」扫描，取最先出现的那个
  let firstIdx = -1
  let open = ''
  let close = ''
  for (const [o, c] of PAIRS) {
    const i = raw.indexOf(o)
    if (i >= 0 && (firstIdx < 0 || i < firstIdx)) {
      firstIdx = i
      open = o
      close = c
    }
  }

  if (firstIdx < 0) {
    /*
     * 没有成对标签。看有没有**孤立的**闭合标签 ——
     * 有的话，它之前全是思考过程（中转站把开标签吞了）。
     */
    let loneIdx = -1
    let loneTag = ''
    for (const tag of LONE_CLOSE) {
      const i = raw.indexOf(tag)
      if (i >= 0 && (loneIdx < 0 || i < loneIdx)) {
        loneIdx = i
        loneTag = tag
      }
    }
    if (loneIdx < 0) {
      // 纯正文
      return raw ? [{ kind: 'text', content: raw }] : []
    }
    const head = raw.slice(0, loneIdx)
    const rest = raw.slice(loneIdx + loneTag.length)
    if (head) out.push({ kind: 'reasoning', content: head })
    if (rest.trim()) out.push({ kind: 'text', content: rest.replace(/^\s*\n/, '') })
    return out
  }

  // 开标签之前的是正文
  const before = raw.slice(0, firstIdx)
  if (before) out.push({ kind: 'text', content: before })

  // 找配对的闭合标签；找不到就认为「还没想完」，剩下的全是 reasoning
  const closeIdx = raw.indexOf(close, firstIdx + open.length)
  if (closeIdx < 0) {
    const body = raw.slice(firstIdx + open.length)
    if (body) out.push({ kind: 'reasoning', content: body })
    return out
  }

  const body = raw.slice(firstIdx + open.length, closeIdx)
  if (body) out.push({ kind: 'reasoning', content: body })

  // 闭合标签之后可能还有下一段（多个思考块）
  const after = raw.slice(closeIdx + close.length)
  if (after) out.push(...splitReasoning(after))
  return out
}

/**
 * 流式期间的切分：与 splitReasoning 相同，但**末尾可能不完整的标签**
 * 会被摘出来单独返回，让调用方这一帧先不渲染它。
 *
 * 返回 `pending` 是要留到下一次的尾巴。它只可能是因为「看起来像标签开头」
 * 才被留下 —— 正常文本永远立刻返回，不会延迟显示。
 */
export function splitReasoningStreaming(raw: string): {
  segments: TextSegment[]
  pending: string
} {
  const keep = tagPrefixLength(raw)
  if (keep === 0) return { segments: splitReasoning(raw), pending: '' }
  const head = raw.slice(0, raw.length - keep)
  return { segments: splitReasoning(head), pending: raw.slice(raw.length - keep) }
}

/**
 * 把正文与思考过程各自拼回一个字符串，给持久化用。
 *
 * 存的是**原始文本**（带标签），不是切好的段 ——
 * 这样历史消息重新打开时还能按同一套规则折叠，
 * 而且以后改折叠规则也不需要迁移旧数据。
 */
export function hasReasoning(raw: string): boolean {
  return splitReasoning(raw).some((s) => s.kind === 'reasoning')
}
