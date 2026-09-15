import type { FileNode } from '@shared/types'
import { useAppStore } from '../../store/useAppStore'

/**
 * 文件树这块共用的纯函数与小原语。
 *
 * 单独一份是因为它们同时被「节点」「工具栏」「右键菜单」三边用到 ——
 * 放在任一组件里，另两边就得反向 import，很快就绕成环。
 */

/** 取扩展名（小写、不带点）。没有扩展名返回空串 */
export function ext(name: string): string {
  const idx = name.lastIndexOf('.')
  return idx > 0 ? name.slice(idx + 1).toLowerCase() : ''
}

/** 取路径末段（文件名或目录名），跨平台 */
export function baseName(target: string): string {
  const parts = target.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] || target
}

/** 取父目录，跨平台 */
export function parentDirOf(target: string): string {
  const idx = Math.max(target.lastIndexOf('/'), target.lastIndexOf('\\'))
  return idx > 0 ? target.slice(0, idx) : target
}

/**
 * child 是否在 root 的**下面**（严格子孙，不含 root 自己）。
 *
 * 拖拽移动时用它排除「把目录扔进它自己的子孙里」。
 * 主进程的 wsMove 也会再拦一次（那才是权威守卫，因为渲染层的路径
 * 可能被伪造），界面层先拦的好处是：拖过去根本不高亮，
 * 用户当场就知道那里放不了，不必等一句报错。
 *
 * 两个细节都不能省：
 *   - 分隔符两种都认 —— Windows 上是 `\`，dev 桩与部分路径用 `/`
 *   - 比较前统一小写 —— Windows 路径不区分大小写，`C:\Foo` 与 `c:\foo`
 *     是同一个目录，不统一就会漏判，让非法落点错误地高亮
 */
export function isDescendantOf(child: string, root: string): boolean {
  if (!child || !root) return false
  const a = child.replace(/\\/g, '/').toLowerCase()
  const b = root
    .replace(/\\/g, '/')
    .toLowerCase()
    .replace(/\/+$/, '')
  return a.startsWith(`${b}/`)
}

/**
 * 文件图标：扩展名 → 短标签。
 *
 * 用短标签而不是引入图标库：打包体积小，标签本身就能告诉使用者
 * 「这是个 HTML」—— 十几个同形状的小圆点反而更难分辨。
 */
export function fileBadge(name: string): { text: string; tone: string } {
  switch (ext(name)) {
    case 'html':
    case 'htm':
      return { text: 'H', tone: 'html' }
    case 'css':
      return { text: 'C', tone: 'css' }
    case 'js':
    case 'mjs':
    case 'cjs':
      return { text: 'J', tone: 'js' }
    case 'ts':
    case 'tsx':
      return { text: 'T', tone: 'ts' }
    case 'json':
      return { text: '{}', tone: 'json' }
    case 'md':
      return { text: 'M', tone: 'md' }
    case 'py':
      return { text: 'Py', tone: 'py' }
    case 'vue':
      return { text: 'V', tone: 'vue' }
    default:
      return { text: '·', tone: 'plain' }
  }
}

/** 人类可读的大小。用于节点右侧的次要信息（只在独立面板里显示） */
export function humanSize(node: FileNode): string {
  if (node.kind === 'dir') return ''
  const size = node.size || 0
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  return `${(size / 1024 / 1024).toFixed(1)} MB`
}

/**
 * 取目录下已有的名字列表，用于弹层里的重名即时校验。
 *
 * 读 store 的 getState 而不是用 hook：这个函数会在事件回调里（点菜单那一刻）
 * 被调用，那时拿 hook 的值已经过期了 —— 同一帧里刚新建完又新建，
 * 过期快照会让第二次重名检查漏过去。
 */
export function existingNamesOf(dir: string): string[] {
  const children = useAppStore.getState().childMap[dir]
  return (children || []).map((node) => node.name)
}
