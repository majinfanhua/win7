/**
 * editFile 的 oldString 查找回退级联。
 *
 * 为什么需要这个：模型复述文件内容时，空白常和磁盘上的不完全一样 ——
 * 文件是 CRLF 而它给 LF、行尾少了几个空格、整段缩进多了一级。
 * 主流编码代理都容忍这种「差一点」，不是直接失败
 * （Claude Code 有一串逐级放宽的 replacer；Codex CLI 的 apply_patch
 * 用 exact → rstrip → trim 三轮定位）。这里对 editFile 实现同样的思路。
 *
 * 各级按「从严到宽」顺序跑，第一个能匹配上的级别获胜，
 * 所以更严格的解释永远优先：
 *
 *   1. exact              —— 逐字节子串匹配（历史行为，不变）
 *   2. line-endings       —— 两侧都归一化 CRLF→LF 并忽略开头的 BOM。
 *                            替换文本按文件的换行风格重新渲染，CRLF 文件仍是 CRLF。
 *   3. trailing-whitespace—— 按整行窗口比较，忽略每行行尾空白
 *   4. indentation        —— 整行窗口，所有非空行统一偏移同一个前导空白前缀。
 *                            替换文本也施加同样的偏移，保证文件的真实缩进被保留
 *                            （刻意避免 apply_patch 那个「模糊匹配时相信模型的缩进」
 *                            的老坑）。
 *
 * 按行的两级（3、4）把 oldString 当作「整行块」；从行中间开始或结束的片段
 * 只由第 1、2 级匹配。单独的 \r（经典 Mac 换行）不做归一化。
 */

const UTF8_BOM = '\u{feff}'

export type EditMatchStrategy = 'exact' | 'line-endings' | 'trailing-whitespace' | 'indentation'

/** 一次替换：把 [start, end) 换成 text */
export interface EditReplacement {
  start: number
  end: number
  text: string
}

export interface EditMatchOutcome {
  strategy: EditMatchStrategy
  replacements: EditReplacement[]
}

/** 非重叠出现的全部位置，与 Rust 版 str::matches 的计数口径一致 */
function findExactRanges(haystack: string, needle: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = []
  if (!needle) return ranges
  let from = 0
  while (true) {
    const offset = haystack.indexOf(needle, from)
    if (offset === -1) break
    ranges.push([offset, offset + needle.length])
    from = offset + needle.length
  }
  return ranges
}

interface NormalizedView {
  text: string
  /** 归一化后每个字符在原串中的下标 */
  map: number[]
}

/**
 * 去掉开头的 BOM 并把 CRLF 压成 LF，同时保留回原串的字符级下标映射。
 *
 * 这里用「字符」而不是「字节」做单位（Rust 版是字节）：JS 字符串按 UTF-16
 * 码元索引，slice 也用同一单位，两边自洽就不会切坏代理对 ——
 * 前提是下面所有下标都走同一套单位，不能混用 Buffer。
 */
function normalizeWithMap(original: string): NormalizedView {
  const out: string[] = []
  const map: number[] = []
  let i = original.startsWith(UTF8_BOM) ? UTF8_BOM.length : 0
  while (i < original.length) {
    if (original[i] === '\r' && original[i + 1] === '\n') {
      i += 1
      continue
    }
    map.push(i)
    out.push(original[i])
    i += 1
  }
  return { text: out.join(''), map }
}

function stripBom(text: string): string {
  return text.startsWith(UTF8_BOM) ? text.slice(UTF8_BOM.length) : text
}

function normalizeLineEndings(text: string): string {
  return text.replace(/\r\n/g, '\n')
}

/** 文件的主换行风格是否为 CRLF */
function usesCrlfDominantly(text: string): boolean {
  const crlf = (text.match(/\r\n/g) || []).length
  if (crlf === 0) return false
  const loneLf = (text.match(/\n/g) || []).length - crlf
  return crlf >= loneLf
}

/** 把替换文本按文件的主换行风格重新渲染 */
function renderLineEndings(text: string, crlf: boolean): string {
  const normalized = normalizeLineEndings(text)
  return crlf ? normalized.replace(/\n/g, '\r\n') : normalized
}

function findLineEndingMatches(
  text: string,
  oldString: string,
  newString: string,
  crlf: boolean
): EditReplacement[] | null {
  const view = normalizeWithMap(text)
  const needle = normalizeLineEndings(stripBom(oldString))
  if (!needle) return null
  const ranges = findExactRanges(view.text, needle)
  if (ranges.length === 0) return null
  const rendered = renderLineEndings(newString, crlf)

  return ranges.map(([startIdx, endIdx]) => {
    // 归一化后的每个字符 1:1 对应原串的一个字符，
    // 所以结束边界就是最后一个匹配字符的下一位。
    // 区间内被跳掉的 \r 自然被覆盖。
    let start = view.map[startIdx]
    const end = view.map[endIdx - 1] + 1
    // 从 CRLF 的 \n 处开始的匹配，必须连带吃掉前面的 \r：
    // 替换文本是从头重渲染的（CRLF 文件里是 \r\n），
    // 留下那个孤立的 \r 会把文件搞成 \r\r\n。
    if (text[start] === '\n' && start > 0 && text[start - 1] === '\r') {
      start -= 1
    }
    return { start, end, text: rendered }
  })
}

interface LineSpan {
  /** 行内容起点；第一行跳过 BOM，保证替换不会把 BOM 弄丢 */
  contentStart: number
  /** 行内容终点，不含换行符 */
  contentEnd: number
  /** 含换行的行尾（即下一行起点） */
  lineEnd: number
}

function indexLineSpans(text: string): LineSpan[] {
  const bomLen = text.startsWith(UTF8_BOM) ? UTF8_BOM.length : 0
  const spans: LineSpan[] = []
  let start = 0
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '\n') continue
    const contentEnd = i > start && text[i - 1] === '\r' ? i - 1 : i
    spans.push({
      contentStart: start === 0 ? bomLen : start,
      contentEnd,
      lineEnd: i + 1
    })
    start = i + 1
  }
  if (start < text.length) {
    spans.push({
      contentStart: start === 0 ? bomLen : start,
      contentEnd: text.length,
      lineEnd: text.length
    })
  }
  return spans
}

function lineContent(text: string, span: LineSpan): string {
  return text.slice(span.contentStart, span.contentEnd)
}

interface PatternLines {
  lines: string[]
  endsWithNewline: boolean
}

/**
 * 把 oldString 拆成与换行风格无关的整行，供按行的那两级使用。
 * 没有可用行时返回 null。
 */
function splitPatternLines(oldString: string): PatternLines | null {
  const stripped = stripBom(oldString)
  if (!stripped) return null
  const endsWithNewline = stripped.endsWith('\n')
  const lines = stripped.split('\n').map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line))
  if (endsWithNewline) lines.pop()
  if (lines.length === 0) return null
  return { lines, endsWithNewline }
}

/**
 * 在文件上滑动整行窗口，收集每行都满足 lineMatches 的
 * 非重叠 (首行, 末行) 下标对。
 */
function findLineWindows(
  text: string,
  spans: LineSpan[],
  pattern: PatternLines,
  lineMatches: (fileLine: string, patternLine: string) => boolean
): Array<[number, number]> {
  const windowLen = pattern.lines.length
  const windows: Array<[number, number]> = []
  if (windowLen === 0 || spans.length < windowLen) return windows
  let i = 0
  while (i + windowLen <= spans.length) {
    let matched = true
    for (let j = 0; j < windowLen; j++) {
      if (!lineMatches(lineContent(text, spans[i + j]), pattern.lines[j])) {
        matched = false
        break
      }
    }
    if (matched) {
      windows.push([i, i + windowLen - 1])
      i += windowLen
    } else {
      i += 1
    }
  }
  return windows
}

function windowRange(
  spans: LineSpan[],
  [first, last]: [number, number],
  includeFinalEol: boolean
): [number, number] {
  return [
    spans[first].contentStart,
    includeFinalEol ? spans[last].lineEnd : spans[last].contentEnd
  ]
}

/** 模型给的缩进与文件实际缩进之间的一个统一偏移 */
type IndentShift = { kind: 'add'; prefix: string } | { kind: 'remove'; prefix: string }

function leadingWhitespace(line: string): string {
  const m = /^\s*/.exec(line)
  return m ? m[0] : ''
}

/**
 * 找出一个能同时把每条非空 pattern 行映射到对应文件行的空白前缀。
 * 偏移不统一时返回 null。
 */
function detectUniformShift(
  text: string,
  spans: LineSpan[],
  pattern: PatternLines,
  firstLine: number
): IndentShift | null {
  let shift: IndentShift | null = null

  for (let j = 0; j < pattern.lines.length; j++) {
    const fileLine = lineContent(text, spans[firstLine + j]).replace(/\s+$/, '')
    const patternLine = pattern.lines[j].replace(/\s+$/, '')
    if (fileLine.trim() === '' && patternLine.trim() === '') continue

    const fileIndent = leadingWhitespace(fileLine)
    const patternIndent = leadingWhitespace(patternLine)

    let lineShift: IndentShift
    if (fileIndent.endsWith(patternIndent)) {
      lineShift = { kind: 'add', prefix: fileIndent.slice(0, fileIndent.length - patternIndent.length) }
    } else if (patternIndent.endsWith(fileIndent)) {
      lineShift = {
        kind: 'remove',
        prefix: patternIndent.slice(0, patternIndent.length - fileIndent.length)
      }
    } else {
      return null
    }

    /*
     * 每条非空行的前缀必须完全一致。
     * 缩进本来就相符的行会算出空前缀，它刻意与任何非空前缀互不兼容：
     * 一部分行偏移、一部分不偏移，不是一个「整块平移」。
     */
    if (shift === null) shift = lineShift
    else if (shift.kind === lineShift.kind && shift.prefix === lineShift.prefix) {
      /* 一致，继续 */
    } else {
      return null
    }
  }

  return shift ?? { kind: 'add', prefix: '' }
}

/**
 * 把检测到的偏移施加到 newString 的每条非空行上，
 * 让替换文本采用文件的真实缩进。某行吃不掉 remove 前缀时返回 null。
 */
function applyShiftToReplacement(
  newString: string,
  shift: IndentShift,
  crlf: boolean
): string | null {
  const normalized = normalizeLineEndings(newString)
  const shifted: string[] = []
  for (const line of normalized.split('\n')) {
    if (line.trim() === '') {
      shifted.push(line)
      continue
    }
    if (shift.kind === 'add') {
      shifted.push(shift.prefix + line)
    } else {
      if (!line.startsWith(shift.prefix)) return null
      shifted.push(line.slice(shift.prefix.length))
    }
  }
  const joined = shifted.join('\n')
  return crlf ? joined.replace(/\n/g, '\r\n') : joined
}

/**
 * 跑完整条级联。全部级别都匹配不上时返回 null。
 * replacements 是 text 上已排序、互不重叠的区间。
 */
export function findEditMatches(
  text: string,
  oldString: string,
  newString: string
): EditMatchOutcome | null {
  if (!oldString) return null

  const exact = findExactRanges(text, oldString)
  if (exact.length > 0) {
    return {
      strategy: 'exact',
      replacements: exact.map(([start, end]) => ({ start, end, text: newString }))
    }
  }

  const crlf = usesCrlfDominantly(text)

  const lineEnding = findLineEndingMatches(text, oldString, newString, crlf)
  if (lineEnding) return { strategy: 'line-endings', replacements: lineEnding }

  const spans = indexLineSpans(text)
  const pattern = splitPatternLines(oldString)
  if (!pattern) return null

  // 第 3 级：忽略每行行尾空白
  const windows = findLineWindows(text, spans, pattern, (fileLine, patternLine) => {
    return fileLine.replace(/\s+$/, '') === patternLine.replace(/\s+$/, '')
  })
  if (windows.length > 0) {
    const rendered = renderLineEndings(newString, crlf)
    return {
      strategy: 'trailing-whitespace',
      replacements: windows.map((window) => {
        const [start, end] = windowRange(spans, window, pattern.endsWithNewline)
        return { start, end, text: rendered }
      })
    }
  }

  // 第 4 级：整块统一缩进偏移
  const candidates = findLineWindows(text, spans, pattern, (fileLine, patternLine) => {
    return fileLine.trim() === patternLine.trim()
  })
  const replacements: EditReplacement[] = []
  for (const window of candidates) {
    const shift = detectUniformShift(text, spans, pattern, window[0])
    if (!shift) continue
    const rendered = applyShiftToReplacement(newString, shift, crlf)
    if (rendered === null) continue
    const [start, end] = windowRange(spans, window, pattern.endsWithNewline)
    replacements.push({ start, end, text: rendered })
  }
  if (replacements.length > 0) {
    return { strategy: 'indentation', replacements }
  }

  return null
}

/**
 * 把已排序、互不重叠的替换拼回 text。
 * 区间必须严格来自 findEditMatches —— 这里只做一次宽松校验，
 * 越界时宁可抛错也不写出损坏的内容。
 */
export function applyEditReplacements(text: string, replacements: EditReplacement[]): string {
  let out = ''
  let cursor = 0
  for (const r of replacements) {
    if (r.start < cursor || r.end < r.start || r.end > text.length) {
      throw new Error('内部错误：替换区间非法（越界或重叠）')
    }
    out += text.slice(cursor, r.start)
    out += r.text
    cursor = r.end
  }
  out += text.slice(cursor)
  return out
}

/**
 * 告诉模型这次是靠哪一级匹配上的。
 *
 * 这件事必须回报，否则模型不知道自己给的空格是错的，
 * 下一轮还会照着错的方式给。
 */
export function buildEditMatchStrategyNote(strategy: EditMatchStrategy | undefined): string {
  switch (strategy) {
    case 'line-endings':
      return '\nmatchStrategy=line-endings（归一化 CRLF/LF 后匹配成功；文件原有换行风格已保留）'
    case 'trailing-whitespace':
      return '\nmatchStrategy=trailing-whitespace（忽略每行行尾空白后匹配成功）'
    case 'indentation':
      return '\nmatchStrategy=indentation（统一缩进偏移后匹配成功；替换文本已按文件实际缩进重新缩进）'
    default:
      return ''
  }
}

export function parseEditMatchStrategy(raw: unknown): EditMatchStrategy | undefined {
  return raw === 'exact' ||
    raw === 'line-endings' ||
    raw === 'trailing-whitespace' ||
    raw === 'indentation'
    ? raw
    : undefined
}
