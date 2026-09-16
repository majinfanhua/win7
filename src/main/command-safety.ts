import fs from 'node:fs'
import path from 'node:path'

/**
 * 命令执行的安全基础件。
 *
 * 三件事，都是**纯逻辑**，不依赖任何原生模块或 Win10+ 的 API：
 *
 *   1. buildCommandLine —— 按 Windows 的真实规则给参数加引号
 *   2. resolveProgramInPath —— 把裸程序名解析成绝对路径，且**绝不回落到工作区**
 *   3. checkWorkspaceSafety —— 拒绝会把凭据目录暴露给 AI 的工作区
 *
 * 为什么不直接用 Node 的 spawn 让它自己找：Node 在 Windows 上拼接命令行
 * 走的是另一套规则，与 cmd.exe / CreateProcess 的解析不一致。对**我们自己
 * 生成的**路径（无空格无特殊字符）无所谓，但一旦要传用户可控的字符串
 * （比如 workdir），就会出现「在终端能跑、在这里跑不了」甚至参数错位。
 */

/* ------------------------------------------------------------------ *
 * 1. 命令行拼装（CommandLineToArgvW 规则）
 * ------------------------------------------------------------------ */

/**
 * 按 Windows 的 CommandLineToArgvW 规则给单个参数加引号。
 *
 * 规则（这几条是 Windows 独有的，也是最容易写错的）：
 *   - 只有含空格/制表符或为空的参数才需要引号
 *   - **引号前的连续反斜杠要翻倍**，这个反斜杠本身是转义字符
 *   - **参数末尾的连续反斜杠，在加收尾引号时要翻倍** ——
 *     否则 `C:\Program Files\` 末尾那个 `\` 会把收尾引号转义掉，
 *     引号配不上，后面的参数全部错位
 *
 * 最后那条是经典坑：`"C:\Program Files\"` 传给 CreateProcess 会被解析成
 * 一个未闭合的字符串，把后续参数全吃进去。所以这里逐字实现规则，
 * 而不是用简单的 replace 拼字符串。
 */
export function quoteArg(arg: string): string {
  // 含引号的参数**必须**整体加引号：否则那个引号会与命令行的其它引号
  // 配对，把后面的参数一起吞进去。
  const needsQuote = arg === '' || /[ \t"]/.test(arg)
  let out = needsQuote ? '"' : ''
  let backslashes = 0

  for (const ch of arg) {
    if (ch === '\\') {
      backslashes++
      out += ch
      continue
    }
    if (ch === '"') {
      // 把 " 之前的反斜杠翻倍，再补一个，得到转义的 \"
      out += '\\'.repeat(backslashes + 1)
      out += '"'
      backslashes = 0
      continue
    }
    backslashes = 0
    out += ch
  }

  if (needsQuote) {
    // 收尾引号前若有反斜杠，必须翻倍，否则会把引号转义掉
    out += '\\'.repeat(backslashes)
    out += '"'
  }
  return out
}

/** 把程序名与参数拼成一条完整的命令行字符串 */
export function buildCommandLine(program: string, args: string[]): string {
  return [program, ...args].map(quoteArg).join(' ')
}

/* ------------------------------------------------------------------ *
 * 2. PATH 解析（防二进制投毒）
 * ------------------------------------------------------------------ */

/**
 * 只在 PATH 里的**绝对目录**中查找程序，绝不搜索当前目录/工作目录。
 *
 * ## 为什么这条很重要
 *
 * Windows 的 CreateProcess 在 `lpApplicationName` 是「部分名」时，
 * 会拿**当前盘符 + 当前目录**去补全，而**不查 PATH**。而我们的子进程
 * cwd 恰好就是工作区 —— 那是模型能写文件的地方。
 *
 * 后果：模型只要在工作区里写一个 `taskkill.bat` 或 `cmd.exe`，
 * 我们执行裸名 `taskkill` 时就会命中它。轻则命令失败，
 * 重则**以我们的权限执行模型投放的任意程序**。
 *
 * 所以：
 *   - 裸名一律预解析成绝对路径
 *   - PATH 里的相对项（含 `.`、空串）直接跳过 —— 即使用户的 PATH
 *     里带了 `.`，也不会落到工作区
 *   - 绝对路径入参原样返回（调用方明确指定，不猜）
 */
export function resolveProgramInPath(
  program: string,
  opts?: {
    pathEnv?: string
    pathext?: string
    isFile?: (candidate: string) => boolean
    /**
     * 返回该候选在磁盘上的真实拼写。
     *
     * Windows 的文件系统不区分大小写，但**路径字符串**区分 ——
     * 把 `cmd.EXE` 当成路径传下去，某些程序（尤其 .NET 与打包工具）
     * 会当成另一个文件。所以命中后要拿回磁盘上的真实拼写。
     * 不提供时退化为原样返回。
     */
    realPath?: (candidate: string) => string | null
    platform?: NodeJS.Platform
  }
): string | null {
  const platform = opts?.platform ?? process.platform
  const isFile = opts?.isFile ?? defaultIsFile
  const realPath = opts?.realPath ?? defaultRealPath

  // 已经是绝对路径：调用方说了算，不猜
  if (isAbsoluteFor(program, platform)) return program

  // 相对名里带路径分隔符（`.\x.exe`、`sub\x.exe`）——拒绝。
  // 这种写法按 Windows 语义就会落到 cwd（工作区），正是要防的。
  if (/[\\/]/.test(program)) return null

  const pathEnv = opts?.pathEnv ?? process.env['PATH'] ?? ''
  const pathExt = opts?.pathext ?? process.env['PATHEXT'] ?? '.COM;.EXE;.BAT;.CMD'
  const sep = platform === 'win32' ? ';' : ':'

  // 候选扩展名：先原样（程序名可能已带 .exe），再逐个 PATHEXT
  const exts = ['', ...pathExt.split(sep).map((e) => e.trim()).filter(Boolean)]

  for (const dir of pathEnv.split(sep)) {
    const trimmed = dir.trim().replace(/^"|"$/g, '')
    // 只认绝对目录 —— 这一句就是防投毒的关键
    if (!isAbsoluteFor(trimmed, platform)) continue
    for (const ext of exts) {
      const candidate = joinFor(trimmed, program + ext)
      if (!isFile(candidate)) continue
      // 命中后取磁盘上的真实拼写；取不到就用候选本身
      return realPath(candidate) ?? candidate
    }
  }
  return null
}

/**
 * 按**目标平台**的规则拼接路径。
 *
 * 不能用 path.join：它按宿主平台工作。我们大量逻辑是「在 Linux 上开发、
 * 在 Win7 上运行」，用 path.join 拼 Windows 路径会得到 `C:\Users\x/.ssh`
 * 这种混合分隔符，后续的分段比较就对不上了。
 */
function joinFor(base: string, ...parts: string[]): string {
  const sep = /[\\/]/.test(base) || /^[a-zA-Z]:/.test(base) ? '\\' : path.sep
  let out = base.replace(/[\\/]+$/, '')
  for (const part of parts) out += sep + part.replace(/^[\\/]+|[\\/]+$/g, '')
  return out
}

function defaultIsFile(candidate: string): boolean {
  try {
    // 大小写不敏感地与 PATHEXT 组合，Windows 上 fs 本身就不区分大小写
    return fs.statSync(candidate).isFile()
  } catch {
    return false
  }
}

/**
 * 取磁盘上的真实拼写。
 *
 * Windows 上 fs.realpathSync.native 会把各段还原成实际大小写，
 * 正好是我们要的效果；拿不到就返回 null，由调用方退回候选字符串。
 */
function defaultRealPath(candidate: string): string | null {
  try {
    return fs.realpathSync.native(candidate)
  } catch {
    return null
  }
}

function isAbsoluteFor(p: string, platform: NodeJS.Platform): boolean {
  if (!p) return false
  if (platform === 'win32') {
    // C:\... 或 \\server\share\... 或 \\?\C:\...
    return /^[a-zA-Z]:[\\/]/.test(p) || /^\\\\/.test(p)
  }
  return p.startsWith('/')
}

/**
 * 解析系统程序。
 *
 * ## 为什么不直接走 PATH
 *
 * 光「剔除 PATH 里的相对项」还不够。真正的攻击面是：
 * **工作区本身可能就是一个绝对的 PATH 项，而且排在 System32 前面。**
 * 此时 Windows 会老老实实按顺序搜到工作区里的 `taskkill.bat` ——
 * 这不是 PATH 被改坏，而是 PATH 正常工作，只是顺序对攻击者有利。
 * （这个洞是第一版写完用攻击模拟测出来的，见 check-command-safety.mjs
 * 里「投毒」那组回归测试。）
 *
 * 所以系统程序**先查系统目录** —— 那是模型写不进去、顺序也不可能被顶掉的
 * 信任锚点。只有系统目录里确实没有，才回退去查 PATH（仍然只认绝对项）。
 *
 * 返回 null 表示**宁可不执行**，也不退化成一个可能被劫持的裸名。
 */
export function resolveSystemProgram(program: string): string | null {
  /*
   * 调用方已给绝对路径：原样返回，不猜。
   *
   * ⚠️ 判断时两种平台的规则都要试。开发机是 Linux，而调用方传进来的
   * 可能是 Windows 路径字面量（`C:\...`）；只按宿主平台判断会把它当成
   * 「相对名」，接着又在两个查找分支里都落空，明明是绝对路径却解析失败。
   */
  if (isAbsoluteFor(program, 'win32') || isAbsoluteFor(program, process.platform)) {
    return program
  }

  /*
   * 第一优先：系统目录。这是不受工作区影响的信任锚点。
   * System32 排最前 —— 系统程序真正住的地方就是它。
   */
  if (process.platform === 'win32') {
    const root = process.env['SystemRoot'] || process.env['windir'] || 'C:\\Windows'
    const ext = process.env['PATHEXT'] || '.COM;.EXE;.BAT;.CMD'
    const dirs = [
      joinFor(root, 'System32'),
      root,
      // 32 位进程在 64 位系统上 System32 会被重定向，补一条
      joinFor(root, 'SysWOW64')
    ]
    for (const dir of dirs) {
      for (const e of ext.split(';').map((x) => x.trim()).filter(Boolean)) {
        const candidate = joinFor(dir, program + e)
        if (defaultIsFile(candidate)) return defaultRealPath(candidate) ?? candidate
      }
    }
  }

  // 第二优先：PATH（只认绝对项，绝不碰 cwd）
  return resolveProgramInPath(program)
}

/* ------------------------------------------------------------------ *
 * 3. 工作区安全校验
 * ------------------------------------------------------------------ */

/**
 * 不该让 AI 把工作区开在里面的目录。
 *
 * 注意这不是「AI 不能读这些目录」——而是**工作区根**不能是它们。
 * 工作区根一旦取成 home 或 /，AI 的读写围栏就等于没有，
 * 一次「帮我整理一下配置」就可能把私钥或凭据写坏。
 */
const SENSITIVE_DIR_NAMES = [
  ['.ssh'],
  ['.aws'],
  ['.gnupg'],
  ['.config', 'gh'],
  ['.config', 'gcloud'],
  ['.kube'],
  ['.docker']
] as const

/**
 * 归一化：去掉 Windows 的长路径前缀、统一分隔符、去掉末尾分隔符，
 * Windows 下统一小写。
 *
 * 刻意不用 path.normalize：它按宿主平台工作，在 Linux 上跑会把
 * `C:\Users\me` 原样留下、把 `C:\Users\me\..\me` 处理错。
 * 这里的规则必须只由 **platform 参数**决定，这样同一套判定在
 * 开发机（Linux）与目标机（Win7）上结果一致，也能被单测覆盖。
 */
function normalizeForCompare(target: string, platform: NodeJS.Platform): string {
  let text = target
  // \\?\UNC\server\share → \\server\share；\\?\C:\x → C:\x
  if (/^\\\\\?\\UNC\\/i.test(text)) text = `\\\\${text.slice(8)}`
  else if (/^\\\\\?\\/.test(text)) text = text.slice(4)

  if (platform === 'win32') {
    // 统一成反斜杠，再压掉重复分隔符
    text = text.replace(/\//g, '\\').replace(/\\{2,}/g, (m, offset) => (offset === 0 ? m : '\\'))
    text = text.toLowerCase()
  } else {
    text = text.replace(/\/{2,}/g, '/')
  }

  // 去掉末尾分隔符（但保留根：`C:\` 与 `/`）
  if (!/^[a-zA-Z]:[\\/]?$/.test(text) && text !== '/' && text !== '\\') {
    text = text.replace(/[\\/]+$/, '')
  }
  return text
}

/**
 * `ancestor` 是否包含或等于 `descendant`。
 * 按路径分段比较，避免 `/a/bc` 被误判为在 `/a/b` 之内。
 */
export function pathEncloses(ancestor: string, descendant: string, platform?: NodeJS.Platform): boolean {
  const p = platform ?? process.platform
  const a = normalizeForCompare(ancestor, p)
  const d = normalizeForCompare(descendant, p)
  if (a === d) return true
  const sep = p === 'win32' ? '\\' : '/'
  return d.startsWith(a.endsWith(sep) ? a : a + sep)
}

export interface WorkspaceSafetyResult {
  ok: boolean
  /** 不安全时给出可直接显示给用户的原因 */
  reason?: string
}

/**
 * 校验工作区是否可以安全地交给 AI 使用（fail-closed）。
 *
 * 拒绝两种情况：
 *   1. **包含或等于**敏感目录 —— 比如工作区直接取 `C:\Users\me` 或磁盘根。
 *      AI 的读写围栏是「工作区内」，这种工作区等于把私钥目录一起放开了。
 *   2. **位于**凭据目录内部 —— 比如直接把 `~/.ssh` 当工作区打开。
 *
 * 不检查目录是否存在：不存在也照样拒绝（它随时可能被创建）。
 */
export function checkWorkspaceSafety(
  workspace: string,
  opts?: { home?: string; platform?: NodeJS.Platform }
): WorkspaceSafetyResult {
  const platform = opts?.platform ?? process.platform
  const home = opts?.home ?? (process.env['USERPROFILE'] || process.env['HOME'] || '')
  if (!workspace || !home) return { ok: true }

  for (const parts of SENSITIVE_DIR_NAMES) {
    const sensitive = joinFor(home, ...parts)

    // 情况 1：工作区把敏感目录包进去了（含相等）
    if (pathEncloses(workspace, sensitive, platform)) {
      return {
        ok: false,
        reason:
          `工作区「${workspace}」包含或等于敏感目录「${sensitive}」。` +
          '在这个工作区里，AI 的读写范围会覆盖到凭据目录，风险太大。' +
          '请选择一个具体的项目文件夹作为工作区。'
      }
    }

    // 情况 2：工作区就在敏感目录里面
    if (pathEncloses(sensitive, workspace, platform)) {
      return {
        ok: false,
        reason:
          `工作区「${workspace}」位于敏感目录「${sensitive}」内部。` +
          '这里放的是密钥与凭据，不适合作为 AI 的工作区。' +
          '请把项目放到别的目录再打开。'
      }
    }
  }

  return { ok: true }
}
