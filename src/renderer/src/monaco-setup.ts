/**
 * Monaco 的按需装配。
 *
 * 为什么必须单独一个模块收口：这个项目编译目标是 Win7（Chromium 108 / 机械盘为主），
 * 而 `import * as monaco from 'monaco-editor'` 会把**全部 82 种语言**+
 * 全部 worker 一次性拉进主包 —— 实测渲染包 20.3 MB / 90 个 JS 文件。
 * 常用的只有 py / js / html / css，abap、bicep、cypher 这些的语法定义
 * 一辈子用不上，却要在冷启动时被读进来解析。
 *
 * 这里只注册 languageFromPath 真正会产出的语言 id。
 *
 * 关键点：用 `xxx.contribution.js` 而不是 `xxx.js`。
 * contribution 只做「注册元信息 + 声明一个 import() 加载器」，
 * 真正的语法定义（动辄几千行）要到第一次遇到该语言才加载。
 * 直接 import `xxx.js` 会把语法塞进主包，白费这次优化的意义。
 *
 * 新增语言时：先改 src/shared/language.ts 的 MAP，再来这里加一行。
 * 少一边的话编辑器会退化成纯文本高亮 —— 不报错，但看着像丢了功能。
 */

// 编辑器 API（不含任何语言）
import * as monaco from 'monaco-editor/esm/vs/editor/editor.api'
import { SNIPPETS, isTriggeredAt } from './snippets'

/*
 * Worker 注入。
 *
 * 少了这一段，编辑器能显示文字，但语言服务全是死的：
 * 没有语法着色、没有括号匹配、没有基础补全，控制台会一直报
 * 「Could not create web worker」—— 看到的是一个「像记事本」的编辑器。
 *
 * 用 ?worker 让 Vite 把每个 worker 打成独立文件。这点对 Win7 很重要：
 * 它们是**独立线程**，语法高亮与校验不占主线程，界面不会因为
 * 打开一个大文件而卡住。
 *
 * ts.worker 单独走**动态导入**（见下面的 getWorker）。
 * 它一个文件就 9.2 MB，而 `import ... from '...?worker'` 会在模块求值时
 * 就把它的 URL 拉进来；对一个纯 HTML/CSS 的教学项目来说，
 * 这份体积从头到尾都用不上，却要在启动时占着磁盘 IO ——
 * 机械盘 + 杀软实时扫描下这是实打实的秒级差别。
 * 改成懒加载后：只有真的打开 .js/.ts 才会去取那个 chunk。
 *
 * 按 label 分流：Monaco 用 label 区分语言服务类型，
 * 分流错了会把 TS 的 worker 拿去跑 CSS，表现是补全乱弹。
 */
import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker'
import jsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker'
import cssWorker from 'monaco-editor/esm/vs/language/css/css.worker?worker'
import htmlWorker from 'monaco-editor/esm/vs/language/html/html.worker?worker'

/**
 * 懒加载 ts.worker。
 *
 * Monaco 的 `getWorker` 是**同步**接口，不能返回 Promise，
 * 而 `MonacoEnvironment.getWorker` 之外还有一个 `getWorkerUrl`
 * 是给 URL 形式用的 —— 两个都不接受异步。所以这里用一个
 * 「占位 Worker + 转发」的办法：
 *
 *   1. 立刻返回一个用 Blob 造的空 Worker，Monaco 拿到它就能继续初始化
 *   2. 动态 import 真正的 ts.worker，拿到后把它的实例挂上
 *   3. 期间 Monaco 发来的消息先攒着，等真 worker 就绪后按序补发
 *
 * 为什么不用 `getWorkerUrl` 返回一个指向 chunk 的 URL：
 * 那条路径要求自己算 chunk 的文件名（带 hash），
 * 而 Vite 只在构建期知道 hash —— 等于把构建产物结构写死进源码，
 * 换个打包版本就崩。
 *
 * 代价：第一次打开 .js/.ts 时，语言服务会晚几百毫秒才可用。
 * 这个代价明显小于「每个用户启动时都读 9 MB」。
 */
function createLazyTsWorker(): Worker {
  const queue: Array<[Transferable | undefined, unknown]> = []
  let real: Worker | null = null

  // 空壳：用一段什么都不做的脚本造一个合法的 Worker
  const shell = new Worker(URL.createObjectURL(new Blob([''], { type: 'text/javascript' })))

  // 拦下 Monaco 发往这个空壳的所有消息，转给稍后就绪的真 worker
  shell.postMessage = ((message: unknown, transfer?: Transferable[]): void => {
    if (real) real.postMessage(message, transfer as Transferable[])
    else queue.push([transfer ? transfer[0] : undefined, message])
  }) as Worker['postMessage']

  void import('monaco-editor/esm/vs/language/typescript/ts.worker?worker').then((mod) => {
    real = new mod.default()
    // 真 worker 的 onmessage 要接回空壳上 —— Monaco 只持有空壳的引用
    real.onmessage = (e): void => shell.onmessage?.(e as MessageEvent)
    real.onerror = (e): void => shell.onerror?.(e as ErrorEvent)
    for (const [, message] of queue.splice(0)) real.postMessage(message)
  })

  return shell
}

self.MonacoEnvironment = {
  getWorker(_workerId: string, label: string): Worker {
    if (label === 'json') return new jsonWorker()
    if (label === 'css' || label === 'scss' || label === 'less') return new cssWorker()
    if (label === 'html' || label === 'handlebars' || label === 'razor') return new htmlWorker()
    if (label === 'typescript' || label === 'javascript') return createLazyTsWorker()
    return new editorWorker()
  }
}

// —— 基础语言：逐条与 language.ts 的 MAP 对应 ——
import 'monaco-editor/esm/vs/basic-languages/python/python.contribution'
import 'monaco-editor/esm/vs/basic-languages/javascript/javascript.contribution'
import 'monaco-editor/esm/vs/basic-languages/java/java.contribution'
import 'monaco-editor/esm/vs/basic-languages/cpp/cpp.contribution'
import 'monaco-editor/esm/vs/basic-languages/csharp/csharp.contribution'
import 'monaco-editor/esm/vs/basic-languages/go/go.contribution'
import 'monaco-editor/esm/vs/basic-languages/rust/rust.contribution'
import 'monaco-editor/esm/vs/basic-languages/php/php.contribution'
import 'monaco-editor/esm/vs/basic-languages/ruby/ruby.contribution'
import 'monaco-editor/esm/vs/basic-languages/sql/sql.contribution'
import 'monaco-editor/esm/vs/basic-languages/shell/shell.contribution'
import 'monaco-editor/esm/vs/basic-languages/bat/bat.contribution'
import 'monaco-editor/esm/vs/basic-languages/powershell/powershell.contribution'
import 'monaco-editor/esm/vs/basic-languages/markdown/markdown.contribution'
import 'monaco-editor/esm/vs/basic-languages/xml/xml.contribution'
import 'monaco-editor/esm/vs/basic-languages/yaml/yaml.contribution'

/*
 * web 三件套的语言 id 注册。
 *
 * 这两组导入缺一不可，原因值得记下来（踩过）：
 *
 * `vs/language/<x>/monaco.contribution` **只负责接语言服务**，
 * 它内部只有 `languages.onLanguage(id, ...)` 监听器，**没有** `languages.register()`。
 * 真正把 id（'html' / 'css' / 'typescript'）注册进 Monaco 的，
 * 是 `vs/basic-languages/<x>/<x>.contribution`。
 *
 * 以前用 `import * as monaco from 'monaco-editor'` 时，它内部走的是 editor.main，
 * 两套都装配好了，所以看不出问题。改成按需引入后如果只留 vs/language 那一组，
 * 编辑器会**静默退化**：html / css / js / ts 全部变成纯文本高亮，
 * 不报错、不白屏 —— 而这三个恰好是最常用的文件类型。
 * 自检里的 allNeededLanguagesRegistered 就是为盯这个而加的。
 */
import 'monaco-editor/esm/vs/basic-languages/html/html.contribution'
import 'monaco-editor/esm/vs/basic-languages/css/css.contribution'
import 'monaco-editor/esm/vs/basic-languages/less/less.contribution'
import 'monaco-editor/esm/vs/basic-languages/scss/scss.contribution'
import 'monaco-editor/esm/vs/basic-languages/typescript/typescript.contribution'

// —— 语言服务：提供补全、校验、格式化，由下方 worker 在后台线程执行 ——
import 'monaco-editor/esm/vs/language/json/monaco.contribution'
import 'monaco-editor/esm/vs/language/css/monaco.contribution'
import 'monaco-editor/esm/vs/language/html/monaco.contribution'
import 'monaco-editor/esm/vs/language/typescript/monaco.contribution'

/**
 * 只留语法校验，关掉语义（类型）校验。
 *
 * 真正有用的是「括号没配对」「少个冒号」这类立刻能改的提示。
 * 严格类型检查会在还没写接口定义的时候就铺天盖地报红，
 * 那些红波浪线他们看不懂也改不动，只会让人觉得「我写的全是错的」。
 *
 * 语义校验也是 worker 里最贵的一步：它要加载 lib.d.ts 并做类型推断，
 * 在 Win7 的机械盘上首次打开 .js 会明显顿一下。关掉它同时解决体验与性能。
 */
monaco.languages.typescript.javascriptDefaults.setDiagnosticsOptions({
  noSemanticValidation: true,
  noSyntaxValidation: false
})
monaco.languages.typescript.typescriptDefaults.setDiagnosticsOptions({
  noSemanticValidation: true,
  noSyntaxValidation: false
})

/**
 * 关掉「项目级」的自动类型获取。
 *
 * 默认配置下 TS worker 会去猜 node_modules 里的类型并在建议里加进来，
 * 这需要遍历工作区建索引。一般的小项目用不上，而且老机器上会卡。
 * 关键字与内置 API 的基础补全仍然保留。
 */
monaco.languages.typescript.javascriptDefaults.setEagerModelSync(false)
monaco.languages.typescript.typescriptDefaults.setEagerModelSync(false)

/* ------------------------------------------------------------------ *
 * 片段补全（!+Tab 之类）
 * ------------------------------------------------------------------ */

/**
 * 注册触发词片段。
 *
 * 覆盖 html / css / javascript / markdown / json 五种语言 —— 与
 * FILE_TEMPLATES 的六种一一对应（纯文本没有骨架，不注册）。
 *
 * 两个关键点：
 *   1. **必须用 `insertTextRules` 打开 InsertAsSnippet**，否则 `$0`
 *      会被当字面量插进文件里，学生会看到代码里多了一串 `$0`
 *   2. **不做「只在行首触发」的过滤**（snippets.ts 里的 shouldSuggest 目前没接）。
 *      Monaco 的 CompletionItemProvider 拿不到「光标前这一行」的原文，
 *      要自己从 model 里读；而为了不误触就算错也比不补全好 ——
 *      学生敲 `!` 后看到补全列表弹出、不想要就不选，代价很小；
 *      反过来若过滤写错导致该弹时不弹，他会以为这个功能没做。
 *
 * 触发词在补全列表里的排序靠 sortText 提前：`!` 这种要排在最前面，
 * 否则会被语言服务自带的几百条建议压在下面，学生根本翻不到。
 */
/**
 * 片段只在这几种语言里注册。
 *
 * typescript 也一起注册 —— 学生写 .ts 时同样想要 `!`。
 * javascript 用 `monaco.languages.javascript`（不是 typescript）：
 * 两个语言 id 各自独立注册，而 .js 文件的默认语言是 javascript。
 */
const SNIPPET_TARGETS: Array<{ id: string; api: monaco.languages.LanguageSelector }> = [
  { id: 'html', api: 'html' },
  { id: 'css', api: 'css' },
  { id: 'javascript', api: 'javascript' },
  { id: 'typescript', api: 'typescript' },
  { id: 'markdown', api: 'markdown' },
  { id: 'json', api: 'json' }
]

for (const target of SNIPPET_TARGETS) {
  monaco.languages.registerCompletionItemProvider(target.api, {
    // 触发字符：`!` 是 Emmet 习惯，敲下去就该弹；其余靠单词补全自动出现
    triggerCharacters: ['!'],
    provideCompletionItems(model, position) {
      const word = model.getWordUntilPosition(position)
      const line = model.getLineContent(position.lineNumber)
      /** 光标之前这一行的原文，用来判断触发词是不是在行首 */
      const beforeCursor = line.slice(0, position.column - 1)

      const range = {
        startLineNumber: position.lineNumber,
        endLineNumber: position.lineNumber,
        startColumn: word.startColumn,
        endColumn: word.endColumn
      }

      const suggestions = SNIPPETS.filter((snippet) => isTriggeredAt(snippet, beforeCursor)).map(
        (snippet, index) => ({
          label: {
            label: snippet.trigger,
            description: snippet.detail
          },
          // 排在最前：片段是这个编辑器里最该先被看到的东西
          sortText: `0${index}`,
          kind: monaco.languages.CompletionItemKind.Snippet,
          insertText: snippet.body,
          insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
          documentation: { value: `展开${snippet.detail}的初始骨架` },
          range
        })
      )

      return { suggestions }
    }
  })
}

export default monaco
