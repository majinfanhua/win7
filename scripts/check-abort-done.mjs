/**
 * 护栏：中断请求后必须发 done。
 *
 * ## 为什么需要它
 *
 * 渲染层的「正在生成」状态**只在收到 done / error 时才清**。
 * 所以主进程在任何提前 return 的分支里，都必须先 emit 一个 done ——
 * 否则用户点了「停止」，主进程确实停了，界面却一直转圈，
 * 看起来像「停止无效」。
 *
 * 这个坑踩过：`if (aborted.has(requestId)) { aborted.delete(...); return }`
 * 两处都是静默返回，于是「点了停止，消息还在加载中」。
 * 它属于**最讨厌的一类 bug** —— 两侧单独看都对（主进程停了、渲染层逻辑没问题），
 * 只有把「没人通知」这件事看出来才能定位。
 *
 * ## 检查方式
 *
 * 找 ai.ts 里所有 `aborted.has(requestId)` 的判断块，要求块内同时出现
 * 「发 done」的 emit。静态检查对这种「约定式」的遗漏很有效：
 * 以后有人加一个新的中断分支、忘了发 done，这里会直接红。
 *
 * 只扫这一处、只认这一种形状 —— 宁可窄一点也不要误报，
 * 误报一次这道护栏就没人信了。
 */
import fs from 'node:fs'

const FILE = 'src/main/ipc/ai.ts'

if (!fs.existsSync(FILE)) {
  console.error(`[abort-check] 找不到 ${FILE}`)
  process.exit(1)
}

const src = fs.readFileSync(FILE, 'utf8')
const lines = src.split('\n')
const problems = []

/*
 * 逐个找 `if (aborted.has(requestId)) {`，然后往下扫到该块的右花括号，
 * 看块内有没有 emit done。
 */
lines.forEach((line, i) => {
  if (!/aborted\.has\(requestId\)/.test(line)) return
  // 只看作为 if 条件的那些（赋值、日志里提到的不算）
  if (!/if\s*\(/.test(line)) return

  // 花括号计数，找到这个块结束的位置
  let depth = 0
  let started = false
  let block = ''
  for (let j = i; j < lines.length; j++) {
    const text = lines[j]
    for (const ch of text) {
      if (ch === '{') {
        depth++
        started = true
      } else if (ch === '}') {
        depth--
      }
    }
    block += text + '\n'
    if (started && depth <= 0) break
    // 防御：块异常长说明匹配错了，别把整个文件吞进来
    if (j - i > 60) break
  }

  const emitsDone = /emit\s*\(\s*\{[^}]*kind:\s*'done'/.test(block)
  if (!emitsDone) {
    problems.push(`第 ${i + 1} 行：中断分支没有 emit done（用户点了停止会一直转圈）`)
  }
})

if (problems.length > 0) {
  console.error('')
  console.error('[abort-check] 中断请求的分支必须先通知前端：')
  for (const p of problems) console.error(`  - ${p}`)
  console.error('')
  console.error('[abort-check] 渲染层的「正在生成」只在收到 done / error 时才清。')
  console.error('[abort-check] 提前 return 而不发 done，表现是「点了停止但还在加载中」。')
  console.error('[abort-check] 修法：在 return 前加 emit({ requestId, kind: \'done\' })')
  console.error('')
  process.exit(1)
}

const branchCount = lines.filter((l) => /if\s*\(.*aborted\.has\(requestId\)/.test(l)).length
console.log(`[abort-check] 通过，${branchCount} 个中断分支都发了 done`)
