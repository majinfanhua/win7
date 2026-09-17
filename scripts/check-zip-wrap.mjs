/**
 * 护栏：zip 套文件夹的字节级改写。
 *
 * ## 为什么需要它
 *
 * 这个功能**在 CI 上挂过一次**，而且失败方式很难查：
 * 第一版实现调外部 `7za rn` 并解析它的文本输出来拿文件名。
 * 开发机上（Linux p7zip 16.02）一切正常，CI 上（Windows 7-Zip 21.07）挂了 ——
 * 因为 7za 按**控制台代码页**输出文件名，英文 runner 表示不了「使用说明.txt」，
 * 读回来是乱码，再喂回 `rn` 就匹配不到；而匹配不到时 7za 的退出码仍是 0，
 * **静默什么都没做**。job 日志还要 admin 权限才拿得到，只能靠猜。
 *
 * 现在改成纯 Node 直接改 zip 字节，不依赖任何外部程序。
 * 但字节级改写本身就有一串容易错的细节，所以钉住它们：
 *
 *   1. 条目名在 zip 里存**两份**（local header + 中央目录），两份都要加前缀 ——
 *      漏一份的话，有的解压工具读 local、有的读 CD，行为不一致
 *   2. 名字变长会让后面所有数据后移，中央目录里的 local 偏移必须是
 *      **累计**平移量（前 N 条增长量之和），不是「这一条自己长的量」
 *   3. 压缩数据必须**原样搬运**：CRC、时间戳、压缩方法、UTF-8 标志位都不能变
 *      （中文文件名变了就是乱码，而这个包里有「使用说明.txt」）
 *   4. 必须幂等，且能识别「已经套过」
 *   5. Zip64 等不认识的形态要**明确报错**，不能猜着改出坏包
 *
 * 测试用的 zip 由本脚本自己按 zip 规范拼出来（只用 node:zlib），
 * 所以不依赖 electron-builder、不依赖 7za、也不依赖产物已经存在 ——
 * 能在打包之前就跑。校验则用另一条独立路径：自己重新解析一遍结构。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')

let failures = 0
function check(name, ok, detail = '') {
  console.log(`${ok ? '通过' : '失败'}  ${name}${detail ? `  ${detail}` : ''}`)
  if (!ok) failures += 1
}

/* ── 一个够用的 zip 写入器（只为造测试数据）─────────────────── */

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()

function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

/**
 * 造一个 zip。
 * @param entries [{ name: string, data?: string, dir?: boolean }]
 * @param opts.comment 归档注释（用来测「带注释的 zip」）
 */
function buildZip(entries, opts = {}) {
  const locals = []
  const centrals = []
  let offset = 0

  for (const entry of entries) {
    // 目录条目：名字以 / 结尾、内容为空、用 store
    const isDir = Boolean(entry.dir)
    const nameBuf = Buffer.from(entry.name, 'utf8')
    const raw = isDir ? Buffer.alloc(0) : Buffer.from(entry.data ?? '', 'utf8')
    const method = isDir ? 0 : 8
    const comp = isDir ? raw : zlib.deflateRawSync(raw)
    const crc = crc32(raw)

    const local = Buffer.alloc(30 + nameBuf.length)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4) // version needed
    // 0x800 = 文件名是 UTF-8。有非 ASCII 名字时才置位，与 7za 的行为一致
    const flag = /[^\x00-\x7f]/.test(entry.name) ? 0x800 : 0
    local.writeUInt16LE(flag, 6)
    local.writeUInt16LE(method, 8)
    local.writeUInt16LE(0, 10) // time
    local.writeUInt16LE(0x2821, 12) // date（固定值，便于比对）
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(comp.length, 18)
    local.writeUInt32LE(raw.length, 22)
    local.writeUInt16LE(nameBuf.length, 26)
    local.writeUInt16LE(0, 28) // extra len
    nameBuf.copy(local, 30)

    const central = Buffer.alloc(46 + nameBuf.length)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4) // version made by
    central.writeUInt16LE(20, 6) // version needed
    central.writeUInt16LE(flag, 8)
    central.writeUInt16LE(method, 10)
    central.writeUInt16LE(0, 12)
    central.writeUInt16LE(0x2821, 14)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(comp.length, 20)
    central.writeUInt32LE(raw.length, 24)
    central.writeUInt16LE(nameBuf.length, 28)
    central.writeUInt16LE(0, 30) // extra
    central.writeUInt16LE(0, 32) // comment
    central.writeUInt16LE(0, 34) // disk
    central.writeUInt16LE(0, 36) // internal attrs
    central.writeUInt32LE(isDir ? 0x41ed0010 : 0x81a40000, 38) // external attrs
    central.writeUInt32LE(offset, 42)
    nameBuf.copy(central, 46)

    locals.push(local, comp)
    centrals.push(central)
    offset += local.length + comp.length
  }

  const cd = Buffer.concat(centrals)
  const comment = Buffer.from(opts.comment ?? '', 'utf8')
  const eocd = Buffer.alloc(22 + comment.length)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(0, 4)
  eocd.writeUInt16LE(0, 6)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(cd.length, 12)
  eocd.writeUInt32LE(offset, 16)
  eocd.writeUInt16LE(comment.length, 20)
  comment.copy(eocd, 22)

  return Buffer.concat([...locals, cd, eocd])
}

/* ── 独立解析器（校验用，与被测脚本不是同一份代码）──────────── */

function readZip(buf) {
  /*
   * EOCD 在文件末尾，但**归档注释会跟在它后面**（最多 65535 字节），
   * 所以要从后往前扫。直接取 `length - 22` 的话，带注释的包会解析失败 ——
   * 写这段测试时就踩了一次。
   */
  let eocd = -1
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new Error('测试解析器：找不到 EOCD')
  const count = buf.readUInt16LE(eocd + 10)
  const cdSize = buf.readUInt32LE(eocd + 12)
  const cdOffset = buf.readUInt32LE(eocd + 16)
  const entries = []
  let p = cdOffset
  for (let i = 0; i < count; i++) {
    const nameLen = buf.readUInt16LE(p + 28)
    const extraLen = buf.readUInt16LE(p + 30)
    const cmtLen = buf.readUInt16LE(p + 32)
    const localOffset = buf.readUInt32LE(p + 42)
    entries.push({
      name: buf.subarray(p + 46, p + 46 + nameLen).toString('utf8'),
      crc: buf.readUInt32LE(p + 16),
      compSize: buf.readUInt32LE(p + 20),
      size: buf.readUInt32LE(p + 24),
      method: buf.readUInt16LE(p + 10),
      dateTime: buf.readUInt32LE(p + 12),
      flag: buf.readUInt16LE(p + 8),
      localOffset,
      // local header 里的名字，用来验两份是否一致
      localName: (() => {
        const nl = buf.readUInt16LE(localOffset + 26)
        return buf.subarray(localOffset + 30, localOffset + 30 + nl).toString('utf8')
      })(),
      data: (() => {
        const nl = buf.readUInt16LE(localOffset + 26)
        const el = buf.readUInt16LE(localOffset + 28)
        const start = localOffset + 30 + nl + el
        const comp = buf.subarray(start, start + buf.readUInt32LE(p + 20))
        return buf.readUInt16LE(p + 10) === 0 ? comp : zlib.inflateRawSync(comp)
      })()
    })
    p += 46 + nameLen + extraLen + cmtLen
  }
  return { entries, cdSize, cdOffset, eocd, commentLen: buf.readUInt16LE(eocd + 20) }
}

/**
 * 载入被测模块。
 *
 * ⚠️ 必须用 pathToFileURL 转成 file:// URL，不能直接 `import('D:\\a\\...')`。
 * ESM 加载器只认 file / data / node 三种 scheme，Windows 上的绝对路径
 * （`D:\a\...`）会被当成 scheme `d:` 而报 ERR_UNSUPPORTED_ESM_URL_SCHEME。
 * 在 Linux 上跑永远正常（`/home/...` 恰好能当相对 URL 解析），
 * 这个错犯过一次，而且只在 CI 上暴露 —— 又是「开发机是 Linux」那类坑。
 */
const { afterAllArtifactBuild } = await import(
  pathToFileURL(path.join(root, 'scripts/zip-wrap-folder.mjs')).href
)

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zipwrap-'))
const zipPath = path.join(tmp, 'hangkeIDE-0.2.1-win7-win10-x64.zip')

/** 一份有代表性的内容：中文名、子目录、二进制数据、目录条目 */
const SAMPLE = [
  { name: 'hangkeIDE.exe', data: 'MZ' + 'x'.repeat(5000) },
  { name: '使用说明.txt', data: '中文说明内容\n第二行\n' },
  { name: 'locales/', dir: true },
  { name: 'locales/zh-CN.pak', data: 'pak-data' },
  { name: 'resources/app.asar', data: 'asar' + 'y'.repeat(2000) }
]

fs.writeFileSync(zipPath, buildZip(SAMPLE))
const original = readZip(fs.readFileSync(zipPath))
const originalBuf = fs.readFileSync(zipPath)

/* ── 1. 套文件夹 ───────────────────────────────────────────── */
{
  const result = await afterAllArtifactBuild({ artifactPaths: [zipPath] })
  check('钩子返回空数组（不把已有产物当新产物发布）', Array.isArray(result) && result.length === 0)

  const after = readZip(fs.readFileSync(zipPath))
  const expected = 'hangkeIDE-0.2.1-win7-win10-x64'
  const tops = new Set(after.entries.map((e) => e.name.split('/')[0]))
  check('顶层只剩一个目录', tops.size === 1 && tops.has(expected), `[${[...tops].join(', ')}]`)
  check('条目数不变', after.entries.length === original.entries.length,
    `${original.entries.length} → ${after.entries.length}`)

  /* ── 2. 内容与元数据逐条比对 ─────────────────────────────── */
  const byName = new Map(after.entries.map((e) => [e.name, e]))
  let metaBad = 0
  let dataBad = 0
  let nameBad = 0
  for (const before of original.entries) {
    const moved = `${expected}/${before.name}`
    const now = byName.get(moved)
    if (!now) {
      metaBad++
      continue
    }
    if (now.crc !== before.crc || now.size !== before.size || now.method !== before.method ||
        now.dateTime !== before.dateTime || now.flag !== before.flag) metaBad++
    if (!now.data.equals(before.data)) dataBad++
    // 两份名字必须都改了前缀，且彼此一致
    if (now.localName !== moved) nameBad++
  }
  check('CRC / 大小 / 压缩方法 / 时间戳 / UTF-8 标志位全部保留', metaBad === 0, `不一致 ${metaBad} 条`)
  check('解压内容逐字节一致', dataBad === 0, `不一致 ${dataBad} 条`)
  check('条目名在 local header 与中央目录里都加了前缀', nameBad === 0, `不一致 ${nameBad} 条`)
  check('中文文件名的 UTF-8 标志位仍是 0x800',
    byName.get(`${expected}/使用说明.txt`)?.flag === 0x800)
  check('中央目录仍紧邻 EOCD', after.cdOffset + after.cdSize === after.eocd)
}

/* ── 3. 幂等 ──────────────────────────────────────────────── */
{
  const beforeSecond = readZip(fs.readFileSync(zipPath))
  await afterAllArtifactBuild({ artifactPaths: [zipPath] })
  const afterSecond = readZip(fs.readFileSync(zipPath))
  check('再跑一次不会套成两层', afterSecond.entries.length === beforeSecond.entries.length)
  check('再跑一次顶层仍是同一个目录',
    new Set(afterSecond.entries.map((e) => e.name.split('/')[0])).size === 1)
  check('再跑一次内容没变',
    afterSecond.entries.every((e, i) => e.name === beforeSecond.entries[i].name))
}

/* ── 4. 带注释的 zip ──────────────────────────────────────── */
{
  const p = path.join(tmp, 'with-comment.zip')
  fs.writeFileSync(p, buildZip(SAMPLE, { comment: 'hello 注释' }))
  await afterAllArtifactBuild({ artifactPaths: [p] })
  const z = readZip(fs.readFileSync(p))
  check('带注释的 zip 也能处理', z.entries.length === SAMPLE.length && z.commentLen > 0,
    `注释长度 ${z.commentLen}`)
}

/* ── 5. 空 zip 要报错，不能静默通过 ────────────────────────── */
{
  const p = path.join(tmp, 'empty.zip')
  fs.writeFileSync(p, buildZip([]))
  let threw = false
  try {
    await afterAllArtifactBuild({ artifactPaths: [p] })
  } catch {
    threw = true
  }
  check('空 zip 明确报错', threw)
}

/* ── 6. 非 zip 文件要报错 ─────────────────────────────────── */
{
  const p = path.join(tmp, 'notazip.zip')
  fs.writeFileSync(p, Buffer.from('这不是 zip 文件'))
  let threw = false
  try {
    await afterAllArtifactBuild({ artifactPaths: [p] })
  } catch {
    threw = true
  }
  check('非 zip 文件明确报错', threw)
}

/* ── 7. Zip64 要明确拒绝（不能猜着改出坏包）────────────────── */
{
  const buf = Buffer.from(buildZip(SAMPLE))
  const eocd = buf.length - 22
  // 把条目数写成 0xffff（Zip64 的标志之一）
  buf.writeUInt16LE(0xffff, eocd + 10)
  const p = path.join(tmp, 'zip64.zip')
  fs.writeFileSync(p, buf)
  let threw = false
  try {
    await afterAllArtifactBuild({ artifactPaths: [p] })
  } catch {
    threw = true
  }
  check('Zip64 形态明确拒绝', threw)
}

/* ── 8. 「已有一层目录 + 还有散落文件」要拒绝 ──────────────── */
{
  const name = 'mixed'
  const p = path.join(tmp, `${name}.zip`)
  fs.writeFileSync(p, buildZip([
    { name: `${name}/a.txt`, data: 'a' },
    { name: 'b.txt', data: 'b' }
  ]))
  let threw = false
  try {
    await afterAllArtifactBuild({ artifactPaths: [p] })
  } catch {
    threw = true
  }
  check('已有同名目录又有散落文件时明确拒绝', threw)
}

/* ── 9. 改名后原始文件不被破坏（改动前先全解析）────────────── */
{
  // 校验脚本对坏输入是「拒绝」而不是「写坏一半」：非 zip 的那个文件应保持原样
  const p = path.join(tmp, 'notazip.zip')
  check('拒绝时不动原文件', fs.readFileSync(p).toString() === '这不是 zip 文件')
}

fs.rmSync(tmp, { recursive: true, force: true })

console.log(
  failures === 0
    ? '\nzip 套文件夹校验：全部通过（纯 Node 字节级改写，不依赖 7za）'
    : `\nzip 套文件夹校验：${failures} 项失败`
)
process.exit(failures === 0 ? 0 : 1)
