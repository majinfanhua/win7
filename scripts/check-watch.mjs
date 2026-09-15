/**
 * 文件监视的离线校验。
 *
 * 为什么单独一个脚本而不是塞进 smoke：
 * smoke 跑的是真实 Electron 窗口，只验证「界面渲染成什么样」；
 * 而这里验证的是「AI 写文件之后，事件能不能被监视器捕到、来源标记对不对」，
 * 是纯 Node 的时序问题，不需要窗口。两者混在一起会让 smoke 变得不稳。
 *
 * 用法：node scripts/check-watch.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const DEBOUNCE_MS = 120
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

const root = path.join(os.tmpdir(), `watch-check-${Date.now()}`)
fs.mkdirSync(path.join(root, 'sub'), { recursive: true })
fs.mkdirSync(path.join(root, 'node_modules'), { recursive: true })

const watched = path.join(root, 'sub', 'a.txt')
fs.writeFileSync(watched, 'one')

// 与被测实现相同的 debounce 结构：同一路径的重复事件合并成一次
const pending = new Map()
const events = []

const watcher = fs.watch(root, { recursive: true, persistent: false }, (_event, filename) => {
  if (!filename) return
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

await new Promise((r) => setTimeout(r, 300))

/**
 * 等一会儿，让本步骤的 debounce 定时器全部落地。
 *
 * 这一步不能省。Windows 上一次写入会产生 2~3 个原生事件，其中可能有
 * 晚到的（rename 的事件会滞后），不静默就取下一个窗口的快照，
 * 上一步的迟到事件会飘进下一步的统计里，断言莫名差一条。
 * 测试自己不稳比测试失败更糟 —— 会让人去改本来正确的实现。
 */
const settle = () => new Promise((r) => setTimeout(r, DEBOUNCE_MS + 500))

/**
 * 数一次「独立操作」产生了多少条通知。
 *
 * 每次用不同的文件：同一个文件连续操作时，前一次迟到的原生事件
 * 会和后一次的合并进同一个 debounce 窗口，数出来的条数就不可信了。
 * 换成新文件后，每个断言只关心自己的那一个路径。
 */
async function countNotifications(label, action) {
  await settle()
  const before = events.length
  action()
  await settle()
  return events.length - before
}

// 1. 原子替换：写 .tmp 再 rename，和 file-tools 的 atomicWrite 一致
const tmp1 = `${watched}.tmp`
fs.writeFileSync(tmp1, 'two')
fs.renameSync(tmp1, watched)
await settle()

check('原子替换（.tmp + rename）能被捕到', events.some((p) => p === watched), `events=${events.length}`)

// 2. debounce 去重：一次写入通常触发多个原生事件，应合并成一个
const probe2 = path.join(root, 'sub', 'b.txt')
const n2 = await countNotifications('debounce', () => fs.writeFileSync(probe2, 'hello'))
check('同一次写入被合并成一条事件', n2 === 1, `新增=${n2}`)

// 3. 忽略目录：node_modules 里的改动不该通知界面
const n3 = await countNotifications('ignore-dir', () =>
  fs.writeFileSync(path.join(root, 'node_modules', 'x.js'), 'noise')
)
check('node_modules 内的改动被忽略', n3 === 0, `新增=${n3}`)

// 4. 临时文件后缀不该通知
const n4 = await countNotifications('ignore-tmp', () =>
  fs.writeFileSync(path.join(root, 'sub', 'c.txt.swp'), 'noise')
)
check('临时后缀文件被忽略', n4 === 0, `新增=${n4}`)

watcher.close()
for (const timer of pending.values()) clearTimeout(timer)
fs.rmSync(root, { recursive: true, force: true })

console.log(failures === 0 ? '\n文件监视校验：全部通过' : `\n文件监视校验：${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)
