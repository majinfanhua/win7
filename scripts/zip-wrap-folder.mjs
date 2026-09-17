/**
 * 打包收尾：给 zip 里的文件套一层顶层文件夹。
 *
 * ## 为什么需要它
 *
 * electron-builder 的 zip 目标打出来是**平铺**的：解压出来就是
 * hangkeIDE.exe + locales/ + resources/ + 使用说明.txt + 十几个 dll，
 * 全散在「下载」目录里。学生解压完看到一屏文件，不知道该双击哪个，
 * 想删干净也得一个个挑 —— 而这些文件里还有 chrome_100_percent.pak
 * 这种看不出属于谁的东西。
 *
 * 套一层 `hangkeIDE-0.2.1-win7-win10-x64/` 之后，解压得到的是一个文件夹，
 * 和常见软件的压缩包一样：整个文件夹拖到 D:\ 下就能用，不想要了整个删掉。
 *
 * ## 为什么是「打包之后改 zip」而不是「打之前挪目录」
 *
 * electron-builder 24.x 的 zip 目标**没有**「包一层目录」的选项：
 * 看 node_modules/app-builder-lib/out/targets/ArchiveTarget.js，
 * Windows 上写死了 `withoutDir = !isMac` → 传 `true`，
 * 于是 7za 拿到的是 `.`（平铺）。配置里能加的只有 artifactName，
 * 改不了归档内的路径。
 *
 * 所以走 `afterAllArtifactBuild` 钩子（配置见 electron-builder.yml），
 * 用 7za 的 `rn` 命令把每个顶层条目重命名到目标文件夹下。
 * 选 `rn` 而不是「解压 → 重新压缩」有两个实在的理由：
 *
 *   1. **不重压**。97 MB 的包解压再压一遍要几分钟，而且 7za 的
 *      Deflate 与 electron-builder 用的参数未必一致，压出来可能更大。
 *      `rn` 只改中央目录里的路径字段，实测 0.07 秒。
 *   2. **不碰文件内容**。CRC、压缩数据、时间戳、UTF-8 标志位（0x800）
 *      原样保留 —— 中文文件名「使用说明.txt」不会因为这一趟而变乱码。
 *
 * ## 幂等
 *
 * 已经套好的包再跑一次不会被套成两层：检测到「顶层只有一个目录、
 * 且名字就是目标名」就直接跳过。手工重跑（`npm run zip:wrap`）安全。
 */
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/**
 * 借用 electron-builder 自己带的 7za。
 *
 * 不引新依赖：`7zip-bin` 是 electron-builder 的依赖（见 package-lock.json），
 * `npm ci` 一定装得上，而且它带齐了三个平台的二进制 ——
 * CI 跑在 Windows 上取 win/7za.exe，开发机验证时取 linux/7za，
 * 同一份脚本两边都能跑。
 *
 * 取到之后要补一次 chmod：npm 解包时不给它可执行位（实测 linux/7za 是
 * -rw-r--r--），直接 spawn 会 EACCES。electron-builder 自己也这么干
 * （见 builder-util/out/7za.js 的 getPath7za），照抄同一套做法。
 * Windows 上 chmod 改的是只读位，.exe 本来就能跑，出错也无所谓 —— 所以吞掉异常。
 */
function sevenZip() {
  let bin
  try {
    bin = require('7zip-bin').path7za
  } catch (err) {
    throw new Error(
      `找不到 7zip-bin（electron-builder 的依赖，npm ci 会装上）：${String(err)}`
    )
  }
  if (!fs.existsSync(bin)) throw new Error(`7za 不存在：${bin}`)
  try {
    fs.chmodSync(bin, 0o755)
  } catch {
    /* Windows 上不需要，失败也不影响 */
  }
  return bin
}

/**
 * 列出 zip 里的条目。
 *
 * 用 `l -slt`（技术信息）而不是默认的表格输出：默认表格按列宽对齐，
 * 中文文件名的显示宽度算不准，切列会切歪。`-slt` 是 `键 = 值` 一行一条，
 * 没有对齐问题。
 *
 * 返回顺序与归档内一致（不改动顺序，重命名后学生看到的仍是原来的排列）。
 */
function listEntries(zip) {
  const out = execFileSync(sevenZip(), ['l', '-slt', zip], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024
  })

  const entries = []
  let current = null
  let inList = false
  for (const rawLine of out.split(/\r?\n/)) {
    const line = rawLine.trimEnd()
    // 分隔线之前是归档自身的信息（也有一个 Path =），不能算条目
    if (!inList) {
      if (line.startsWith('----------')) inList = true
      continue
    }
    if (line.startsWith('Path = ')) {
      current = { path: line.slice(7), dir: false, size: 0 }
      continue
    }
    if (!current) continue
    if (line.startsWith('Folder = ')) {
      current.dir = line.slice(9).trim() === '+'
      continue
    }
    if (line.startsWith('Size = ')) {
      current.size = Number(line.slice(7)) || 0
      continue
    }
    // 条目之间是空行，见到就收一条
    if (line === '') {
      entries.push(current)
      current = null
    }
  }
  if (current) entries.push(current)
  return entries
}

/** 条目 → 「相对路径 => 类型:大小」，用于重命名前后的等价性比对 */
function fingerprint(entries, stripPrefix = '') {
  const map = new Map()
  for (const entry of entries) {
    let key = entry.path
    if (stripPrefix) {
      if (key === stripPrefix) key = ''
      else if (key.startsWith(`${stripPrefix}/`)) key = key.slice(stripPrefix.length + 1)
      else continue
    }
    map.set(key, `${entry.dir ? 'D' : 'F'}:${entry.size}`)
  }
  return map
}

function assertSameContent(before, after, zip) {
  if (before.size !== after.size) {
    throw new Error(`${zip} 重命名后条目数变了：${before.size} → ${after.size}`)
  }
  for (const [key, value] of before) {
    if (after.get(key) !== value) {
      throw new Error(`${zip} 重命名后内容对不上：${key || '<归档根>'} 期望 ${value}，实际 ${after.get(key)}`)
    }
  }
}

/**
 * 给一个 zip 套上顶层文件夹，返回是否真的改了。
 *
 * 顶层文件夹的名字 = 产物文件名去掉扩展名，例如
 * `hangkeIDE-0.2.1-win7-win10-x64.zip` → `hangkeIDE-0.2.1-win7-win10-x64/`。
 * 用产物名而不是写死 productName：这样 x64 与 ia32 两个包解压出来
 * 是两个不同名字的文件夹，放在同一个目录里不会互相覆盖。
 */
function wrapZip(zip) {
  const name = path.basename(zip)
  const folder = path.basename(zip, path.extname(zip))

  const before = listEntries(zip)
  if (before.length === 0) throw new Error(`${name} 里没有任何条目，打包可能没完成`)

  const tops = new Set(before.map((entry) => entry.path.split('/')[0]))

  // 幂等：顶层已经只有这一个目录，说明套过了
  if (tops.size === 1 && tops.has(folder)) {
    console.log(`[zip-wrap] ${name} 已有一层文件夹，跳过`)
    return false
  }

  // 顶层有个同名目录、却还有散落文件：套下去会变成 folder/folder/…
  // 与其猜，不如报错让人看一眼
  if (before.some((entry) => entry.path !== folder && entry.path.startsWith(`${folder}/`))) {
    throw new Error(
      `${name} 里已经有 ${folder}/ 这个目录，同时又有多余的顶层条目，` +
        '无法安全地套文件夹（套下去会出现两层同名目录）'
    )
  }

  // 一个 rn 命令里可以带多组「原名 新名」，一次改完，避免逐个调用
  const pairs = []
  for (const top of tops) pairs.push(top, `${folder}/${top}`)

  console.log(`[zip-wrap] ${name}：${tops.size} 个顶层条目 → ${folder}/`)
  execFileSync(sevenZip(), ['rn', zip, ...pairs], { stdio: 'inherit' })

  // 校验。7za 的 rn 是原地改中央目录，出错不一定会给非 0 退出码，
  // 而「包坏了」的代价是学生拿到一个解压不了的 zip —— 所以这里必须自己看结果：
  // 条目数、类型、大小三者逐一比对，任何一条对不上就让构建失败。
  const after = listEntries(zip)
  assertSameContent(fingerprint(before), fingerprint(after, folder), name)

  console.log(`[zip-wrap] ${name} 完成：解压后是 ${folder}/ 一个文件夹（${after.length} 个条目）`)
  return true
}

/** 收集要处理的 zip：优先用构建结果给的产物列表 */
function zipTargets(artifactPaths) {
  const list = Array.isArray(artifactPaths) ? artifactPaths : []
  const fromBuild = list.filter(
    (p) => typeof p === 'string' && p.toLowerCase().endsWith('.zip') && fs.existsSync(p)
  )
  if (fromBuild.length > 0) return fromBuild

  /*
   * 没拿到构建结果（手工跑 `npm run zip:wrap`）时扫 release/。
   *
   * 目录从 electron-builder.yml 的 directories.output 读，不写死 'release'：
   * 那个值改过一次就会对不上，而症状是「脚本说没有 zip，产物其实在那儿」，
   * 排查起来要绕一圈。读不到就退回默认值。
   */
  const dir = path.join(root, readOutputDir())
  if (!fs.existsSync(dir)) return []
  return fs
    .readdirSync(dir)
    .filter((f) => f.toLowerCase().endsWith('.zip'))
    .map((f) => path.join(dir, f))
}

/** 从 electron-builder.yml 里取 directories.output */
function readOutputDir() {
  try {
    const yml = fs.readFileSync(path.join(root, 'electron-builder.yml'), 'utf8')
    const match = /^\s*output:\s*(\S+)\s*$/m.exec(yml)
    return match ? match[1].replace(/^['"]|['"]$/g, '') : 'release'
  } catch {
    return 'release'
  }
}

/**
 * electron-builder 的钩子入口（配置见 electron-builder.yml）。
 *
 * 返回 `[]` 是**刻意**的：这个钩子可以把「新增的产物」交给发布流程，
 * 而这里只是原地改了已有的 zip，没有新增任何文件。返回 zip 列表的话，
 * electron-builder 会以为它们是新产物，走一遍发布调度 —— 没意义。
 */
export async function afterAllArtifactBuild(buildResult) {
  const zips = zipTargets(buildResult && buildResult.artifactPaths)
  if (zips.length === 0) {
    console.log('[zip-wrap] 本次构建没有 zip 产物，跳过')
    return []
  }
  for (const zip of zips) wrapZip(zip)
  return []
}

export default afterAllArtifactBuild

// 允许单独跑：node scripts/zip-wrap-folder.mjs [zip...]
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  const targets = args.length > 0 ? args.map((p) => path.resolve(p)) : zipTargets(null)
  if (targets.length === 0) {
    console.error('[zip-wrap] 没有找到任何 zip（默认看 release/ 目录，也可以直接传路径）')
    process.exit(1)
  }
  try {
    for (const zip of targets) wrapZip(zip)
  } catch (err) {
    console.error(`[zip-wrap] 失败：${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
  }
}
