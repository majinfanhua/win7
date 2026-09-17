/**
 * 对话输入框里的 `/` 命令。
 *
 * ## 为什么要有它
 *
 * 对话区里有几件「操作」被塞进了按钮或藏在别处：开新对话在顶栏、
 * 压缩上下文（以前压根没有）、清空聊天区…… 学生要记「哪个功能在哪个角落」。
 * `/` 命令把它们变成**打出来就能用**的入口，而且能带参数、能提示。
 *
 * ## 与 Skills 的区别（这条最容易混）
 *
 *   - Skills 是**给模型的**：写成 Markdown 放技能目录，模型通过
 *     listSkills / readSkill 这两个工具去读，本质是「扩展模型的知识」
 *   - `/` 命令是**给人的**：在输入框里打 `/`，由**渲染层直接执行**，
 *     模型根本看不到。它不发请求、不花 token
 *
 * 两者机制完全不同，所以命令不复用技能那套实现。以前占位符里写的
 * 「/ 引用 Skills」就是这个混淆的产物 —— 已纠正。
 *
 * ## 为什么命令表是纯数据
 *
 * 渲染层要拿它渲染候选列表，执行时要按 id 分派。做成纯数据 + 纯函数，
 * 就能被护栏直接钉住（不必起窗口），也避免「加一条命令要改三处」。
 */

/** 命令 id。执行分派按它走，改名字等于改契约 */
export type SlashCommandId = 'compact' | 'new' | 'clear' | 'help'

export interface SlashCommand {
  id: SlashCommandId
  /** 命令名，不含斜杠 */
  name: string
  /** 一句话说明，显示在候选列表里 */
  detail: string
  /**
   * 是否需要有对话内容才能用。
   *
   * `/compact` 在空对话上毫无意义，置灰比「点了没反应」清楚。
   * `/clear` 则相反 —— 它专门用来清空，任何时候都能点。
   */
  needsHistory?: boolean
  /** 正在忙（有回答在生成）时是否禁用 */
  disabledWhileBusy?: boolean
}

/**
 * 命令表。**顺序即候选列表里的显示顺序**，常用的放前面。
 */
export const SLASH_COMMANDS: SlashCommand[] = [
  {
    id: 'compact',
    name: 'compact',
    detail: '压缩上下文：把较早的对话总结成一段，腾出空间继续聊',
    // 空对话没什么可压的；忙的时候压缩会和在跑的那轮抢上下文
    needsHistory: true,
    disabledWhileBusy: true
  },
  {
    id: 'new',
    name: 'new',
    detail: '开一个新对话',
    disabledWhileBusy: true
  },
  {
    id: 'clear',
    name: 'clear',
    detail: '清空当前对话的消息（会先问一次）',
    disabledWhileBusy: true
  },
  {
    id: 'help',
    name: 'help',
    detail: '看看有哪些命令'
  }
]

/**
 * 从输入框内容里解析出「正在输入的命令」。
 *
 * 只在**行首**触发（`/` 前面是空白或什么都没有），理由与 `@` 一致：
 * 「路径 /a/b」「3/4」这类正常文本里也有斜杠，不加限制就会乱弹。
 *
 * 与 `@` 的另一个区别：命令**不接受空格**。打 `/compact` 之后
 * 按空格就是要开始说正事了，那时候选列表必须收起来 ——
 * 否则空格之后列表还在，回车会被它抢走。
 *
 * 返回 null 表示「现在不该弹列表」。
 */
export function parseSlashQuery(
  value: string,
  caret: number
): { start: number; query: string } | null {
  const before = value.slice(0, Math.max(0, caret))
  const slash = before.lastIndexOf('/')
  if (slash < 0) return null
  // 行首或空白之后才算（与 AiPanel 里 @ 的判定同一条规则）
  if (slash > 0 && !/\s/.test(before[slash - 1])) return null

  const query = before.slice(slash + 1)
  // 已经打了空格 / 换行 = 命令名写完，进入正文了
  if (/[\s\n]/.test(query)) return null
  return { start: slash, query }
}

/**
 * 按已输入的内容过滤命令表。
 *
 * 前缀匹配而不是模糊匹配：命令只有几条，模糊匹配会把
 * 不相关的项混进来（打 `/c` 时同时出现 compact 与 clear 是对的，
 * 但打 `/p` 出现 compact 就莫名其妙了）。
 */
export function matchSlashCommands(query: string): SlashCommand[] {
  const q = (query || '').trim().toLowerCase()
  if (!q) return SLASH_COMMANDS
  return SLASH_COMMANDS.filter((cmd) => cmd.name.startsWith(q))
}

/**
 * 把输入的整段文本解析成一条命令。
 *
 * 返回 null 表示「这不是命令，当普通消息发」。
 *
 * ⚠️ 判定要**严格**：命令名后面不能跟别的内容。
 *
 * `/compact 帮我看看这个文件` 这种不是「带参数调用命令」，而是
 * **一句普通消息**（学生把 compact 当成了个词）。当成命令执行的话，
 * 那句话就被吞掉了 —— 他以为发出去了，其实什么都没发生，
 * 而且没有任何提示。反过来（当普通消息发）最坏只是白花一次请求。
 *
 * 代价：将来若真要做「带参数的命令」（比如 `/model gpt-4o`），
 * 必须在这里给那条命令开一个口子（按 name 判断是否允许带参数），
 * 不能直接把限制去掉。
 */
export function parseSlashCommand(value: string): { command: SlashCommand; arg: string } | null {
  const text = (value || '').trim()
  if (!text.startsWith('/')) return null

  const body = text.slice(1)
  const spaceAt = body.search(/\s/)
  // 命令名后面还有内容 → 当普通消息，不当命令
  if (spaceAt >= 0) return null

  const name = body.toLowerCase()
  if (!name) return null

  const command = SLASH_COMMANDS.find((cmd) => cmd.name === name)
  if (!command) return null
  return { command, arg: '' }
}

/** `/help` 用：把所有命令列成一段可直接显示的中文 */
export function slashCommandHelp(): string {
  const lines = SLASH_COMMANDS.map((cmd) => `/${cmd.name} —— ${cmd.detail}`)
  return ['可用命令：', ...lines].join('\n')
}
