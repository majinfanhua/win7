import type { FileTemplate } from './file-templates'
import { FILE_TEMPLATES } from './file-templates'

/**
 * 编辑器里的片段补全（输入触发词 + Tab 展开）。
 *
 * ## 为什么与 file-templates 共用数据
 *
 * 「新建文件时套模板」与「在编辑器里敲触发词展开」是同一份骨架的两个入口。
 * 各写一份的话，新建出来的 index.html 与敲 `!` 展开的会不一样 ——
 * 而这种不一致极难发现（要同时用两种方式各建一次才看得出来）。
 * 所以内容只有一份（`FILE_TEMPLATES`），这里只补「触发词」与「光标停在哪」。
 *
 * ## 触发词怎么定的
 *
 * - `!` → HTML。这是 VS Code / Emmet 的既有习惯，学生从别的编辑器迁过来
 *   不用重新学。**但 `!` 单独一个字符会与正常的感叹号冲突**，所以：
 *   只在行的开头、且后面没有别的字符时才触发（见 snippetsFor 的注释）
 * - `css` / `js` / `md` / `json` → 用类型名本身，好记且不会误触
 *
 * 展开后光标停在模板里最该接着写的位置（HTML 是 `<body>` 里，
 * CSS 是第一条规则后），而不是文本末尾 —— 停在末尾的话学生还得自己
 * 把光标挪回去，那正是模板想省掉的事。
 */

/** 一个片段：触发词 + 展示名 + 展开内容 + 光标偏移 */
export interface Snippet {
  /** 触发词，如 `!` 或 `css` */
  trigger: string
  /** 补全列表里显示的名字 */
  label: string
  /** 说明，显示在补全列表右侧 */
  detail: string
  /** 展开后的文本 */
  body: string
  /**
   * 光标落点。
   * 用 Monaco snippet 语法里的 `$0`（最终光标位）标在 body 里，
   * 所以这里是 true 表示「body 里已经带了 $0」。
   */
  hasCursor: boolean
}

/**
 * 把模板正文变成片段正文。
 *
 * HTML 模板里 `<h1>你好</h1>` 那一行会被替换成 `$0`：
 * 学生展开模板后想写的几乎肯定是 body 里的内容，
 * 而不是把示例的「你好」改掉。
 */
function toSnippetBody(template: FileTemplate): { body: string; hasCursor: boolean } {
  if (template.ext === 'html') {
    return {
      body: template.content.replace('    <h1>你好</h1>\n', '    $0\n'),
      hasCursor: true
    }
  }
  if (template.ext === 'css') {
    // 光标放在 body 规则里面：那是学生第一个要写的地方
    return {
      body: template.content.replace('body {\n', 'body {\n  $0\n'),
      hasCursor: true
    }
  }
  if (template.ext === 'js') {
    return {
      body: template.content.replace('  console.log("脚本已加载")\n', '  $0\n'),
      hasCursor: true
    }
  }
  if (template.ext === 'json') {
    return {
      body: template.content.replace('  "name": "",\n', '  "$0": "",\n'),
      hasCursor: true
    }
  }
  return { body: `${template.content}$0`, hasCursor: true }
}

/** 触发词 → 模板扩展名。`!` 单独映射到 html（Emmet 习惯） */
const TRIGGER_TO_EXT: Array<{ trigger: string; ext: string; detail: string }> = [
  { trigger: '!', ext: 'html', detail: 'HTML5 骨架（Emmet 习惯）' },
  { trigger: 'html', ext: 'html', detail: 'HTML5 骨架' },
  { trigger: 'css', ext: 'css', detail: 'CSS 基础样式' },
  { trigger: 'js', ext: 'js', detail: 'JavaScript 起步' },
  { trigger: 'md', ext: 'md', detail: 'Markdown 标题' },
  { trigger: 'json', ext: 'json', detail: 'JSON 对象骨架' }
]

/**
 * 全部片段。模块加载时算一次 —— 模板是静态数据，没有理由每次补全都重算。
 *
 * 纯文本（.txt）不在这里：它的模板正文是空的，没有可展开的东西。
 */
export const SNIPPETS: Snippet[] = TRIGGER_TO_EXT.flatMap(({ trigger, ext, detail }) => {
  const template = FILE_TEMPLATES.find((item) => item.ext === ext)
  if (!template || !template.content) return []
  const { body, hasCursor } = toSnippetBody(template)
  return [{ trigger, label: trigger, detail, body, hasCursor }]
})

/**
 * 某个触发词该不该在当前上下文里弹出来。
 *
 * `!` 是最需要这个判断的：它是个常用标点，学生写 `Hello!` 或 `!==` 时
 * 不该弹出 HTML 骨架。规则是**必须在行首、且这一行到现在只敲了触发词**——
 * 这正是 Emmet 的行为，也符合「我要开始写一个新文件」的意图。
 *
 * 其余触发词（css / js / md / json）用同样的规则：它们是普通单词，
 * 出现在行中间（如 `import "css"`）时不该触发。
 *
 * ⚠️ 不要依赖 `word` 参数判断 `!`：`!` 不是单词字符，
 * Monaco 的 `getWordUntilPosition` 在它上面**可能返回空**（不同版本行为不同）。
 * 所以真正的位置判断一律用 `textBeforeLine`，`word` 只作为辅助校验 ——
 * 见 `shouldSuggestAt`。
 *
 * @param textBeforeLine 光标所在行、光标之前的文本
 * @param word 光标前的那个词（Monaco 的 getWordUntilPosition）
 */
export function shouldSuggest(trigger: string, textBeforeLine: string, word: string): boolean {
  // 词边界能对上就用词边界（更严）；对不上时退化成「行尾就是触发词」
  const byWord = word === trigger
  const byText = textBeforeLine.endsWith(trigger)
  if (!byWord && !byText) return false

  // 必须在行首触发：触发词之前不允许有非空白字符
  const before = textBeforeLine.slice(0, textBeforeLine.length - trigger.length)
  return before.trim() === ''
}

/**
 * 给 Monaco 用的入口：只吃「光标前这一行」，自己判断每个片段该不该弹。
 *
 * 单独包一层是因为 `!` 与普通单词的取词方式不同（见 shouldSuggest 的注释），
 * 而 provider 那边不该关心这个差异。
 */
export function isTriggeredAt(snippet: Snippet, textBeforeLine: string): boolean {
  return shouldSuggest(snippet.trigger, textBeforeLine, '')
}
