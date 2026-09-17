import type { PermissionMode } from './types'
import {
  PLATFORM_CONTRACT,
  TOOL_CONTRACT,
  DISCIPLINE_CONTRACT,
  buildRuntimeState,
  CONTRACT_VERSION
} from './prompt-contract'
/**
 * `系统.md` 的组装规则（纯函数，不依赖 Electron / 文件系统）。
 *
 * ## 为什么要有一个「系统.md」
 *
 * 发给模型的 system prompt 由**两层**拼成：
 *
 *   程序维护（用户看得到、改不了）—— 见 prompt-contract.ts
 *     - 平台契约：路径语义、工具契约、工作纪律
 *     - 运行状态：当前权限模式
 *     - 本机环境：系统 / 工作目录 / 探测到的运行时
 *   用户可改（设置 → AI 设定）
 *     - AI 叫什么、怎么称呼用户
 *     - 用户的使用习惯
 *
 * 为什么要分两层：契约那部分是软件的行为定义，用户改错了软件就不按
 * 设计工作（而他并不知道 writeFile 有先读后写的守卫、也不知道路径怎么校验）；
 * 但它们又必须**看得见**，否则「AI 到底收到了什么」无法核对。
 *
 * 与其在代码里悄悄拼一串谁也看不见的字符串，不如**拼成一个真实存在的
 * Markdown 文件**放在 userData 下：用户能打开看、能确认「AI 到底收到了什么」。
 * 出问题时第一件事就是看这个文件，而不是猜。
 *
 * ## 为什么只有一个文件
 *
 * 拆成「身份.md / 习惯.md / 环境.md」看起来更整齐，但代价是：
 *   - 用户要开四个文件才知道 AI 收到了什么
 *   - 任何一处漏读都会让 prompt 少一段，而这种错误是静默的
 * 一个文件、从头读到尾就是完整 prompt，没有「漏了哪一份」的可能。
 *
 * ## 顺序：从最稳定到最易变
 *
 * 这个顺序不是为了好看，是为了**缓存**。主流中转站（OpenAI / DeepSeek）
 * 的 prompt 缓存都按「最长公共前缀」算：前缀里只要有一个字节不同，
 * 它后面的全部内容都不算命中。
 *
 * 所以把「几乎不变」的放前面（身份、默认提示词），
 * 把「偶尔会变」的放后面（习惯），把「换台机器就变」的放最后（环境探测）。
 * 反过来的话，用户装了个 python 导致环境那段变了，
 * 前面几百字的稳定内容也会一起失去缓存。
 *
 * ## 为什么文件里没有时间戳
 *
 * 时间戳每次都不同 —— 写进去等于**每次请求都让缓存失效**，
 * 而且是最坏的那种失效（变的是最前面那几行）。
 * 想看生成时间就看文件的修改时间（mtime），那个不进 prompt。
 */

/** 落在 userData 下的文件名。用中文名是为了用户一眼认出来 */
export const SYSTEM_DOC_NAME = '系统.md'

/**
 * 名字长度上限。
 *
 * 5 个字符的理由：名字会出现在每一句自称里，太长会挤占上下文，
 * 而且中文名字 5 个字已经够用（"小助手" 3 个、"Claude" 6 个 —— 英文名
 * 按字符算会吃亏，但英文名超过 5 个字母的本来也少见）。
 * 这是产品约束不是技术约束，所以只在界面与写入两处夹紧，不做硬报错。
 */
export const AI_NAME_MAX = 5
export const USER_NAME_MAX = 5

/** 习惯文本上限。给足空间写清楚，但不至于让用户把整篇文档粘进来 */
export const HABITS_MAX = 2_000

/** 一条被探测到的运行时（这里只需要展示用的三个字段） */
export interface RuntimeLine {
  name: string
  version: string
  note: string
}

export interface SystemDocInput {
  /** AI 给自己起的名字 */
  aiName: string
  /** 用户希望 AI 怎么称呼自己 */
  userName: string
  /**
   * 用户习惯，自由文本。
   *
   * 注意这里**没有**「用户自定义系统提示词」这一项：
   * 原来有一项 systemPrompt，已去掉 —— 与模型的约定由代码维护
   * （见 prompt-contract.ts），用户可改的是身份、称呼、习惯这三样。
   */
  habits: string
  /**
   * 当前权限模式。
   *
   * 它决定模型**提前知道自己能做什么**（计划模式只能读、完全允许模式
   * 无范围限制），而不是撞到工具报错才知道。见 prompt-contract 的
   * buildRuntimeState。
   */
  permissionMode: PermissionMode
  /**
   * 已探测到的运行时。
   *
   * **空数组表示「没探测到」而不是「一台什么都没有的机器」**，
   * 这时整段不写 —— 详见 formatRuntimes 的注释。
   */
  runtimes: RuntimeLine[]
  /** 操作系统等一句补充说明，如「Windows 7 SP1 (6.1.7601)，64 位」。留空则不写 */
  environmentNote?: string
}

/** 去掉首尾空白并按上限截断。空值返回空串，调用方据此决定整段写不写 */
export function clipName(raw: string, max: number): string {
  return (raw || '').trim().slice(0, max)
}

/**
 * 拼给模型看的运行时清单。
 *
 * 没探测到任何东西时返回空串 —— 不要写「本机没有任何运行时」，
 * 那句话会让模型以为连 python 都不能装，反而限制了它的建议。
 */
export function formatRuntimes(runtimes: RuntimeLine[]): string {
  if (runtimes.length === 0) return ''
  const lines = runtimes.map((item) => {
    const version = item.version ? `（${item.version}）` : ''
    return `- ${item.name}${version}：${item.note}`
  })
  return (
    '本机可用的开发环境（已探测，直接用它，不要靠试错）：\n' +
    lines.join('\n') +
    '\n跑命令时请从上面这些里选，并且命令用英文。'
  )
}

/**
 * 组装 `系统.md` 的全文。
 *
 * **必须是确定性的**：同样的输入必须逐字节产生同样的输出。
 * 任何随机性 / 时间戳 / 路径都会让 prompt 缓存每次都失效。
 * 这条约束由 scripts/check-system-doc.mjs 守着。
 */
export function buildSystemDoc(input: SystemDocInput): string {
  const aiName = clipName(input.aiName, AI_NAME_MAX)
  const userName = clipName(input.userName, USER_NAME_MAX)
  const habits = (input.habits || '').trim().slice(0, HABITS_MAX)
  const env = formatRuntimes(input.runtimes)
  const envNote = (input.environmentNote || '').trim()

  const blocks: string[] = [HEADER]

  /*
   * ── 程序维护区（用户看得到、改不了）──────────────────────────
   *
   * 顺序：契约 → 运行状态 → 环境。
   *   契约      只随应用升级变（最稳定）→ 放最前，缓存前缀尽量长
   *   运行状态  随权限模式变（换模式才变）
   *   环境      随工作区/机器变（最易变）→ 放最后
   * 反过来的话，换个项目就会让前面几百字的契约一起失去缓存命中。
   */
  blocks.push(PLATFORM_CONTRACT)
  blocks.push(TOOL_CONTRACT)
  blocks.push(DISCIPLINE_CONTRACT)
  blocks.push(`## 当前运行状态\n\n${buildRuntimeState(input.permissionMode)}`)

  if (envNote || env) {
    const lines = [envNote, env].filter(Boolean).join('\n\n')
    blocks.push(`## 本机环境\n\n${lines}`)
  }

  /*
   * ── 用户可改区 ────────────────────────────────────────────
   *
   * 插一条显式分界：用户打开 系统.md 时能一眼看出「上面那半我改不了」，
   * 而不是去改契约段、下次对话又被静默覆盖（那种困惑最难排查）。
   */
  blocks.push(USER_EDITABLE_MARK)

  /*
   * 身份段。名字和称呼各自可能为空，三种情况分别处理：
   *   - 都空：整段不写（不要出现「你的名字是「」」这种给模型添乱的东西）
   *   - 只有名字：说名字
   *   - 有称呼：补一句怎么叫用户
   * 称呼单独一句而不是和名字并列，是因为它约束的是**模型的措辞**，
   * 而名字约束的是**模型的自我指代** —— 两件事分开说模型更少搞混。
   */
  const identity: string[] = []
  if (aiName) identity.push(`你的名字是「${aiName}」。`)
  if (userName) identity.push(`称呼用户为「${userName}」。`)
  if (identity.length > 0) blocks.push(`## 你的身份\n\n${identity.join('')}`)

  // 习惯：用户自己的固定偏好，自由文本、原样保留
  if (habits) blocks.push(`## 用户的习惯\n\n${habits}`)

  return `${blocks.join('\n\n')}\n`
}

/**
 * 文件开头的说明。
 *
 * 必须写清楚「哪些能动、哪些不能动」，否则用户会很自然地打开这个文件
 * 改两行契约，然后在下次对话时发现改动没了 —— 那种「我明明改了」的
 * 困惑最难排查。所以这里给出正确的改法（去设置里改），
 * 让这个文件不只是拒绝，而是指路。
 *
 * 带契约版本号：契约内容变了这个数字会变，用户对比前后两份能看出
 * 「不是我改坏了，是程序升级改了」。
 */
const HEADER = `# 系统设定

<!--
这个文件是发给 AI 的 system prompt 全文，由 hangkeIDE 自动生成。
契约版本：${CONTRACT_VERSION}

可以打开看，但只有**下半部分**（你的身份 / 习惯）能通过设置修改。
上半部分是程序维护的行为约定，直接在这里改会在下次对话开始时被覆盖。

要改设定请到：设置 → AI 设定
-->`

/**
 * 用户可改区的分界标记。
 *
 * 它不是给模型看的指令，而是给**人**看的：打开 系统.md 时能一眼看出
 * 上面那一半是程序维护的、改不了。用 HTML 注释而不是标题，
 * 是为了不干扰模型对 Markdown 结构的理解。
 */
const USER_EDITABLE_MARK = `<!-- ═══════ 以下可以用「设置 → AI 设定」修改 ═══════ -->`
