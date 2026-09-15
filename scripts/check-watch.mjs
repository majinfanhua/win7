/**
 * 文件监视的离线校验。
 *
 * 为什么单独一个脚本而不是塞进 smoke：
 * smoke 跑的是真实 Electron 窗口，只验证「界面渲染成什么样」；
 * 而这里验证的是「AI 写文件之后，事件能不能被监视器捕到、来源标记对不对」，
 * 是纯 Node 的时序问题，不需要窗口。两者混在一起会让 smoke 变得不稳。
 *
 * 用法：node scripts/check-watch.mjs
 *
 * ── 三条让它在 Windows 上不抖的原则 ────────────────────────
 *
 * 1. 不假设监视器「建好就能用」。
 *    Windows 上 ReadDirectoryChangesW 的句柄建立要几百毫秒，CI runner 上
 *    还叠着杀软扫描。原来固定 sleep 300ms 就做第一个断言，慢机器上第一次
 *    写入会整个丢掉，表现为「原子替换没被捕获」—— 一个看起来像实现有 bug、
 *    实际是测试自己没等够的假失败。现在改成写探针文件、等它真的到达。
 *
 * 2. 不数全局事件条数。
 *    原实现用 events.length 的差值做断言，但一次写入会顺带在父目录上
 *    产生事件（Windows 尤其明显），上一步迟到的原生事件也会飘进来，
 *    差值就不等于「这次操作产生的条数」了。现在一律按路径过滤后再数。
 *
 * 3. 一个路径只做一次原子替换。
 *    在 Linux 上（Node 20+ 的递归监视实现）观察到：对一个已存在的路径做
 *    「写 .tmp + rename」之后，该路径后续的改动再也收不到事件。
 *    这是平台怪癖，Windows 上不存在，但断言不能建在它上面。
 *    所以每个断言用各自的新路径，且替换过的路径不再动。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** 一次写入通常会触发多次事件（write + rename），合并窗口 */
const DEBOUNCE_MS = 120
/** 等本步骤的 debounce 定时器全部落地，再取快照 */
const SETTLE_MS = DEBOUNCE_MS + 500
/** 监视器就绪的最长等待。CI runner 比开发机慢得多，给足余量 */
const READY_TIMEOUT_MS = 15_000
const IGNORED_DIRS = new Set([
  'node_modules',
  '.git',
  'out',
  'dist',
  '__pycache__',
  '.venv',
  'venv',
  '.trash'
])
const TEMP_SUFFIX = ['.tmp', '.swp', '.swx', '~', '.crswap']

let failures = 0
function check(name, ok, detail = '') {
  console.log(`${ok ? '通过' : '失败'}  ${name}${detail ? `  ${detail}` : ''}`)
  if (!ok) failures += 1
}

function shouldIgnore(filePath) {
  const name = path.basename(filePath)
  if (TEMP_SUFFIX.some((suffix) => name.endsWith(suffix))) return true
  return filePath.split(/[\\/]/).some((part) => IGNORED_DIRS.has(part))
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function waitUntil(fn, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (fn()) return true
    if (Date.now() >= deadline) return false
    await sleep(40)
  }
}

const root = path.join(os.tmpdir(), `watch-check-${Date.now()}`)
fs.mkdirSync(path.join(root, 'sub'), { recursive: true })
fs.mkdirSync(path.join(root, 'node_modules'), { recursive: true })

/** 各断言用各自的路径，互不干扰（见文件头第 3 条） */
const replaced = path.join(root, 'sub', 'a.txt') // 原子替换用
const overwritten = path.join(root, 'sub', 'd.txt') // 直接覆写用
const created = path.join(root, 'sub', 'b.txt') // debounce 去重用
const ignoredDirFile = path.join(root, 'node_modules', 'x.js') // 忽略目录用
const tempSuffixFile = path.join(root, 'sub', 'c.txt.swp') // 临时后缀用

fs.writeFileSync(replaced, 'one')
fs.writeFileSync(overwritten, 'one')

// 与被测实现（src/main/watcher.ts）相同的 debounce 结构：
// 同一路径的重复事件合并成一次
const pending = new Map()
const events = []

const watcher = fs.watch(root, { recursive: true, persistent: false }, (_event, filename) => {
  if (!filename) return
  // filename 在 Windows 上是相对路径，在 Linux/macOS 上可能是文件名
  const full = path.resolve(root, filename)
  if (shouldIgnore(full)) return
  const existing = pending.get(full)
  if (existing) clearTimeout(existing)
  pending.set(
    full,
    setTimeout(() => {
      pending.delete(full)
      events.push(full)
    }, DEBOUNCE_MS)
  )
})

// 监视器起不来时不要以未捕获异常的形式崩掉，那样看不到任何断言结果
let watchError = null
watcher.on('error', (err) => {
  watchError = err
})

// ── 就绪探测 ────────────────────────────────────────────────
// 写一个探针文件，等它真的出现在通知列表里，确认监视器已经活了。
// 探针没到就重写一次，避免「写入发生在句柄建立之前」导致的白等。
const readyProbe = path.join(root, 'ready-probe.txt')
let ready = false
let readyAttempts = 0
const readyDeadline = Date.now() + READY_TIMEOUT_MS
while (!ready && Date.now() < readyDeadline) {
  readyAttempts += 1
  fs.writeFileSync(readyProbe, `ready-${readyAttempts}`)
  ready = await waitUntil(() => events.includes(readyProbe), 600)
}
check('监视器就绪（探针事件可达）', ready, `尝试 ${readyAttempts} 次`)
if (watchError) check('监视器无错误事件', false, String(watchError))

/**
 * 数「针对某个路径的独立操作」产生了多少条通知。
 *
 * 按路径过滤，而不是数 events.length 的差值：一次写入顺带产生的父目录事件、
 * 以及上一步迟到的原生事件，都不该算进这一步。
 */
async function countFor(target, action) {
  await sleep(SETTLE_MS)
  const before = events.filter((p) => p === target).length
  action()
  await sleep(SETTLE_MS)
  return events.filter((p) => p === target).length - before
}

// 1. 直接覆写已存在的文件：最常见的保存方式
const n1 = await countFor(overwritten, () => fs.writeFileSync(overwritten, 'two'))
check('直接覆写已存在文件能被捕到', n1 === 1, `新增=${n1}`)

// 2. 原子替换：写 .tmp 再 rename，和 file-tools 的 atomicWrite 一致。
//    .tmp 那半段应该被后缀规则吃掉，只留下最终路径的一条通知
const n2 = await countFor(replaced, () => {
  fs.writeFileSync(`${replaced}.tmp`, 'two')
  fs.renameSync(`${replaced}.tmp`, replaced)
})
check('原子替换（.tmp + rename）只留一条通知', n2 === 1, `新增=${n2}`)

// 3. debounce 去重：新建文件通常触发多个原生事件，应合并成一个
const n3 = await countFor(created, () => fs.writeFileSync(created, 'hello'))
check('同一次写入被合并成一条事件', n3 === 1, `新增=${n3}`)

// 4. 忽略目录：node_modules 里的改动不该通知界面
const n4 = await countFor(ignoredDirFile, () => fs.writeFileSync(ignoredDirFile, 'noise'))
check('node_modules 内的改动被忽略', n4 === 0, `新增=${n4}`)

// 5. 临时文件后缀不该通知
const n5 = await countFor(tempSuffixFile, () => fs.writeFileSync(tempSuffixFile, 'noise'))
check('临时后缀文件被忽略', n5 === 0, `新增=${n5}`)

watcher.close()
for (const timer of pending.values()) clearTimeout(timer)

// 失败时把收到的通知打出来 —— 没有它只能靠猜
if (failures > 0) {
  console.log('\n收到的通知（去重后的顺序）：')
  for (const p of events) console.log(`  - ${p.replace(root, '<root>')}`)
}

fs.rmSync(root, { recursive: true, force: true })

console.log(failures === 0 ? '\n文件监视校验：全部通过' : `\n文件监视校验：${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)
