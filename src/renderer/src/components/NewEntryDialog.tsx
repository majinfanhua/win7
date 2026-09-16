import { useMemo, useState } from 'react'
import {
  FILE_TEMPLATES,
  templateFromName,
  validateEntryName,
  type FileTemplate
} from '../file-templates'
import InputDialog from './InputDialog'

/**
 * 新建文件 / 文件夹的弹层。
 *
 * 它是 InputDialog 的一层组合：多了「类型胶囊」与「落点面包屑」。
 * 分成两层而不是写成一个巨型组件，是因为重命名只要纯输入，
 * 把它也塞进这里会变成一堆 if (kind === 'rename') 分支。
 *
 * 类型胶囊只在「新建文件」时出现 —— 文件夹没有类型可选。
 */

export type NewEntryTarget = {
  /** 落点目录的绝对路径 */
  parent: string
  /** 落点目录的显示面包屑，如 `课程代码 / 第 1 课` */
  parentLabel: string
  /** 该目录下已有的名字，用于重名即时提示 */
  existing: string[]
}

type Props = {
  kind: 'file' | 'dir'
  target: NewEntryTarget
  /** 返回空串表示成功；返回中文原因则弹层保持打开并显示它 */
  onSubmit: (name: string, template: FileTemplate | undefined) => Promise<string>
  onCancel: () => void
}

export default function NewEntryDialog({ kind, target, onSubmit, onCancel }: Props): JSX.Element {
  const isFile = kind === 'file'
  const [ext, setExt] = useState<string>(isFile ? FILE_TEMPLATES[0].ext : '')

  /**
   * 用户手敲进来的名字。
   *
   * 存它而不是只存在 InputDialog 内部：类型胶囊要跟着扩展名走 ——
   * 学生在名字里打 `a.css` 而胶囊还高亮着「HTML」，那是自相矛盾的，
   * 提交时按哪个走也会让人猜。
   *
   * 这是 VS Code 的做法：文件名是主输入，类型是它的**推论**；
   * 胶囊只是给「不想敲扩展名」的人准备的快捷方式。
   */
  const [typedName, setTypedName] = useState('')

  /** 名字里带了扩展名就用它，否则用胶囊选的 */
  const byName = isFile && typedName ? templateFromName(typedName) : undefined
  const template = isFile
    ? byName || FILE_TEMPLATES.find((item) => item.ext === ext)
    : undefined

  /** 重名集合。用 Set 而不是数组 includes：目录里几十个文件时 includes 是 O(n) */
  const taken = useMemo(
    () => new Set(target.existing.map((name) => name.toLowerCase())),
    [target.existing]
  )

  /**
   * 校验。三道：
   *   1. 名字本身合法（非法字符 / 保留名，见 validateEntryName）
   *   2. 不与同目录已有项重名 —— 之前静默覆盖过学生的文件，绝不能再来一次
   *   3. 选了 HTML 类型但名字写成 .txt 这种「类型与扩展名打架」的情况，以名字为准，
   *      这里不报错（见 templateFromName 的注释）
   */
  const validate = (value: string): string => {
    const base = validateEntryName(value)
    if (base) return base
    const name = value.trim()
    if (taken.has(name.toLowerCase())) return `这里已经有一个叫「${name}」的项目了`
    return ''
  }

  const label = isFile ? '文件名' : '文件夹名'
  const title = isFile ? '新建文件' : '新建文件夹'
  const seed = isFile ? (template?.defaultName || '新建文件.txt') : '新建文件夹'

  const submit = async (name: string): Promise<string> => {
    // template 已经在渲染期按「名字优先」算好了（见上面的 byName），
    // 这里直接用 —— 两处各算一遍早晚会不一致
    return onSubmit(name, template)
  }

  return (
    <InputDialog
      title={title}
      label={label}
      initial={seed}
      /* key 让切换类型时 InputDialog 内部状态重置，
         默认文件名（index.html / style.css）才会跟着换 */
      key={ext}
      confirmText="创建"
      hint={
        isFile
          ? '会写入一段可直接运行的初始代码，创建后自动在编辑器里打开'
          : '创建后可以在它下面继续新建 html / css / js 文件'
      }
      validate={validate}
      onSubmit={submit}
      onCancel={onCancel}
      onValueChange={setTypedName}
    >
      <div className="field">
        <label>创建位置</label>
        <div className="dialog-path" title={target.parent}>
          <span className="dialog-path-icon" aria-hidden="true">
            {'\uD83D\uDCC1'}
          </span>
          <span className="dialog-path-text">{target.parentLabel}</span>
        </div>
      </div>

      {isFile && (
        <div className="field">
          <label>文件类型</label>
          <div className="type-pills" role="group" aria-label="文件类型">
            {FILE_TEMPLATES.map((item) => (
              <button
                key={item.ext}
                type="button"
                className={`type-pill${item.ext === template?.ext ? ' is-on' : ''}`}
                aria-pressed={item.ext === ext}
                title={`新建 ${item.label} 文件`}
                onClick={() => setExt(item.ext)}
              >
                {item.label}
              </button>
            ))}
          </div>
        </div>
      )}
    </InputDialog>
  )
}
