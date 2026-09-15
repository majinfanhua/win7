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

/*
 * Worker 注入。
 *
 * 少了这一段，编辑器能显示文字，但语言服务全是死的：
 * 没有语法着色、没有括号匹配、没有基础补全，控制台会一直报
 * 「Could not create web worker」—— 看到的是一个「像记事本」的编辑器。
 *
 * 用 ?worker 让 Vite 把每个 worker 打成独立文件。这点对 Win7 很重要：
 * 它们是**独立线程**，语法高亮与校验不占主线程，界面不会因为
 * 打开一个大文件而卡住。ts.worker 有 9 MB，但它是懒加载的 ——
 * 只有真的打开 .js/.ts 时才启动，纯 HTML 项目不会付这个代价。
 *
 * 按 label 分流：Monaco 用 label 区分语言服务类型，
 * 分流错了会把 TS 的 worker 拿去跑 CSS，表现是补全乱弹。
 */
import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker'
import jsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker'
import cssWorker from 'monaco-editor/esm/vs/language/css/css.worker?worker'
import htmlWorker from 'monaco-editor/esm/vs/language/html/html.worker?worker'
import tsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker'

self.MonacoEnvironment = {
  getWorker(_workerId: string, label: string): Worker {
    if (label === 'json') return new jsonWorker()
    if (label === 'css' || label === 'scss' || label === 'less') return new cssWorker()
    if (label === 'html' || label === 'handlebars' || label === 'razor') return new htmlWorker()
    if (label === 'typescript' || label === 'javascript') return new tsWorker()
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

export default monaco
