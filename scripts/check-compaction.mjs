/**
 * 上下文压缩的**接线**校验（静态扫描，不加载模块、不起窗口）。
 *
 * ## 为什么需要它
 *
 * 压缩本身（策略 + 总结）都有覆盖，但真正会坏的地方是**接线**：
 * 主进程压完把摘要作为 `system` 消息发回渲染层，渲染层必须把它
 * 留在历史里、并在下一轮**原样发回去**。
 *
 * 这条链路上任何一处把它过滤掉，表现都是同一个 ——
 * 而且**完全静默**：
 *
 *   界面上看着「压缩成功、省了 3 万 token」，
 *   但下一轮发出去的又是完整历史 → 主进程再压一次 → 再省一次……
 *   每轮都重复花一次总结的钱，上下文永远压不下去。
 *   没有报错、没有异常，只有账单在涨。
 *
 * 这个仓库以前踩过同一类坑（`evtLog` 主进程发了、渲染层没接），
 * 所以对这种「两端要对上」的约定一律加护栏。
 *
 * ## 检查什么
 *
 *   1. 渲染层的「哪些角色算对话内容」判定必须只有**一处**
 *      （`isConversationRole`），且包含 system
 *   2. 那几处历史过滤必须走这个判定，不能各写一遍
 *      `role === 'user' || role === 'assistant'`
 *   3. 主进程回传摘要、渲染层消费 `compacted` 事件，两端都在
 *   4. 摘要标记由 shared 定义、两端共用同一份常量
 *
 * 用法：npm run check:compact
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')

let failures = 0
function check(name, ok, detail = '') {
  console.log(`${ok ? '通过' : '失败'}  ${name}${detail ? `  ${detail}` : ''}`)
  if (!ok) failures += 1
}

function read(rel) {
  return fs.readFileSync(path.join(root, rel), 'utf8')
}

const panel = read('src/renderer/src/components/AiPanel.tsx')
const types = read('src/shared/types.ts')
const ai = read('src/main/ipc/ai.ts')
const compaction = read('src/main/compaction.ts')

/* ══ 1. 摘要的角色与判定 ════════════════════════════════════ */

{
  /*
   * `isConversationRole` 是这条链路的**唯一**判定点。
   * 它必须把 system 算成对话内容 —— 摘要就是 system。
   */
  const fn = /function isConversationRole\(role: Role\): boolean \{\s*return([^}]*)\}/.exec(panel)
  check('渲染层存在 isConversationRole 判定', Boolean(fn))
  if (fn) {
    check(
      'isConversationRole 把 system 算成对话内容（压缩摘要就靠它）',
      fn[1].includes("'system'"),
      fn[1].trim()
    )
    check(
      'isConversationRole 不把 error / notice 算成对话内容（本地提示不该发给模型）',
      !fn[1].includes("'error'") && !fn[1].includes("'notice'")
    )
  }
}

/* ══ 2. 历史过滤必须走那个判定（不能各写一遍） ══════════════ */

{
  /*
   * ★ 核心断言：不允许再有硬编码的「只留 user 与 assistant」。
   *
   * 那就是「摘要被静默丢掉」的写法 —— 压缩加进来之前它是对的，
   * 之后每多一处就是多一个漏点。
   */
  const hardcoded = /\.filter\(\(it\)\s*=>\s*it\.role === 'user' \|\| it\.role === 'assistant'\)/g
  const hits = panel.match(hardcoded) || []
  check(
    '渲染层没有硬编码的「只留 user/assistant」过滤',
    hits.length === 0,
    hits.length > 0 ? `还有 ${hits.length} 处会把摘要丢掉` : ''
  )

  // 该用判定的地方确实用了
  const uses = panel.match(/isConversationRole\(/g) || []
  // 1 次定义 + 至少 4 处调用（发送、落盘 ×2、手动压缩）
  check('渲染层的历史过滤都走 isConversationRole', uses.length >= 5, `出现 ${uses.length} 次`)
}

/* ══ 3. 发送路径要带上 system（摘要） ═══════════════════════ */

{
  // historyMessages 的映射必须允许 system
  const sent = /const historyMessages: ChatMessage\[\] = history\.map\(\(it\) => \(\{[\s\S]{0,120}?\)\)/.exec(panel)
  check('发送时把 system（摘要）一起映射进 historyMessages', Boolean(sent) && sent[0].includes("'system'"))

  /*
   * 占位 system 只能在「历史里还没有摘要」时插。
   *
   * 无条件插的话会出现两个 system：主进程只覆盖第一个，
   * 摘要反而落到后面 —— 位置不对，模型会把它当成「正在进行的系统指令」。
   */
  check(
    '占位 system 只在历史里没有摘要时插（避免两个 system）',
    /historyMessages\.some\(\(m\) => m\.role === 'system'\)/.test(panel)
  )
}

/* ══ 4. 事件两端都有人（主进程发、渲染层接） ════════════════ */

{
  check(
    '主进程会回传 compacted 事件',
    /kind:\s*'compacted'/.test(ai) && /compaction:/.test(ai)
  )
  check(
    '渲染层消费 compacted 事件（否则摘要永远回不到历史里）',
    /chunk\.kind === 'compacted'/.test(panel)
  )
  check(
    'compacted 事件带 CompactionNotice 字段',
    /kind: 'delta' \| 'done' \| 'error' \| 'tool' \| 'compacted'/.test(types) &&
      /interface CompactionNotice/.test(types)
  )
  check('渲染层按 keptCount 截取保留项', /notice\.keptCount/.test(panel))
}

/* ══ 5. 摘要标记两端共用一份 ════════════════════════════════ */

{
  check('SUMMARY_MARKER 定义在 shared（两端共用）', /export const SUMMARY_MARKER/.test(types))
  check('主进程用 shared 的 SUMMARY_MARKER', /SUMMARY_MARKER/.test(compaction))
  check('渲染层用 shared 的 SUMMARY_MARKER', /SUMMARY_MARKER/.test(panel))
  // 不许在别处又写一份字面量（两份迟早不一致）
  const literal = /【以下是之前对话的摘要/.exec(types)
  check('摘要标记只有一处字面量定义', Boolean(literal))
  check(
    '主进程与渲染层没有各自复制一份字面量',
    (compaction.match(/【以下是之前对话的摘要/g) || []).length === 0 &&
      (panel.match(/【以下是之前对话的摘要/g) || []).length === 0
  )
}

/* ══ 6. 压缩不能阻断对话 ════════════════════════════════════ */

{
  /*
   * 总结失败必须降级为「按完整历史发送」，绝不能把这次提问打挂。
   * 学生宁可看到一次超预算的可读报错，也不该看到「发不出去」。
   */
  check(
    '自动压缩失败时不抛异常（降级为按原样发送）',
    /压缩失败，本次仍按完整历史发送/.test(ai)
  )
  check('压缩在预算检查之前（否则超预算先被拒绝，压缩等于不存在）', (() => {
    const compactAt = ai.indexOf('await compactIfNeeded(')
    const checkAt = ai.indexOf('const overBudget = checkContextBudget(wire)')
    return compactAt > 0 && checkAt > compactAt
  })())
  check(
    '缓存命中基准在压缩之后取（否则与真正发出去的不一致）',
    (() => {
      const compactAt = ai.indexOf('await compactIfNeeded(')
      const promptAt = ai.indexOf('const promptText = flattenPrompt(wire)')
      return compactAt > 0 && promptAt > compactAt
    })()
  )
}

/* ══ 7. 摘要不能被当成系统提示词顶掉（两个真实 bug） ════════ */

{
  /*
   * ★★ 这一组守的是我在实现时**真踩到**的两个 bug，都属于
   * 「摘要与系统提示词都是 system 角色，代码分不清」：
   *
   *   a) 注入系统提示词时 `findIndex(role === 'system')` 会命中摘要，
   *      把摘要**整个替换掉** → AI 突然失忆（请求照常成功，完全静默）
   *   b) 重组 wire 时同样的写法取到摘要当提示词，造成**两条摘要**
   *
   * 判据：不允许再出现「裸的」`findIndex((m) => m.role === 'system')`
   * 拿来当系统提示词用。必须走 injectSystemPrompt / rebuildAfterCompaction，
   * 那两个函数会用 SUMMARY_MARKER 把摘要排除在外。
   */
  const bare = /findIndex\(\(m\) => m\.role === 'system'\)/g
  const hits = ai.match(bare) || []
  check(
    '没有裸的「第一条 system 就是系统提示词」写法',
    hits.length === 0,
    hits.length > 0 ? `还有 ${hits.length} 处会把摘要顶掉` : ''
  )

  check('存在 injectSystemPrompt（注入时跳过摘要）', /function injectSystemPrompt/.test(ai))
  check(
    'injectSystemPrompt 用 SUMMARY_MARKER 区分摘要',
    /function injectSystemPrompt[\s\S]{0,700}?SUMMARY_MARKER/.test(ai)
  )
  check(
    'rebuildAfterCompaction 也用 SUMMARY_MARKER 区分摘要',
    /function rebuildAfterCompaction[\s\S]{0,700}?SUMMARY_MARKER/.test(ai)
  )

  // 两个压缩入口都必须走同一个重建函数（各写一遍正是 bug 来源）
  const rebuilds = ai.match(/rebuildAfterCompaction\(wire,/g) || []
  check('自动压缩与手动压缩共用 rebuildAfterCompaction', rebuilds.length === 2,
    `调用 ${rebuilds.length} 次`)
}

/* ══ 8. 重复压缩不能丢更早的摘要 ════════════════════════════ */

{
  /*
   * ★★ 第二次压缩时，head 里躺着上一次的摘要。
   * 若总结输入把它排除（只收 user/assistant），它既不进新摘要、
   * 又会被新摘要替换掉 —— 最早那段对话的信息**彻底消失**，
   * 而且每压一次再丢一层。表现是「聊得越久，AI 越不记得开头」。
   */
  const fn = /function toSummarizeInput[\s\S]*?\n\}/.exec(compaction)
  check('toSummarizeInput 存在', Boolean(fn))
  if (fn) {
    check(
      '总结输入里保留了已有摘要（否则重复压缩会丢更早的上下文）',
      fn[0].includes('SUMMARY_MARKER'),
      '必须把上一次的摘要一并喂给总结'
    )
    // 仍然要跳过 tool 输出（那些可以重新获得，压进去没意义）
    check('总结输入仍然跳过 tool 输出', /role !== 'user' && message\.role !== 'assistant'/.test(fn[0]))
  }
}

/* ══ 9. 切分与阈值用的常量只有一处 ══════════════════════════ */

{
  const policy = read('src/main/compaction-policy.ts')
  // 比例必须是 0.8（用户明确的「到 80% 就压缩」）
  check('触发比例是 0.8（用户要求：到窗口 80% 压缩）', /COMPACT_AT_RATIO = 0\.8/.test(policy))
  // 不再有旧公式的因子常量残留
  check(
    '旧的「减输出预留」因子常量已移除',
    !/OPTIMIZATION_THRESHOLD_FACTOR|PROTECTION_THRESHOLD_FACTOR/.test(policy)
  )
  check('保留轮数有具名常量', /KEEP_RECENT_USER_TURNS = \d+/.test(policy))
}

console.log(
  failures === 0
    ? '\n压缩接线校验：全部通过（摘要能落盘、能发回、两端对得上）'
    : `\n压缩接线校验：${failures} 项失败`
)
process.exit(failures === 0 ? 0 : 1)
