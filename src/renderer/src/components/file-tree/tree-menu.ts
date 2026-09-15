import { ext } from './shared'

/**
 * 文件树的右键菜单定义。
 *
 * 抽成纯函数（配置进、菜单项数组出）的理由：
 *   1. 侧栏嵌入树与内容区独立面板共用**完全同一份**菜单，
 *      不会出现「这边能建文件、那边不能」的割裂
 *   2. “哪一项该置灰”独立于渲染，能一眼看完所有规则
 *
 * 失效项一律**置灰而不是隐藏** —— 菜单位置稳定才好找，
 * 藏起来会变成每次右键都要重新认一遍菜单。
 */

export type TreeMenuItem = {
  key: string
  label: string
  kind: 'sep' | 'item'
  danger?: boolean
  checked?: boolean
  /** 失效时的原因（原生 title，鼠标悬停能知道为什么是灰的） */
  disabledReason?: string
  run?: () => void
}

/** 右键时命中的落点信息 */
export type TreeMenuTarget = {
  /** 命中的路径，空串表示右键在空白处 */
  path: string
  /** 命中项的类型，空串表示右键在空白处 */
  kind: string
}

export type TreeMenuContext = {
  target: TreeMenuTarget
  /** 当前工作区根。为空表示还没打开项目 */
  workspace: string
  /** 新建的实际落点目录（右键文件夹进它，右键文件/空白落同级） */
  parentDir: string
  showHidden: boolean
  sortBy: 'name' | 'type' | 'mtime'
}

export type TreeMenuActions = {
  onPreview: () => void
  onNewFile: () => void
  onNewDir: () => void
  onRename: () => void
  onDelete: () => void
  onMove: () => void
  onToggleHidden: () => void
  onCopyPath: () => void
  onReveal: () => void
  onInsertRef: () => void
  onRefresh: () => void
  onSort: (sortBy: 'name' | 'type' | 'mtime') => void
}

/** 「预览文件」只在 HTML 上有意义；其余文件交系统默认程序（通过打开所在目录） */
export function canPreview(target: TreeMenuTarget): boolean {
  return Boolean(target.path) && target.kind !== 'dir' && ['html', 'htm'].includes(ext(target.path))
}

/** 排序方式在菜单里的显示名 */
const SORT_LABELS: Array<{ key: 'name' | 'type' | 'mtime'; label: string }> = [
  { key: 'name', label: '按名称' },
  { key: 'type', label: '按类型' },
  { key: 'mtime', label: '按修改时间' }
]

export function buildTreeMenu(ctx: TreeMenuContext, act: TreeMenuActions): TreeMenuItem[] {
  const hasTarget = Boolean(ctx.target.path)
  const isDirTarget = ctx.target.kind === 'dir'
  const hasWorkspace = Boolean(ctx.workspace)

  return [
    {
      key: 'preview',
      label: '预览文件',
      kind: 'item',
      disabledReason: canPreview(ctx.target) ? undefined : '只有 HTML 文件可以预览',
      run: act.onPreview
    },
    { key: 'sep1', label: '', kind: 'sep' },
    {
      key: 'newFile',
      label: '新建文件',
      kind: 'item',
      disabledReason: hasWorkspace ? undefined : '先打开一个文件夹',
      run: act.onNewFile
    },
    {
      key: 'newDir',
      label: '新建文件夹',
      kind: 'item',
      disabledReason: hasWorkspace ? undefined : '先打开一个文件夹',
      run: act.onNewDir
    },
    { key: 'sep2', label: '', kind: 'sep' },
    {
      key: 'rename',
      label: '重命名',
      kind: 'item',
      disabledReason: hasTarget ? undefined : '请先选一个文件或文件夹',
      run: act.onRename
    },
    {
      key: 'move',
      label: '移动到…',
      kind: 'item',
      // 和重命名/删除同样的前提：得先有落点。
      // 拖拽是移动的主路径，「移动到…」是给拖不动或目标在折叠目录里时的备选 ——
      // 少了它，想移到没展开的目录就只能一层层展开再拖
      disabledReason: hasTarget ? undefined : '请先选一个文件或文件夹',
      run: act.onMove
    },
    {
      key: 'delete',
      label: '删除',
      kind: 'item',
      danger: true,
      disabledReason: hasTarget ? undefined : '请先选一个文件或文件夹',
      run: act.onDelete
    },
    { key: 'sep3', label: '', kind: 'sep' },
    {
      key: 'hidden',
      label: '显示隐藏文件',
      kind: 'item',
      checked: ctx.showHidden,
      disabledReason: hasWorkspace ? undefined : '先打开一个文件夹',
      run: act.onToggleHidden
    },
    // 排序方式作为一组勾选项，而不是只有名字的单项 ——
    // 菜单里保持「当前用哪个」一眼可见，不用再去工具栏找
    ...SORT_LABELS.map((item) => ({
      key: `sort-${item.key}`,
      label: `排序：${item.label}`,
      kind: 'item' as const,
      checked: ctx.sortBy === item.key,
      disabledReason: hasWorkspace ? undefined : '先打开一个文件夹',
      run: () => act.onSort(item.key)
    })),
    { key: 'sep4', label: '', kind: 'sep' },
    {
      key: 'copyPath',
      label: '复制路径',
      kind: 'item',
      disabledReason: hasTarget ? undefined : '请先选一个文件或文件夹',
      run: act.onCopyPath
    },
    {
      key: 'reveal',
      label: '打开所在目录',
      kind: 'item',
      disabledReason: hasTarget ? undefined : '请先选一个文件或文件夹',
      run: act.onReveal
    },
    {
      key: 'insert',
      label: '插入引用',
      kind: 'item',
      disabledReason: hasTarget && !isDirTarget ? undefined : '只能引用文件，不能引用文件夹',
      run: act.onInsertRef
    },
    { key: 'sep5', label: '', kind: 'sep' },
    {
      key: 'refresh',
      label: '刷新',
      kind: 'item',
      disabledReason: hasWorkspace ? undefined : '先打开一个文件夹',
      run: act.onRefresh
    }
  ]
}
