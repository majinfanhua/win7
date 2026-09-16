const MAP: Record<string, string> = {
  ts: 'typescript',
  tsx: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  json: 'json',
  html: 'html',
  htm: 'html',
  css: 'css',
  scss: 'scss',
  less: 'less',
  md: 'markdown',
  py: 'python',
  java: 'java',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  cc: 'cpp',
  hpp: 'cpp',
  cs: 'csharp',
  go: 'go',
  rs: 'rust',
  php: 'php',
  rb: 'ruby',
  sql: 'sql',
  sh: 'shell',
  bat: 'bat',
  ps1: 'powershell',
  xml: 'xml',
  yml: 'yaml',
  yaml: 'yaml',
  txt: 'plaintext'
}

/** 根据文件扩展名推断 Monaco 语言 id */
export function languageFromPath(filePath: string): string {
  const name = filePath.split(/[\\/]/).pop() || ''
  const idx = name.lastIndexOf('.')
  if (idx < 0) return 'plaintext'
  return MAP[name.slice(idx + 1).toLowerCase()] || 'plaintext'
}

/**
 * 能不能「用浏览器打开」。
 *
 * 只有 HTML 有意义：交给系统浏览器的是经临时静态服务代理的页面，
 * 而 .css / .js / .md 单独打开只会看到源码文本，不如直接在编辑器里看。
 *
 * ⚠️ 这条判断原先在两个地方各写了一份（内嵌预览面板里一份、
 * 文件树右键菜单里一份），两处一旦不一致就会出现「右键能预览、
 * 顶栏按钮却点了没反应」。现在只留这一份，两边都从这里取。
 */
export function canOpenInBrowser(filePath: string): boolean {
  return languageFromPath(filePath) === 'html'
}
