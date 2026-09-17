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
 * ## 为什么自己改字节，而不是调 7za
 *
 * 第一版是 `7za rn`（重命名归档内条目），**在 CI 上挂了**。
 * 教训值得写下来：那个写法依赖两件**在开发机上测不到**的事 ——
 *
 *   1. 外部 7za 的版本行为。开发机是 Linux 的 p7zip 16.02，
 *      CI runner 是 Windows 的 7-Zip 21.07，两者不是同一个程序。
 *      本项目只出 Windows 包，拿 Linux 的 7za 验证等于没验证。
 *   2. **7za 的文本输出**。它按控制台代码页输出文件名，英文 runner 上
 *      表示不了「使用说明.txt」，读回来是乱码，再喂回 `rn` 就匹配不到。
 *      而且匹配不到时 7za 的退出码仍是 0 —— 静默什么都没做。
 *
 * 现在直接改 zip 结构，不依赖任何外部程序、不解析任何文本输出：
 * 条目名在字节层面加 ASCII 前缀，不需要解码，代码页问题从根上消失。
 * 同一份代码在 Windows / Linux 上行为完全一致。
 *
 * ## 改的是哪些字节
 *
 * 条目名在 zip 里存**两份**：local header（数据前面）与 central directory
 * （文件末尾的索引）。两份都要改。另外因为名字变长，所有数据都会后移 ——
 * 所以 central directory 里每条记录的「local header 偏移」也要跟着加。
 *
 * 数据本身（压缩后的字节流）**原样搬运**：CRC、时间戳、压缩方法、
 * UTF-8 标志位全都不动，中文文件名不会因为这一趟变乱码。
 *
 * ## 幂等
 *
 * 已经套好的包再跑一次不会被套成两层：检测到「顶层只有一个目录、
 * 且名字就是目标名」就直接跳过 —— 打包链路上被重复调用是安全的。
 */
import fs from 'node:fs'
import path from 'node:path'

/* ── zip 结构常量 ─────────────────────────────────────────── */
const SIG_LOCAL = 0x04034b50
const SIG_CD = 0x02014b50
const SIG_EOCD = 0x06054b50
const SIG_EOCD64 = 0x06064b50
const SIG_EOCD64_LOC = 0x07064b50

/** local header 固定部分 30 字节，central directory 记录固定部分 46 字节 */
const LOCAL_FIXED = 30
const CD_FIXED = 46
/** EOCD 固定部分 22 字节 */
const EOCD_FIXED = 22

/**
 * 解析 zip。
 *
 * 只支持本项目实际产出的形态，遇到不认识的形态**明确报错**而不是猜 ——
 * 猜错的后果是学生拿到一个解压不了的包，而构建却是绿的。
 * 具体的限制与理由写在下面每处检查的注释里。
 */
function parseZip(buf) {
  const size = buf.length

  // EOCD 在文件末尾，但可能带注释（最多 65535 字节），所以要往回找
  let eocd = -1
  const scanFrom = Math.max(0, size - EOCD_FIXED - 0xffff)
  for (let i = size - EOCD_FIXED; i >= scanFrom; i--) {
    if (buf.readUInt32LE(i) === SIG_EOCD) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new Error('不是 zip：找不到中央目录结尾记录（EOCD）')

  const commentLen = buf.readUInt16LE(eocd + 20)
  if (eocd + EOCD_FIXED + commentLen !== size) {
    throw new Error('zip 尾部结构与 EOCD 声明的注释长度对不上，拒绝改（可能是分卷包）')
  }

  const entryCount = buf.readUInt16LE(eocd + 10)
  const cdSize = buf.readUInt32LE(eocd + 12)
  const cdOffset = buf.readUInt32LE(eocd + 16)

  /*
   * 拒绝 Zip64。
   *
   * 我们的包 97 MB / 75 个条目，离 Zip64 的门槛（4 GB 或 65535 条目）很远。
   * 一旦出现 Zip64，说明包已经不是预期形态（或者哪天产物真的暴涨到 4 GB），
   * 那时这套按 32 位偏移改字节的逻辑就不再成立 —— 宁可在这里拦住，
   * 也不要改出一个坏包。
   */
  if (entryCount === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    throw new Error('zip 使用了 Zip64 扩展，本脚本不支持（请检查产物大小是否异常）')
  }
  for (let i = Math.max(0, eocd - 128); i < eocd - 3; i++) {
    const sig = buf.readUInt32LE(i)
    if (sig === SIG_EOCD64 || sig === SIG_EOCD64_LOC) {
      throw new Error('zip 含 Zip64 记录，本脚本不支持')
    }
  }

  if (cdOffset + cdSize !== eocd) {
    throw new Error(
      `中央目录与 EOCD 之间有多余字节（cdOffset+cdSize=${cdOffset + cdSize}，EOCD=${eocd}），拒绝改`
    )
  }

  const entries = []
  let p = cdOffset
  for (let i = 0; i < entryCount; i++) {
    if (p + CD_FIXED > eocd || buf.readUInt32LE(p) !== SIG_CD) {
      throw new Error(`中央目录第 ${i + 1} 条记录损坏（偏移 ${p}）`)
    }
    const nameLen = buf.readUInt16LE(p + 28)
    const extraLen = buf.readUInt16LE(p + 30)
    const commentLength = buf.readUInt16LE(p + 32)
    const localOffset = buf.readUInt32LE(p + 42)

    /*
     * 条目名在 local header 与 central directory 里各存一份。
     * 两份必须逐字节一致，否则解压工具的行为不可预测
     * （有的看 local、有的看 CD）。这里先验一遍，改完还要再验。
     */
    if (buf.readUInt32LE(localOffset) !== SIG_LOCAL) {
      throw new Error(`条目「${buf.toString('utf8', p + 46, p + 46 + nameLen)}」的 local header 偏移无效`)
    }
    const localNameLen = buf.readUInt16LE(localOffset + 26)
    const localExtraLen = buf.readUInt16LE(localOffset + 28)
    if (localNameLen !== nameLen) {
      throw new Error('条目名在 local header 与中央目录里的长度不一致，拒绝改')
    }
    // 注意用 equals 而不是 compare：compare 的第三个参数是 targetStart，
    // 传 Buffer 会直接抛 ERR_INVALID_ARG_TYPE
    const cdName = buf.subarray(p + CD_FIXED, p + CD_FIXED + nameLen)
    const localName = buf.subarray(localOffset + LOCAL_FIXED, localOffset + LOCAL_FIXED + nameLen)
    if (!cdName.equals(localName)) {
      throw new Error('条目名在 local header 与中央目录里的内容不一致，拒绝改')
    }

    entries.push({
      cdOffset: p,
      localOffset,
      nameLen,
      localExtraLen,
      name: buf.subarray(p + 46, p + 46 + nameLen) // Buffer，不解码
    })

    p += CD_FIXED + nameLen + extraLen + commentLength
  }

  if (p !== eocd) throw new Error('中央目录长度与条目数对不上，拒绝改')

  return { eocd, entryCount, cdSize, cdOffset, entries, commentLen }
}

/** 条目名 → 「相对路径 => 类型:大小」，用于改名前后的等价性比对 */
function fingerprint(buf, zip) {
  const map = new Map()
  for (const entry of zip.entries) {
    const name = entry.name.toString('utf8')
    const isDir = name.endsWith('/')
    // 大小取中央目录里的「未压缩大小」字段（CD 记录里偏移 +24）
    const uncompressed = buf.readUInt32LE(entry.cdOffset + 24)
    map.set(name, `${isDir ? 'D' : 'F'}:${uncompressed}`)
  }
  return map
}

/**
 * 给一个 zip 套上顶层文件夹，返回是否真的改了。
 *
 * 顶层文件夹的名字 = 产物文件名去掉扩展名，例如
 * `hangkeIDE-0.2.1-win7-win10-x64.zip` → `hangkeIDE-0.2.1-win7-win10-x64/`。
 * 用产物名而不是写死 productName：这样 x64 与 ia32 两个包解压出来
 * 是两个不同名字的文件夹，放在同一个目录里不会互相覆盖。
 */
function wrapZip(zipPath) {
  const fileName = path.basename(zipPath)
  const folder = path.basename(zipPath, path.extname(zipPath))
  const prefix = Buffer.from(`${folder}/`, 'ascii')

  const before = fs.readFileSync(zipPath)
  const zip = parseZip(before)

  if (zip.entries.length === 0) throw new Error(`${fileName} 里没有任何条目，打包可能没完成`)

  // 顶层目录集合：名字里第一段（不解码，按 '/' 的字节切）
  const SLASH = 0x2f
  const tops = new Set()
  for (const entry of zip.entries) {
    const idx = entry.name.indexOf(SLASH)
    tops.add((idx < 0 ? entry.name : entry.name.subarray(0, idx)).toString('utf8'))
  }

  // 幂等：顶层已经只有这一个目录，说明套过了
  if (tops.size === 1 && tops.has(folder)) {
    console.log(`[zip-wrap] ${fileName} 已有一层文件夹，跳过`)
    return false
  }

  // 顶层有个同名目录、却还有散落文件：套下去会变成 folder/folder/…
  // 与其猜，不如报错让人看一眼
  for (const entry of zip.entries) {
    const name = entry.name.toString('utf8')
    if (name !== folder && name.startsWith(`${folder}/`)) {
      throw new Error(
        `${fileName} 里已经有 ${folder}/ 这个目录，同时又有多余的顶层条目，` +
          '无法安全地套文件夹（套下去会出现两层同名目录）'
      )
    }
  }

  /*
   * 开始拼新文件。
   *
   * 布局：local header + 数据（按原顺序）→ central directory → EOCD。
   * 因为名字变长，local header 变大，后面所有数据与 CD 的偏移都要平移。
   *
   * ⚠️ 条目名在 zip 里存**两份**（local header 一份、中央目录一份），
   * 所以总增长量是 `前缀长度 × 条目数 × 2`。只按一份算的话输出缓冲区会小一截，
   * 表现为写 EOCD 时 offset 越界 —— 这个错犯过一次。
   */
  const grow = prefix.length * zip.entries.length * 2
  const out = Buffer.allocUnsafe(before.length + grow)

  // 按 localOffset 排序后逐条搬运，保持数据区原样
  const ordered = [...zip.entries].sort((a, b) => a.localOffset - b.localOffset)
  let read = 0
  let write = 0
  /*
   * 旧 localOffset → 新 localOffset。
   *
   * ⚠️ 必须是**累计**平移量，不是「这一条自己长出来的量」：
   * 名字变长会让本条之后的所有数据一起后移，第 N 条的平移量等于
   * 前 N 条各自增长量之和。只加自己那一份的话，中央目录里的偏移会指向
   * 错误的位置 —— 解压时报「local header 偏移无效」，而文件看着是完整的。
   */
  const newOffsetByOld = new Map()
  for (const entry of ordered) {
    if (entry.localOffset !== read) {
      throw new Error('数据区有间隙或重叠，拒绝改（本脚本只处理连续布局）')
    }
    const headerEnd = entry.localOffset + LOCAL_FIXED + entry.nameLen + entry.localExtraLen
    newOffsetByOld.set(entry.localOffset, write)

    // local header 固定部分
    before.copy(out, write, entry.localOffset, entry.localOffset + LOCAL_FIXED)
    // 名字前插入前缀，名字长度字段 +prefix.length
    out.writeUInt16LE(entry.nameLen + prefix.length, write + 26)
    prefix.copy(out, write + LOCAL_FIXED)
    before.copy(out, write + LOCAL_FIXED + prefix.length, entry.localOffset + LOCAL_FIXED, headerEnd)
    write += LOCAL_FIXED + prefix.length + (headerEnd - entry.localOffset - LOCAL_FIXED)

    // 数据本体（含 local extra 之后的压缩数据）
    const dataEnd = headerEnd + compSizeOf(before, entry)
    before.copy(out, write, headerEnd, dataEnd)
    write += dataEnd - headerEnd

    read = dataEnd
  }

  // central directory
  const cdStartOut = write
  for (const entry of zip.entries) {
    before.copy(out, write, entry.cdOffset, entry.cdOffset + CD_FIXED)
    out.writeUInt16LE(entry.nameLen + prefix.length, write + 28)
    // local header 偏移换成搬完之后的新位置
    const oldLocal = before.readUInt32LE(entry.cdOffset + 42)
    const newLocal = newOffsetByOld.get(oldLocal)
    if (newLocal === undefined) throw new Error('中央目录引用了不存在的数据偏移，拒绝改')
    out.writeUInt32LE(newLocal, write + 42)
    prefix.copy(out, write + CD_FIXED)
    const nameAt = entry.cdOffset + CD_FIXED
    // 名字 + extra + comment 原样搬（extra / comment 我们没动，长度字段也不变）
    const tailLen =
      entry.nameLen +
      before.readUInt16LE(entry.cdOffset + 30) +
      before.readUInt16LE(entry.cdOffset + 32)
    before.copy(out, write + CD_FIXED + prefix.length, nameAt, nameAt + tailLen)
    write += CD_FIXED + prefix.length + tailLen
  }
  const cdSizeOut = write - cdStartOut

  // EOCD（含归档注释 —— 注释跟在 EOCD 固定部分后面，必须一起搬，
  // 否则注释会被截掉、且长度对不上而报错）
  before.copy(out, write, zip.eocd, zip.eocd + EOCD_FIXED + zip.commentLen)
  out.writeUInt32LE(cdSizeOut, write + 12)
  out.writeUInt32LE(cdStartOut, write + 16)
  write += EOCD_FIXED + zip.commentLen

  if (write !== out.length) {
    throw new Error(`拼装结果长度对不上（算出 ${out.length}，实际写 ${write}），拒绝落盘`)
  }

  // 校验：条目数、类型、大小三者逐一比对。任何一条对不上就让构建失败 ——
  // 「包坏了」的代价是学生拿到一个解压不了的 zip，而构建却是绿的
  const after = parseZip(out)
  const a = fingerprint(before, zip)
  const b = fingerprint(out, after)
  if (a.size !== b.size) throw new Error(`改名后条目数变了：${a.size} → ${b.size}`)
  for (const [key, value] of a) {
    const moved = `${folder}/${key}`
    if (b.get(moved) !== value) {
      throw new Error(`改名后内容对不上：${moved} 期望 ${value}，实际 ${b.get(moved)}`)
    }
  }

  fs.writeFileSync(zipPath, out)
  console.log(
    `[zip-wrap] ${fileName}：${zip.entries.length} 个条目 → ${folder}/（${tops.size} 个顶层项），` +
      `文件 ${(before.length / 1024 / 1024).toFixed(1)}MB → ${(out.length / 1024 / 1024).toFixed(1)}MB`
  )
  return true
}

/** 从 local header 读压缩后大小；为 0 且带 data descriptor 标志时回退到 CD */
function compSizeOf(buf, entry) {
  const local = buf.readUInt32LE(entry.localOffset + 18)
  if (local !== 0) return local
  return buf.readUInt32LE(entry.cdOffset + 20)
}

/**
 * electron-builder 的钩子入口（配置见 electron-builder.yml）。
 *
 * ## 只能在打包流程里跑
 *
 * 这个函数**必须**由 electron-builder 调用并传入 `artifactPaths`。
 * 没有产物列表就直接报错，不提供「扫 release/ 目录」这类本地入口 ——
 * 本项目约定只通过 GitHub Actions 打包（见 `scripts/guard-ci.mjs`），
 * 而这条约定是有代价换来的：
 *
 *   这个功能的第一版曾提供本地入口，我就是拿**本地**跑出来的绿灯
 *   当成验证通过，结果 CI 上连挂两次 ——
 *   一次是外部 7za 的版本/代码页差异，一次是 ESM 动态 import 的
 *   Windows 路径。两次本地都测不出来，因为**打包这件事本身
 *   在开发机（Linux）上跟 runner（Windows）不是一回事**。
 *
 * 所以现在把入口收窄成一个：electron-builder 的钩子。
 * 想验这套逻辑，跑 `npm run check:zipwrap` —— 它用自造的 zip 做断言，
 * 不碰打包、不需要产物、两边平台结果一致。
 *
 * ## 为什么返回空数组
 *
 * 这个钩子可以把「新增的产物」交给发布流程。这里只是原地改了已有的 zip，
 * 没有新增任何文件；返回 zip 列表的话 electron-builder 会以为它们是新产物，
 * 走一遍发布调度 —— 没意义。
 */
export async function afterAllArtifactBuild(buildResult) {
  const paths = buildResult && buildResult.artifactPaths
  if (!Array.isArray(paths) || paths.length === 0) {
    throw new Error(
      'zip-wrap 只能由 electron-builder 的 afterAllArtifactBuild 钩子调用（需要 artifactPaths）。\n' +
        '本项目不在本地打包，验证请用：npm run check:zipwrap'
    )
  }
  const zips = paths.filter(
    (p) => typeof p === 'string' && p.toLowerCase().endsWith('.zip') && fs.existsSync(p)
  )
  if (zips.length === 0) {
    console.log('[zip-wrap] 本次构建没有 zip 产物，跳过')
    return []
  }
  for (const zip of zips) wrapZip(zip)
  return []
}

export default afterAllArtifactBuild
