import type { AiUsage, ChatContent } from '../shared/types'
import { SUMMARY_MARKER } from '../shared/types'
import { redactSecrets } from '../shared/secret-scan'
import {
  createCompactionPressure,
  normalizePressure,
  notePressureAfterCompaction,
  type CompactionPressure
} from './compaction-policy'
import { callModelOnce } from './llm'
import { logger } from './logger'
import { sessionSystemPrompt } from './system-doc'
import { toolSchemasForModel } from './tools'
import { recordUsage } from './usage'
import { getConfig } from './config'

/**
 * 上下文压缩的**执行**部分（判定在 compaction-policy.ts）。
 *
 * ## 为什么要分开
 *
 * 判定是纯函数，护栏可以直接钉住（`scripts/check-context-budget.mjs`），
 * 不必起窗口、不必联网。而执行要调模型、要花钱、会失败，
 * 必须放在能读到 API Key 的主进程里。
 *
 * ## 压缩做什么
 *
 * 把**较早的**对话总结成一段话，插回消息最前面，保留最近若干轮原文：
 *
 *     [system] [摘要] [最近 2 轮原文...] [这一轮的新提问]
 *
 * 这样模型既知道「我们之前干了什么」，又对「刚才那几步」有完整记忆 ——
 * 后者是它继续动手（改文件、跑命令）所必需的，从摘要里是读不出来的。
 *
 * ## 与「归档总结」的区别（别把两者合并）
 *
 * 两者都调模型总结，但**目的相反**：
 *   - 归档总结（archive.ts）：给**以后检索**用，要的是「我们讨论过什么」
 *   - 压缩总结（本文件）：给**立刻接着聊**用，要的是「任务进行到哪一步」
 *
 * 用归档那段提示词来做压缩，得到的是「讨论过什么问题、结论是什么」，
 * 而模型真正需要的是「当前在改哪个文件、上一步做了什么、还没做完什么」。
 * 所以提示词必须各写一份。
 */

/**
 * 摘要正文的长度上限（字符）。
 *
 * 比归档的 400 字大：归档只记「讨论过什么」，而压缩后的摘要要承接
 * 整个任务状态（改了哪些文件、进行到哪一步、还剩什么），
 * 400 字装不下，压太狠会丢掉关键上下文，反而导致模型重复劳动。
 *
 * 也不要太大：摘要本身也是要每轮都发的，写太长等于压缩白做。
 */
export const COMPACT_SUMMARY_MAX = 900

/**
 * 压缩总结用的提示词。
 *
 * 每一条都对应一个具体的失败模式，改之前先看：
 *   1. 「正在进行的任务、改了哪些文件」—— 漏了模型会重新问一遍
 *      「你想让我做什么」，学生刚说完的话等于白说
 *   2. 「不要罗列每一轮」—— 模型很爱写成流水账，占满预算却没信息量
 *   3. 「没做完的要写明」—— 最容易被漏，而它恰恰是下一步最需要的
 *   4. 「不要编造」—— 模型会为了总结得完整而补上对话里没有的结论，
 *      那会让它照着假前提继续动手改文件，比不总结危险得多
 */
const COMPACT_INSTRUCTION =
  '上面这段对话接下来还要继续。请把它压缩成一段「交接说明」，让另一个同样聪明的助手\n' +
  '读完之后能立刻接着干活。要求：\n' +
  '1. 直接输出正文，不要任何前缀（不要写「总结：」「这段对话」）。\n' +
  '2. 必须写清：用户要做什么、已经做了什么、改了哪些文件（有路径就写路径）、\n' +
  '   当前进行到哪一步、还有什么没做完。\n' +
  '3. 不要复述每一轮说了什么，不要写成流水账。\n' +
  '4. 只写对话里确实出现过的事实，不要补充你的推测或建议。\n' +
  `5. 控制在 ${COMPACT_SUMMARY_MAX} 字以内。`

/**
 * 摘要消息的前缀。渲染层与模型都靠它识别「这不是用户说的话」。
 *
 * 定义在 shared/types.ts —— 主进程生成它、渲染层识别它，两边必须一致。
 */
export { SUMMARY_MARKER }

/** 单个会话的压力状态。压缩是低频操作，用 Map 就够，不需要持久化 */
const pressures = new Map<string, CompactionPressure>()

export function pressureOf(sessionId: string, now: number): CompactionPressure {
  const key = sessionId || 'default'
  const current = pressures.get(key) || createCompactionPressure()
  // 静默一段时间后归零：别让昨天那次压不动影响今天的判断
  const normalized = normalizePressure(current, now)
  pressures.set(key, normalized)
  return normalized
}

export function noteCompacted(
  sessionId: string,
  params: { totalTokensAfter: number; threshold: number; now: number }
): void {
  pressures.set(sessionId || 'default', notePressureAfterCompaction(pressureOf(sessionId, params.now), params))
}

/** 仅用于测试与诊断 */
export function resetPressure(sessionId?: string): void {
  if (sessionId) pressures.delete(sessionId)
  else pressures.clear()
}

/**
 * 按「用户轮」把消息切成「要总结的」与「保留原文的」两部分。
 *
 * 实作在 compaction-policy.ts（纯函数，护栏要直接钉住它）。
 * 这里只做转出，方便调用方一处 import。
 */
export { splitForCompaction } from './compaction-policy'

/**
 * 把消息整理成能发给模型做总结的形态。
 *
 * ## ⚠️ 必须带上**已有的摘要**（曾经漏掉，是静默的信息丢失）
 *
 * 第二次压缩时，`head` 里躺着上一次生成的摘要。如果只收 user / assistant
 * 部分，那段摘要就既不进总结输入、又在重建时被新摘要替换掉 ——
 * 结果是**最早那段对话的信息彻底消失**，而且每次压缩都再丢一层。
 * 表现是「聊得越久，AI 越不记得开头说过什么」，完全不报错。
 *
 * 所以这里保留摘要（映射成 user + 明确标注），而且**留在原来的位置**：
 * 位置不变则前缀与上一次请求逐字节相同，prompt 缓存仍然命中。
 *
 * tool 输出仍然跳过：那些是文件正文 / 命令结果，体积最大，
 * 而且**可以重新获得**（模型再读一次就有），压进摘要没有意义。
 */
function toSummarizeInput<T extends { role: string; content: ChatContent | null }>(
  messages: T[]
): Array<{ role: 'user' | 'assistant'; content: string }> {
  const out: Array<{ role: 'user' | 'assistant'; content: string }> = []
  for (const message of messages) {
    const raw =
      typeof message.content === 'string'
        ? message.content
        : (message.content || [])
            .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
            .map((block) => block.text)
            .join('\n')
    if (!raw.trim()) continue

    /*
     * 已有的压缩摘要：保留内容，但要让人看得出来它是摘要。
     *
     * 角色映射成 user 而不是原样 system：部分中转站不接受
     * 「对话中间插一条 system」，而这里的位置必须保持不动（缓存）。
     * 加一个方括号标注，模型就能分清「这是交接说明」与「用户的话」。
     */
    if (message.role === 'system') {
      if (!raw.startsWith(SUMMARY_MARKER)) continue
      const body = raw.slice(SUMMARY_MARKER.length).trim()
      if (!body) continue
      out.push({ role: 'user', content: `[更早对话的摘要，请与下面的新内容合并]\n${body}` })
      continue
    }

    if (message.role !== 'user' && message.role !== 'assistant') continue
    // 与归档同一条理由：正文里可能躺着用户粘过的密钥，
    // 而摘要会被长期保留、每轮都发出去。先脱敏再总结。
    out.push({ role: message.role, content: redactSecrets(raw).text })
  }
  return out
}

function reportUsage(usage: AiUsage): void {
  if (usage.promptTokens <= 0) return
  recordUsage({
    model: getConfig().ai.model,
    promptTokens: usage.promptTokens,
    completionTokens: usage.completionTokens,
    cachedTokens: usage.cachedTokens,
    estimated: false
  })
}

export interface CompactionSummary {
  ok: boolean
  /** 成功时的摘要正文 */
  summary: string
  /** 失败时的可读原因（会进日志，也可能提示用户） */
  error?: string
  /** 被折叠进摘要的消息条数 */
  foldedCount: number
}

/**
 * 把一段对话总结成「交接说明」。
 *
 * 与归档总结同一套做法（缓存友好 + 失败降级），但提示词不同：
 * 这里要的是「接着干活」，不是「以后检索」。
 *
 * 失败**不抛异常**：调用方是对话主流程，压缩失败应当降级为
 * 「继续用原文发」或「按原样报超预算」，而不是把这次提问整个打挂。
 */
export async function summarizeForCompaction<T extends { role: string; content: ChatContent | null }>(
  head: T[],
  _sessionId: string
): Promise<CompactionSummary> {
  const foldedCount = head.length
  const prefix = toSummarizeInput(head)
  if (prefix.length === 0) {
    return { ok: false, summary: '', error: '没有可总结的对话内容。', foldedCount: 0 }
  }

  /*
   * system prompt 用与对话时**同一个快照** —— 缓存命中的前提。
   *
   * 这次要总结的 head 正是上一次请求前缀的一部分，而上次请求的
   * 开头就是这份 system prompt + 这些消息。原样带上，这段前缀
   * 就能命中缓存，压缩本身的成本会低很多。
   */
  const system = await sessionSystemPrompt(_sessionId)
  const tools = toolSchemasForModel()

  const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = []
  if (system) messages.push({ role: 'system', content: system })
  messages.push(...prefix, { role: 'user', content: COMPACT_INSTRUCTION })

  const maxTokens = 1200

  const first = await callModelOnce({
    messages,
    // 带上 tools 只为让前缀与对话请求完全一致（缓存）。模型可能因此
    // 真的去调工具，下面处理了「正文为空」那种情况。
    tools: tools.length > 0 ? tools : undefined,
    temperature: 0.2,
    maxTokens
  })
  reportUsage(first.usage)

  if (first.ok && first.text.trim()) {
    return { ok: true, summary: first.text.trim().slice(0, COMPACT_SUMMARY_MAX), foldedCount }
  }

  // 模型想调工具（正文为空）→ 去掉 tools 再试一次。第二次必然不命中缓存，
  // 但正确性优先于省钱。
  if (first.ok && !first.text.trim() && tools.length > 0) {
    logger.info('compact', '压缩总结时模型试图调用工具，去掉 tools 重试')
    const second = await callModelOnce({ messages, temperature: 0.2, maxTokens })
    reportUsage(second.usage)
    if (second.ok && second.text.trim()) {
      return {
        ok: true,
        summary: second.text.trim().slice(0, COMPACT_SUMMARY_MAX),
        foldedCount
      }
    }
    return {
      ok: false,
      summary: '',
      error: second.error || '模型没有返回可用的摘要。',
      foldedCount
    }
  }

  return { ok: false, summary: '', error: first.error || '模型没有返回可用的摘要。', foldedCount }
}

/** 把摘要包装成一条可以插进消息数组的内容（模型与人都能认出来） */
export function summaryContent(summary: string): string {
  return `${SUMMARY_MARKER}\n${summary}`
}
