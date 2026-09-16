import fs from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import { logger } from './logger'

/**
 * 路径边界：AI 的默认活动范围，以及「越界」的判定。
 *
 * ## 为什么单独一个模块
 *
 * 边界判定以前散在 `ipc/workspace.ts` 的 `assertInsideRoot` 里，只有
 * 「在工作区内 / 不在」两种结论，且是同步抛错。现在需要三件事它给不了：
 *
 *   1. **两个合法根**：当前工作区 + 临时工作区（没选项目时 AI 仍有地方可写）
 *   2. 路径**相对谁**解析 —— 模型给相对路径是常态，以前一律被拒
 *   3. 越界时**不是直接失败**，而是交给审批层问用户
 *
 * 所以把「根的管理」与「边界判定」独立出来，成为唯一真源：
 * 工具层、IPC 层都从这里取，不要各写一份（两份守卫早晚会跑偏）。
 *
 * ## 与 assertInsideRoot 的分工
 *
 *   - 界面发起的文件操作（文件树、编辑器保存）：仍走严格的工作区内校验
 *     （见 ipc/workspace.ts）。那是用户在自己的项目里点，不存在「越界」
 *     这个需求，也绝不该弹授权框。
 *   - AI 工具发起：走 classify() + 审批。默认只在合法根内，
 *     越界要用户点头（完全允许模式除外）。
 */

/** 当前工作区。空串表示用户还没选项目 */
let workspaceRoot = ''

/**
 * 临时工作区。
 *
 * 用户没选项目时 AI 仍然需要一块可写的地方 —— 否则「打开软件直接问
 * 帮我写个快排」这种最常见的第一次使用，AI 连个落点都没有。
 * 放在 userData 下而不是系统 %TEMP%：系统临时目录会被清理工具扫掉，
 * 而学生在里面写的东西可能还没保存到真正的项目里。
 */
let scratchRoot = ''

/** 在 app ready 之后调用一次（app.getPath 在此之前不可靠） */
export function initRoots(): void {
  scratchRoot = path.join(app.getPath('userData'), 'scratch')
  /*
   * 目录要真的建出来。
   *
   * 不建的话「没打开项目时 AI 仍能干活」这条就是空话 ——
   * 第一次 writeFile 会因为父目录不存在而失败，而那个错误
   * （ENOENT）对模型和用户都看不出是「临时区没准备好」。
   * 建失败也不抛：只记日志，让后续操作各自报自己的错。
   */
  try {
    fs.mkdirSync(scratchRoot, { recursive: true })
    logger.info('paths', `临时工作区: ${scratchRoot}`)
  } catch (err) {
    logger.warn('paths', `临时工作区创建失败（${scratchRoot}）: ${String(err)}`)
  }
}

export function getWorkspaceRoot(): string {
  return workspaceRoot
}

export function getScratchRoot(): string {
  return scratchRoot
}

/**
 * 设置当前工作区。
 *
 * 只负责记值 —— 落盘、文件监视、最近列表由 ipc/workspace.ts 的
 * setWorkspaceRoot 处理（它调这里）。这样「根是什么」与「根变了要做什么」
 * 分开，不会出现两处各记一份值。
 */
export function setWorkspaceRootValue(root: string): void {
  workspaceRoot = root ? path.resolve(root) : ''
}

/**
 * 当前所有合法根，按优先级（工作区在前）。
 *
 * 相对路径以**第一个**为基准解析 —— 有项目时相对项目，
 * 没项目时相对临时区，符合直觉。
 */
export function allowedRoots(): string[] {
  return [workspaceRoot, scratchRoot].filter(Boolean)
}

/** 相对路径的解析基准 */
export function baseRoot(): string {
  return workspaceRoot || scratchRoot
}

/** target 是否在 root 之内（含 root 自身）。root 为空返回 false */
export function isInside(root: string, target: string): boolean {
  if (!root) return false
  const rel = path.relative(root, target)
  // rel 为空 = 就是 root 本身；不以 .. 开头且不是绝对路径 = 在内部
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

/**
 * 把模型给的路径解析成绝对路径。
 *
 * 支持三种写法（以前只支持第一种，是工具大面积失败的根因）：
 *   - 绝对路径：原样规范化
 *   - 相对路径 `src/a.ts` / `./src/a.ts`：相对当前工作区（没项目时相对临时区）
 *   - `.` / 空串：基准根本身
 *
 * 注意：这里**只解析、不判定**。是否越界由 classify() 给结论，
 * 因为「越界」在不同模式下后果不同（问用户 / 直接拒绝 / 放行）。
 */
export function resolveAgainst(target: string): string {
  const raw = (target || '').trim()
  if (!raw || raw === '.' || raw === './') return baseRoot()
  if (path.isAbsolute(raw)) return path.normalize(raw)
  return path.resolve(baseRoot(), raw)
}

export type Boundary = 'inside' | 'outside' | 'none'

export interface ClassifyResult {
  /** 解析后的绝对路径 */
  resolved: string
  /**
   * inside  —— 在某个合法根内
   * outside —— 不在任何合法根内（需要授权，或完全允许模式下放行）
   * none    —— 没有任何可用根（既没项目、临时区也没初始化好）
   */
  boundary: Boundary
  /** 命中的那个根（inside 时有值） */
  root: string
  /**
   * 越界时要授权的最外层目录。
   *
   * 取「离目标最近的那个已存在的祖先目录」而不是目标本身：
   * 用户授权时想的是「允许它动这个项目的目录」，而不是
   * 「允许它动 D:\code\proj\src\a.ts 这一个文件」。
   * 由调用方按需再收窄（审批层会优先用目录级缓存命中）。
   */
  scopeDir: string
}

/**
 * 判定一个路径落在哪。
 *
 * 不做任何审批 —— 只回答「在不在里面」。这样它既能在工具层用，
 * 也能在设置界面的说明里用，不掺业务决策。
 */
export function classify(target: string): ClassifyResult {
  const resolved = resolveAgainst(target)
  const roots = allowedRoots()

  if (roots.length === 0) {
    return { resolved, boundary: 'none', root: '', scopeDir: path.dirname(resolved) }
  }

  for (const root of roots) {
    if (isInside(root, resolved)) {
      return { resolved, boundary: 'inside', root, scopeDir: root }
    }
  }

  return {
    resolved,
    boundary: 'outside',
    root: '',
    scopeDir: path.dirname(resolved)
  }
}

/**
 * 判断 target 是否就是某个合法根本身。
 *
 * 用在「把工作区整个删掉」这种请求上 —— 根目录本身不该被 AI 当普通目录操作。
 */
export function isRootItself(target: string): boolean {
  const resolved = path.resolve(target)
  return allowedRoots().some((root) => path.resolve(root) === resolved)
}

/**
 * 相对路径的展示形式（给摘要与日志用）。
 * 在工作区内时显示相对路径，越界时显示绝对路径 —— 后者需要用户看清是哪儿。
 */
export function displayPath(target: string): string {
  const resolved = path.resolve(target)
  for (const root of allowedRoots()) {
    if (isInside(root, resolved)) {
      const rel = path.relative(root, resolved)
      return rel || path.basename(root)
    }
  }
  return resolved
}
