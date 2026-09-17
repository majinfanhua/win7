/**
 * `/` 命令的离线校验（纯函数 + 接线）。
 *
 * ## 为什么需要它
 *
 * 命令解析的错法都是**静默**的，而且方向相反、都不报错：
 *
 *   - **判定太宽**：把 `/compact 帮我看看这个文件` 当成命令执行，
 *     学生的正常消息被吞掉（他以为发出去了，其实什么都没发）
 *   - **判定太严**：`/compact` 打出去当成普通消息发给模型 ——
 *     命令没执行，还白花一次请求
 *   - **触发位置错**：路径 `/a/b`、分数 `3/4` 里也有斜杠，
 *     不加「行首或空白之后」的限制就会乱弹列表
 *
 * 三种都不会抛异常，只会在某次真实使用中表现成「这功能坏了」。
 * 所以把边界逐条钉住。
 *
 * 用法：npm run check:slash
 */
import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const require = createRequire(import.meta.url)

let failures = 0
function check(name, ok, detail = '') {
  console.log(`${ok ? '通过' : '失败'}  ${name}${detail ? `  ${detail}` : ''}`)
  if (!ok) failures += 1
}

/*
 * slash-commands.ts 是纯模块（不 import 任何应用代码），
 * 但仍用 esbuild 转一遍 —— 与其它护栏同一套做法，避免依赖
 * Node 的 TS 支持。
 */
const esbuild = require('esbuild')
const out = esbuild.transformSync(
  fs.readFileSync(path.join(root, 'src/renderer/src/slash-commands.ts'), 'utf8'),
  { loader: 'ts', format: 'cjs', target: 'node16' }
)
const tmp = path.join(os.tmpdir(), `slash-${process.pid}.cjs`)
fs.writeFileSync(tmp, out.code)
const mod = require(tmp)
fs.rmSync(tmp, { force: true })

const { SLASH_COMMANDS, parseSlashQuery, parseSlashCommand, matchSlashCommands, slashCommandHelp } = mod

/* ══ 1. 命令表 ══════════════════════════════════════════════ */

{
  check('命令表非空', Array.isArray(SLASH_COMMANDS) && SLASH_COMMANDS.length > 0)
  check(
    '必须支持 /compact（用户明确要求）',
    SLASH_COMMANDS.some((c) => c.name === 'compact')
  )
  // id 与 name 重复会让「按 id 分派」与「按名字查」对不上
  const names = SLASH_COMMANDS.map((c) => c.name)
  const ids = SLASH_COMMANDS.map((c) => c.id)
  check('命令名不重复', new Set(names).size === names.length)
  check('命令 id 不重复', new Set(ids).size === ids.length)
  check(
    '每条命令都有说明（候选列表要显示）',
    SLASH_COMMANDS.every((c) => typeof c.detail === 'string' && c.detail.length > 0)
  )
  // 命令名里不能有空格或斜杠：那样根本打不出来
  check(
    '命令名不含空格或斜杠',
    names.every((n) => /^[a-z][a-z0-9-]*$/.test(n))
  )
}

/* ══ 2. 触发范围（打 `/` 时该不该弹列表） ═══════════════════ */

{
  const at = (value) => parseSlashQuery(value, value.length)

  check('行首打 / 会触发', at('/') !== null)
  check('行首打 /co 会触发并带上过滤词', at('/co')?.query === 'co')

  // ★ 空白之后也算行首（「顺便 /compact」这种写法）
  check('空格之后的 / 会触发', at('随便写点什么 /c')?.query === 'c')

  // ★ 这两条是「乱弹」的防线
  check('路径里的斜杠不触发', at('/usr/local') === null || at('/usr/local')?.query === 'usr/local')
  check('夹在词中间的斜杠不触发（3/4）', at('3/4') === null)
  check('URL 里的斜杠不触发', at('https://a.com') === null)

  // 打完命令名 + 空格 = 进入正文，列表必须收起来（否则回车被它抢走）
  check('命令名后打空格就不再触发', at('/compact ') === null)
  check('命令名后换行也不再触发', at('/compact\n帮我') === null)
}

/* ══ 3. 严格解析（不能吞掉正常消息） ════════════════════════ */

{
  // 正常调用
  const ok = parseSlashCommand('/compact')
  check('能认出 /compact', ok?.command?.name === 'compact')

  // 大小写不敏感
  check('大小写不敏感', parseSlashCommand('/Compact')?.command?.name === 'compact')

  // ★★ 最关键的一条：带正文的不能当命令执行
  check(
    '带正文的斜杠不当命令（/compact 帮我看看 要当普通消息）',
    parseSlashCommand('/compact 帮我看看这个文件') === null
  )

  // 不是命令的正常消息要放过去
  check('未知命令不拦（当普通消息发）', parseSlashCommand('/foobar') === null)
  check('普通消息不拦', parseSlashCommand('帮我改一下 index.html') === null)
  check('只一个斜杠不拦', parseSlashCommand('/') === null)
  check('空串不拦', parseSlashCommand('') === null)
  check('纯空白不拦', parseSlashCommand('   ') === null)

  // 中文路径那种斜杠
  check('中文句子里引用路径不拦', parseSlashCommand('看看 src/main.js') === null)
}

/* ══ 4. 过滤 ════════════════════════════════════════════════ */

{
  check('空前缀返回全部命令', matchSlashCommands('').length === SLASH_COMMANDS.length)
  // 前缀匹配：/c 应当同时匹配 compact 与 clear
  const c = matchSlashCommands('c').map((x) => x.name)
  check('/c 前缀匹配出 compact 与 clear', c.includes('compact') && c.includes('clear'),
    `得到 [${c.join(', ')}]`)
  // 打字中间不该冒出不相干的项
  const p = matchSlashCommands('p').map((x) => x.name)
  check('/p 不匹配 compact（前缀而非包含）', !p.includes('compact'), `得到 [${p.join(', ')}]`)
  check('完全不匹配时返回空', matchSlashCommands('zzzz').length === 0)
}

/* ══ 5. 帮助文本 ════════════════════════════════════════════ */

{
  const help = slashCommandHelp()
  check('帮助里有全部命令', SLASH_COMMANDS.every((c) => help.includes(`/${c.name}`)))
  check('帮助里带上说明文字', help.includes(SLASH_COMMANDS[0].detail))
}

/* ══ 6. 接线：渲染层真的用上了这些函数 ══════════════════════ */

{
  const panel = fs.readFileSync(path.join(root, 'src/renderer/src/components/AiPanel.tsx'), 'utf8')

  check('渲染层 import 了解析函数', /from '\.\.\/slash-commands'/.test(panel))
  check('输入变化时维护 / 浮层', /maintainSlash\(/.test(panel))
  check('渲染了 / 候选浮层', /className="slash-pop"/.test(panel))
  check('发送时拦截命令', /parseSlashCommand\(typed\)/.test(panel))
  check('↑↓ 能移动高亮', /setSlashIndex/.test(panel))
  check('Esc 能关掉浮层', /if \(slashOpen && e\.key === 'Escape'\)/.test(panel))

  /*
   * ★ 浮层里「当前用不了」的命令要置灰而不是隐藏：
   * 藏起来会让学生以为命令名记错了。
   */
  check('/ 候选把不可用项置灰而不是隐藏', /is-disabled/.test(panel) && /disabled=\{unavailable\}/.test(panel))
}

console.log(
  failures === 0
    ? '\n/ 命令校验：全部通过（不会吞正常消息，也不会该弹不弹）'
    : `\n/ 命令校验：${failures} 项失败`
)
process.exit(failures === 0 ? 0 : 1)
