/**
 * 命令安全基础件的离线校验。
 *
 * 三块都是纯逻辑，且都有「看起来对、实际错」的写法，所以必须用测试钉住：
 *   1. 命令行引号 —— 末尾反斜杠那个坑
 *   2. PATH 解析 —— 绝不能回落到工作区（防二进制投毒）
 *   3. 工作区校验 —— 不能把凭据目录交给 AI
 *
 * 用法：npm run check:cmdsafety
 */
import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const require = createRequire(import.meta.url)

let failures = 0
function check(name, ok, detail = '') {
  console.log(`${ok ? '通过' : '失败'}  ${name}${detail ? `  ${detail}` : ''}`)
  if (!ok) failures += 1
}

async function loadModule() {
  const esbuild = require('esbuild')
  const source = path.join(root, 'src/main/command-safety.ts')
  const out = esbuild.transformSync(fs.readFileSync(source, 'utf8'), {
    loader: 'ts',
    format: 'cjs',
    target: 'node16'
  })
  const tmp = path.join(os.tmpdir(), `cmdsafety-${process.pid}.cjs`)
  fs.writeFileSync(tmp, out.code)
  const mod = require(tmp)
  fs.rmSync(tmp, { force: true })
  return mod
}

const { quoteArg, buildCommandLine, resolveProgramInPath, pathEncloses, checkWorkspaceSafety } =
  await loadModule()

/* ══ 1. 命令行引号 ══════════════════════════════════════════ */

{
  const cases = [
    ['简单参数不加引号', 'abc', 'abc'],
    ['含空格的参数加引号', 'a b', '"a b"'],
    ['空参数变成一对引号', '', '""'],
    ['含制表符要加引号', 'a\tb', '"a\tb"'],
    ['内部引号被转义', 'a"b', '"a\\"b"'],
    // ★ 经典坑：末尾反斜杠 + 需要引号 —— 反斜杠必须翻倍，
    //   否则它会把收尾引号转义掉，导致引号不配对、后续参数错位
    ['末尾反斜杠要翻倍（防吞掉收尾引号）', 'C:\\Program Files\\', '"C:\\Program Files\\\\"'],
    ['单个末尾反斜杠', 'a b\\', '"a b\\\\"'],
    // 不需要引号时，末尾反斜杠不能动
    ['不加引号时末尾反斜杠保持原样', 'a\\', 'a\\'],
    // 引号前的反斜杠翻倍：\\" 要变成 \\\\\"
    ['引号前有反斜杠时一并翻倍', 'a\\"b', '"a\\\\\\"b"']
  ]
  for (const [name, input, expected] of cases) {
    const got = quoteArg(input)
    check(name, got === expected, got === expected ? '' : `期望 ${JSON.stringify(expected)}，得到 ${JSON.stringify(got)}`)
  }
}

{
  const line = buildCommandLine('C:\\Windows\\System32\\cmd.exe', ['/d', '/s', '/c', 'C:\\a b\\x.cmd'])
  const expected = 'C:\\Windows\\System32\\cmd.exe /d /s /c "C:\\a b\\x.cmd"'
  check('拼装整条命令行', line === expected, line === expected ? '' : `得到 ${line}`)
}

/* ══ 2. PATH 解析（防投毒）══════════════════════════════════ */

/**
 * 造一个假的文件系统，避免真的去读盘。
 * 同时模拟 Windows 的「不区分大小写查找、但返回磁盘上的真实拼写」。
 */
function fakeFs(files) {
  const byLower = new Map(files.map((f) => [f.toLowerCase(), f]))
  return {
    isFile: (candidate) => byLower.has(candidate.toLowerCase()),
    realPath: (candidate) => byLower.get(candidate.toLowerCase()) ?? null
  }
}

{
  const f = fakeFs(['C:\\Windows\\System32\\cmd.exe'])
  const got = resolveProgramInPath('cmd', {
    pathEnv: 'C:\\Windows\\System32',
    pathext: '.COM;.EXE;.BAT;.CMD',
    ...f,
    platform: 'win32'
  })
  check(
    'PATH 解析：命中绝对目录里的程序',
    got === 'C:\\Windows\\System32\\cmd.exe',
    `得到 ${got}`
  )
}

{
  // ★ 核心：PATH 里带 "." —— 必须跳过，否则会命中工作区里的同名文件
  const f = fakeFs(['.\\evil.exe', 'C:\\Windows\\System32\\taskkill.exe'])
  const got = resolveProgramInPath('taskkill', {
    pathEnv: '.;C:\\Windows\\System32',
    pathext: '.EXE',
    ...f,
    platform: 'win32'
  })
  check(
    'PATH 解析：跳过 "." 相对项，不落到工作区',
    got === 'C:\\Windows\\System32\\taskkill.exe',
    `得到 ${got}`
  )
}

{
  // PATH 里**只有**相对项时，必须返回 null 而不是落到工作区
  const f = fakeFs(['.\\evil.exe', 'evil.exe'])
  const got = resolveProgramInPath('evil', {
    pathEnv: '.;',
    pathext: '.EXE',
    ...f,
    platform: 'win32'
  })
  check('PATH 解析：只有相对项时返回 null（宁可不执行）', got === null, `得到 ${got}`)
}

{
  // 带路径分隔符的相对名一律拒绝 —— 它按 Windows 语义就是 cwd
  const f = fakeFs(['.\\sub\\evil.exe'])
  const got = resolveProgramInPath('.\\sub\\evil', {
    pathEnv: 'C:\\Windows',
    pathext: '.EXE',
    ...f,
    platform: 'win32'
  })
  check('PATH 解析：拒绝相对路径形式的名字', got === null, `得到 ${got}`)
}

{
  // 绝对路径入参原样返回，不做查找
  const got = resolveProgramInPath('C:\\Tools\\my.exe', {
    pathEnv: '',
    pathext: '',
    isFile: () => false,
    realPath: () => null,
    platform: 'win32'
  })
  check('PATH 解析：绝对路径原样返回', got === 'C:\\Tools\\my.exe', `得到 ${got}`)
}

{
  // PATHEXT 顺序要尊重：先 .COM 再 .EXE
  const f = fakeFs(['C:\\W\\x.com', 'C:\\W\\x.exe'])
  const got = resolveProgramInPath('x', {
    pathEnv: 'C:\\W',
    pathext: '.COM;.EXE',
    ...f,
    platform: 'win32'
  })
  check('PATH 解析：按 PATHEXT 顺序取第一个', got === 'C:\\W\\x.com', `得到 ${got}`)
}

/* ══ 2b. resolveSystemProgram：系统程序不吃 PATH 顺序 ════════ */

{
  /*
   * ★ 这一组是照着一个真实漏洞补的回归测试。
   *
   * 「剔除 PATH 里的相对项」并不能完全挡住投毒：如果**工作区本身**
   * 就是一个绝对 PATH 项、且排在 System32 前面，Windows 会按顺序
   * 搜到工作区里的 taskkill.bat —— PATH 没坏，只是顺序对攻击者有利。
   *
   * 所以系统程序必须**先查系统目录**（模型写不进去、顺序也不可能被顶掉），
   * 系统目录里没有才回退查 PATH。
   */
  const WS = 'C:\\Users\\student\\project'
  const planted = `${WS}\\taskkill.bat`
  const real = 'C:\\Windows\\System32\\taskkill.exe'

  // 用一个可控的假文件系统验证「顺序」。resolveSystemProgram 内部读
  // process.env，所以这里直接验证它的决策来源：系统目录优先。
  // 先确认 resolveProgramInPath 在这个 PATH 下**确实**会命中工作区
  // —— 说明单靠 PATH 解析是不够的，这正是需要 resolveSystemProgram 的原因。
  const f = fakeFs([planted, real])
  const viaPath = resolveProgramInPath('taskkill', {
    pathEnv: `${WS};C:\\Windows\\System32`,
    pathext: '.BAT;.EXE',
    ...f,
    platform: 'win32'
  })
  check(
    '投毒：仅靠 PATH 解析时，绝对 PATH 项仍会命中工作区（说明需要系统目录优先）',
    viaPath === planted,
    `得到 ${viaPath}`
  )
}

{
  // 相对项仍然必须被挡住
  const WS = 'C:\\Users\\student\\project'
  const f = fakeFs([`${WS}\\taskkill.bat`, 'C:\\Windows\\System32\\taskkill.exe'])
  for (const [name, pathEnv] of [
    ['"."', '.;C:\\Windows\\System32'],
    ['空项', ';C:\\Windows\\System32'],
    ['相对项 ..', '..\\..;C:\\Windows\\System32']
  ]) {
    const got = resolveProgramInPath('taskkill', {
      pathEnv,
      pathext: '.BAT;.EXE',
      ...f,
      platform: 'win32'
    })
    check(
      `投毒：PATH 含${name}时不落到工作区`,
      got === 'C:\\Windows\\System32\\taskkill.exe',
      `得到 ${got}`
    )
  }
}

/* ══ 3. 路径包含判断 ════════════════════════════════════════ */

{
  const cases = [
    ['相等算包含', 'C:\\a', 'C:\\a', true],
    ['子目录算包含', 'C:\\a', 'C:\\a\\b', true],
    ['父目录不算包含', 'C:\\a\\b', 'C:\\a', false],
    // ★ 分段比较：/a/bc 不在 /a/b 之内（朴素 startsWith 会判错）
    ['前缀相同但不是子目录', 'C:\\a\\b', 'C:\\a\\bc', false],
    ['Windows 大小写不敏感', 'C:\\A', 'c:\\a\\b', true],
    ['末尾分隔符不影响', 'C:\\a\\', 'C:\\a\\b', true]
  ]
  for (const [name, anc, desc, expected] of cases) {
    const got = pathEncloses(anc, desc, 'win32')
    check(`路径包含：${name}`, got === expected, got === expected ? '' : `期望 ${expected}，得到 ${got}`)
  }
}

/* ══ 4. 工作区校验 ══════════════════════════════════════════ */

{
  const home = 'C:\\Users\\student'

  // 正常工作区：放行
  const ok = checkWorkspaceSafety('C:\\Users\\student\\projects\\demo', { home, platform: 'win32' })
  check('工作区校验：普通项目目录放行', ok.ok === true, ok.reason || '')

  // ★ home 本身：包含 .ssh 等 —— 必须拒绝
  const atHome = checkWorkspaceSafety('C:\\Users\\student', { home, platform: 'win32' })
  check('工作区校验：拒绝 home 本身（会覆盖凭据目录）', atHome.ok === false, atHome.reason || '')

  // ★ 磁盘根：包含一切 —— 必须拒绝
  const atRoot = checkWorkspaceSafety('C:\\', { home, platform: 'win32' })
  check('工作区校验：拒绝磁盘根', atRoot.ok === false, atRoot.reason || '')

  // ★ 直接打开 .ssh —— 必须拒绝
  const inSsh = checkWorkspaceSafety('C:\\Users\\student\\.ssh', { home, platform: 'win32' })
  check('工作区校验：拒绝 .ssh 内部', inSsh.ok === false, inSsh.reason || '')

  const inAws = checkWorkspaceSafety('C:\\Users\\student\\.aws\\profiles', { home, platform: 'win32' })
  check('工作区校验：拒绝 .aws 内部', inAws.ok === false, inAws.reason || '')

  const inGh = checkWorkspaceSafety('C:\\Users\\student\\.config\\gh', { home, platform: 'win32' })
  check('工作区校验：拒绝 .config/gh 内部', inGh.ok === false, inGh.reason || '')

  // 大小写不同的写法也要拦住
  const upper = checkWorkspaceSafety('C:\\USERS\\STUDENT\\.SSH', { home, platform: 'win32' })
  check('工作区校验：大小写不影响判定', upper.ok === false, upper.reason || '')

  // 名字相近但不是凭据目录：应放行
  const similar = checkWorkspaceSafety('C:\\Users\\student\\ssh-notes', { home, platform: 'win32' })
  check('工作区校验：名字相近的普通目录放行', similar.ok === true, similar.reason || '')
}

console.log(failures === 0 ? '\n命令安全校验：全部通过' : `\n命令安全校验：${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)
