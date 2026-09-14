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

/** 教学场景下可在右侧直接预览的文件 */
export function isPreviewable(filePath: string): boolean {
  const lang = languageFromPath(filePath)
  return lang === 'html' || lang === 'css' || lang === 'javascript' || lang === 'markdown'
}
