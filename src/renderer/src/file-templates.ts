/**
 * 新建文件时用的初始骨架。
 *
 * 为什么要模板：教学场景里「新建一个 html」几乎总是要写 `<!doctype html>`
 * 那一套，让学生每次从空文件开始，第一课的几分钟就花在敲样板上了。
 * 这里给的骨架刻意压到最短 —— 只保留「不写就不对」的部分
 * （doctype、charset、viewport、语言标记），不塞任何教学内容，
 * 免得模板变成另一种需要先删掉的干扰。
 *
 * 纯数据，没有副作用：方便被弹层、store、以后的右键菜单共用。
 */

export interface FileTemplate {
  /** 扩展名，小写、不带点。同时用作 React key 与类型胶囊的取值 */
  ext: string
  /** 类型胶囊上显示的中文名 */
  label: string
  /** 默认文件名，如 index.html。用户可以直接改 */
  defaultName: string
  /** 初始内容。空串表示建一个空文件 */
  content: string
}

/** 新建文件时列的这几种类型。顺序即界面上的顺序 */
export const FILE_TEMPLATES: FileTemplate[] = [
  {
    ext: 'html',
    label: 'HTML',
    defaultName: 'index.html',
    content: [
      '<!doctype html>',
      '<html lang="zh-CN">',
      '  <head>',
      '    <meta charset="UTF-8" />',
      '    <meta name="viewport" content="width=device-width, initial-scale=1" />',
      '    <title>新页面</title>',
      '  </head>',
      '  <body>',
      '    <h1>你好</h1>',
      '  </body>',
      '</html>',
      ''
    ].join('\n')
  },
  {
    ext: 'css',
    label: 'CSS',
    defaultName: 'style.css',
    content: [
      '/* 样式表 */',
      '',
      '* {',
      '  box-sizing: border-box;',
      '}',
      '',
      'body {',
      '  margin: 0;',
      '  padding: 16px;',
      '  font-family: system-ui, "Microsoft YaHei", sans-serif;',
      '  line-height: 1.6;',
      '}',
      ''
    ].join('\n')
  },
  {
    ext: 'js',
    label: 'JavaScript',
    defaultName: 'main.js',
    content: [
      "'use strict'",
      '',
      '// 页面加载完成后执行',
      'document.addEventListener("DOMContentLoaded", () => {',
      '  console.log("脚本已加载")',
      '})',
      ''
    ].join('\n')
  },
  {
    ext: 'md',
    label: 'Markdown',
    defaultName: 'README.md',
    content: ['# 标题', '', '在这里写正文。', ''].join('\n')
  },
  {
    ext: 'json',
    label: 'JSON',
    defaultName: 'data.json',
    content: ['{', '  "name": "",', '  "items": []', '}', ''].join('\n')
  },
  {
    ext: 'txt',
    label: '纯文本',
    defaultName: '新建文件.txt',
    // 纯文本给空内容：它的「模板」就是空白，硬塞一行字反而要删
    content: ''
  }
]

/** 按扩展名找模板。找不到返回 undefined（比如用户把 .txt 手改成 .vue） */
export function templateByExt(ext: string): FileTemplate | undefined {
  const wanted = ext.trim().toLowerCase().replace(/^\./, '')
  return FILE_TEMPLATES.find((item) => item.ext === wanted)
}

/** 模板内容。给空的模板（纯文本）返回空串，调用方据此跳过写盘 */
export function templateContent(template: FileTemplate): string {
  return template.content || ''
}

/**
 * 从用户填的文件名反推模板。
 *
 * 用途：弹层里用户先选了 HTML，又把名字改成 `a.css` —— 这时该按哪个写内容？
 * 按名字来。名字是用户最后的、最明确的一次表达，比胶囊上的选择更新。
 */
export function templateFromName(name: string): FileTemplate | undefined {
  const idx = name.lastIndexOf('.')
  if (idx <= 0) return undefined
  return templateByExt(name.slice(idx + 1))
}

/**
 * 名字合法性校验。返回中文原因，合法时返回空串。
 *
 * 这些字符在 Windows 上直接是非法文件名（不是「不推荐」而是根本建不出来），
 * 提前拦下来比让主进程抛 EINVAL 再翻译成人话要好得多 ——
 * 真机上主进程的错误文本是一串英文路径与 errno，学生看不懂。
 */
export function validateEntryName(name: string): string {
  const value = name.trim()
  if (!value) return '名称不能为空'
  if (value.length > 120) return '名称过长（上限 120 个字符）'
  if (/[\\/:*?"<>|]/.test(value)) return '名称不能包含 \\ / : * ? " < > | 这些字符'
  // Windows 上名称尾部的点与空格会被系统悄悄丢掉，出现「我起的名字变了」，直接拦掉
  if (/[. ]$/.test(value)) return '名称不能以点或空格结尾'
  if (value === '.' || value === '..') return '这个名称不可用'
  // Windows 保留设备名。学生机上也建不出来，且报错很费解
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(value)) return '这是系统保留名称，请换一个'
  return ''
}
