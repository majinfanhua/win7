import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { logger } from './logger'

/**
 * 原子写：临时文件 + rename，避免写一半掉电把源码写坏。
 *
 * ## ⚠️ Windows 上不能直接 `rename(tmp, target)` 覆盖已存在的文件
 *
 * 目标被占用（杀毒软件、编辑器、同步盘都会短暂占住）时，这一步可能
 * **既失败、又已经把原文件弄没了**，结果两份内容一起丢。
 * 所以先 `rename(target → backup)` 把原件挪开，再 `rename(tmp → target)`；
 * 第二步失败就把 backup 挪回去。这样任何时刻磁盘上都至少有一份完整内容。
 *
 * ## 为什么单独一个模块
 *
 * 这段逻辑原来只在**工具层**（AI 写文件）里，而**用户自己按 Ctrl+S**
 * 走的是 `ipc/workspace.ts` 里一份更简单的实现 —— 直接 rename 覆盖。
 * 于是出现很讽刺的局面：AI 改代码有保护，人手改反而没有，
 * 而注释里早就写明了 Windows 上这么干的风险。
 *
 * 现在两边共用这一份，安全策略只有一处定义。
 */

/** 临时文件后缀。带 pid 是为了同一台机器上多开时互不踩 */
const tmpSuffix = (): string => `.tmp-${process.pid}`
const bakSuffix = (): string => `.bak-${process.pid}`

/**
 * 把 content 原子地写入 target。
 *
 * 失败时**尽力保证原文件还在**；连还原都失败则抛错，
 * 并在错误信息里给出备份文件路径（用户还有救回来的机会）。
 */
export async function atomicWrite(
  target: string,
  /**
   * 内容。除了字符串，也接受 Buffer 以便将来写二进制；
   * 当前调用方都传字符串。
   */
  content: string | Buffer
): Promise<void> {
  await fsp.mkdir(path.dirname(target), { recursive: true })
  const tmp = `${target}${tmpSuffix()}`
  await fsp.writeFile(tmp, content)

  if (!fs.existsSync(target)) {
    // 目标不存在，直接改名即可（没有可丢的原件）
    await fsp.rename(tmp, target)
    return
  }

  const backup = `${target}${bakSuffix()}`
  await fsp.rename(target, backup)
  try {
    await fsp.rename(tmp, target)
  } catch (err) {
    // 尽力还原：还原失败也不能把 tmp 删掉，那会变成「一份都不剩」
    try {
      await fsp.rename(backup, target)
    } catch (restoreErr) {
      logger.error(
        'atomic',
        `写入失败且原件还原失败：${target}（备份留在 ${backup}）：${String(restoreErr)}`
      )
      throw new Error(
        `写入 ${path.basename(target)} 失败，原文件已备份到 ${backup}。原始错误：${String(err)}`
      )
    }
    throw err
  }
  // 成功后才清理备份；清不掉也无所谓（下次写入会覆盖同名备份）
  try {
    await fsp.unlink(backup)
  } catch {
    /* 备份残留不影响正确性 */
  }
}

/**
 * 清理某次失败写留下的临时/备份文件。
 *
 * 只在启动时对工作区扫一遍不够 —— 文件可能在任何时候留下。
 * 这里给的是「针对单个文件」的版本，写入失败时调用即可。
 *
 * 返回真正删掉的文件名，便于日志。
 */
export async function sweepWriteLeftovers(filePath: string): Promise<string[]> {
  const removed: string[] = []
  const dir = path.dirname(filePath)
  const base = path.basename(filePath)
  let entries: string[]
  try {
    entries = await fsp.readdir(dir)
  } catch {
    return removed
  }
  for (const name of entries) {
    // 只清自己这个文件的残留，别碰别人的
    if (!name.startsWith(`${base}.tmp-`) && !name.startsWith(`${base}.bak-`)) continue
    try {
      await fsp.unlink(path.join(dir, name))
      removed.push(name)
    } catch {
      /* 删不掉就留着，不影响正确性 */
    }
  }
  return removed
}
