import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { app } from 'electron'
import { getWorkspaceRoot } from './paths'
import { logger } from './logger'

/**
 * Skills：可复用的「怎么做某件事」的说明书。
 *
 * ## 一个 Skill 是什么
 *
 * 一个目录，里面有一个 `SKILL.md`：
 *
 *     ---
 *     name: 生成单元测试
 *     description: 给一个函数生成 pytest 单元测试，含边界用例
 *     ---
 *
 *     正文：具体怎么做。可以写步骤、约定、检查清单、示例。
 *
 * 正文就是**给模型看的指令**，不是给人看的文档 —— 所以写得越具体越好。
 * 它和 system prompt 的区别：system prompt 每轮都发、必须稳定；
 * Skill 只在模型觉得需要时才读，所以可以长、可以多。
 *
 * ## 为什么用「渐进式披露」
 *
 * 不把所有 Skill 的正文塞进 system prompt，原因和记忆工具一样：
 * 正文会变、而且大部分和当前任务无关。塞进去等于每轮为所有 Skill 付费。
 *
 * 所以走两步：
 *   1. `listSkills` 返回全部 Skill 的**名字 + 一句话描述**（很便宜）
 *   2. 模型判断哪个有用，再用 `readSkill` 读它的**正文**
 *
 * 这样 system prompt 里只需要一句「你有技能可用，先 listSkills 看看」。
 *
 * ## 两级目录
 *
 *   - `<userData>/skills/<id>/SKILL.md`     用户级，所有项目共用
 *   - `<工作区>/.hangke/skills/<id>/SKILL.md` 项目级，跟着仓库走
 *
 * 项目级优先：同一个 id 在两边都有时，用项目级的 ——
 * 「这个项目的约定」比「我的通用习惯」更具体，应该覆盖后者。
 *
 * 项目级放在 `.hangke/` 下而不是散在工作区根目录：不污染用户的目录结构，
 * 而且一个文件夹就能整个删掉。
 */

/** 单个 SKILL.md 的体积上限。超过就不读，避免一个巨型文件把上下文吃掉 */
const SKILL_MAX_BYTES = 128 * 1024

/** 项目级 Skill 的目录名 */
const PROJECT_SKILL_DIR = '.hangke'

export type SkillSource = 'user' | 'project'

export interface SkillSummary {
  /** 目录名，也是调用 readSkill 时用的 id */
  id: string
  /** frontmatter 里的 name；缺省时用 id */
  name: string
  /** frontmatter 里的 description；缺省时空串 */
  description: string
  source: SkillSource
  /** SKILL.md 的绝对路径，界面用它做「打开」 */
  path: string
}

export function userSkillsDir(): string {
  return path.join(app.getPath('userData'), 'skills')
}

export function projectSkillsDir(): string {
  const root = getWorkspaceRoot()
  return root ? path.join(root, PROJECT_SKILL_DIR, 'skills') : ''
}

/**
 * 解析 frontmatter。
 *
 * 只支持最简单的 `key: value` 形式，**不引 YAML 库**：
 *   - 一个 yaml 解析器有几十 KB，而这里只需要两个字段
 *   - 复杂 YAML 的边界情况（锚点、多行块）在这个场景里用不上
 *   - 手写的 Skill 文件越简单越好，写错了也容易看出来
 *
 * 不认识的键直接忽略（不报错）：以后加字段时，老版本读到新文件
 * 不该因为一个陌生键就整份作废。
 */
function parseFrontmatter(raw: string): {
  meta: Record<string, string>
  body: string
} {
  const meta: Record<string, string> = {}
  /*
   * 必须以 `---` 开头才算有 frontmatter。
   * `\r?\n` 兼容 Windows 换行 —— 用户在记事本里存过的文件是 CRLF。
   */
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw)
  if (!m) return { meta, body: raw }

  for (const line of m[1].split(/\r?\n/)) {
    const idx = line.indexOf(':')
    if (idx <= 0) continue
    const key = line.slice(0, idx).trim()
    let value = line.slice(idx + 1).trim()
    // 去掉成对的引号，这样 description 里能安全地写冒号
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1)
    }
    if (key) meta[key] = value
  }
  return { meta, body: raw.slice(m[0].length) }
}

/**
 * 扫描一个目录下的 Skill。
 *
 * 目录不存在**不是错误**（用户可能一个都没建），返回空数组。
 * 单个 Skill 读坏也只跳过它，不让整个列表失败 —— 一个手写坏的
 * frontmatter 不该让「还有哪些技能可用」这件事整个查不出来。
 */
async function scanDir(dir: string, source: SkillSource): Promise<SkillSummary[]> {
  if (!dir) return []
  let entries: fs.Dirent[]
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }

  const out: SkillSummary[] = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    // 跳过以 . 或 _ 开头的目录：前者是隐藏目录，后者是本项目的约定
    // （写成 `_draft` 表示「还没写完，先别让 AI 看到」）
    if (entry.name.startsWith('.') || entry.name.startsWith('_')) continue
    const file = path.join(dir, entry.name, 'SKILL.md')
    try {
      const stat = await fsp.stat(file)
      if (!stat.isFile() || stat.size > SKILL_MAX_BYTES) continue
      const raw = await fsp.readFile(file, 'utf8')
      const { meta } = parseFrontmatter(raw)
      out.push({
        id: entry.name,
        name: meta.name?.trim() || entry.name,
        description: meta.description?.trim() || '',
        source,
        path: file
      })
    } catch {
      // 没有 SKILL.md 的目录不是 Skill，跳过
    }
  }
  return out
}

/**
 * 列出全部可用 Skill。
 *
 * 合并规则：先放项目级，再放用户级，同 id 只保留**先出现的那个**
 * （也就是项目级优先）。顺序也按这个来 —— 列表里项目自己的排在前面，
 * 与「项目约定优先」的语义一致。
 */
export async function listSkills(): Promise<SkillSummary[]> {
  const [project, user] = await Promise.all([
    scanDir(projectSkillsDir(), 'project'),
    scanDir(userSkillsDir(), 'user')
  ])

  const seen = new Set<string>()
  const merged: SkillSummary[] = []
  for (const item of [...project, ...user]) {
    if (seen.has(item.id)) continue
    seen.add(item.id)
    merged.push(item)
  }
  return merged.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'))
}

/** 给模型看的一行摘要：`id — name：description` */
export function describeSkill(skill: SkillSummary): string {
  const desc = skill.description ? `：${skill.description}` : ''
  const where = skill.source === 'project' ? '（本项目）' : '（全局）'
  return `- ${skill.id} — ${skill.name}${desc}${where}`
}

export interface ReadSkillResult {
  ok: boolean
  text: string
}

/**
 * 读一个 Skill 的正文。
 *
 * ⚠️ id 必须**按目录名精确匹配**，不能拼路径。
 *
 * 直接 `path.join(dir, id)` 的话，`id = '../../..'` 这类值能读到
 * 磁盘上任意文件（用户在对话里让 AI「读一下 ../../etc/passwd」就行）。
 * 所以这里只在**已经扫描出来的列表**里找，找不到就报错 ——
 * 列表本身来自 readdir，不可能含目录穿越的结果。
 */
export async function readSkill(id: string): Promise<ReadSkillResult> {
  const wanted = (id || '').trim()
  if (!wanted) return { ok: false, text: 'readSkill 需要 id 参数' }

  const all = await listSkills()
  const hit = all.find((s) => s.id === wanted)
  if (!hit) {
    return {
      ok: false,
      text:
        `没有找到技能「${wanted}」。可用的是：` +
        (all.length ? all.map((s) => s.id).join('、') : '（当前一个都没有）')
    }
  }

  try {
    const raw = await fsp.readFile(hit.path, 'utf8')
    const { body } = parseFrontmatter(raw)
    const head =
      `【技能：${hit.name}】` +
      (hit.description ? `\n作用：${hit.description}` : '') +
      `\n来源：${hit.source === 'project' ? '本项目 .hangke/skills' : '全局 skills'}`
    return {
      ok: true,
      text: `${head}\n-----\n${body.trim() || '（这个技能只有标题，正文是空的）'}`
    }
  } catch (err) {
    logger.warn('skill', `读取技能失败 ${hit.path}: ${String(err)}`)
    return { ok: false, text: `读取技能「${wanted}」失败：${String(err)}` }
  }
}

/**
 * 首次使用时建出用户级目录，并放一个示例 Skill。
 *
 * 放示例的理由：这个功能的用法（建一个目录、写 SKILL.md、frontmatter
 * 怎么写）光看设置页的文字说明很难上手。给一个能跑的例子，
 * 用户复制改名就是自己的技能了。
 *
 * 只在目录**不存在**时建，不在里面加任何判断 —— 用户删掉示例之后
 * 不该被重新塞回来。
 */
export async function ensureSkillsDir(): Promise<void> {
  const dir = userSkillsDir()
  try {
    await fsp.mkdir(path.join(dir, 'example'), { recursive: true })
    const file = path.join(dir, 'example', 'SKILL.md')
    if (!fs.existsSync(file)) {
      await fsp.writeFile(file, EXAMPLE_SKILL, 'utf8')
      logger.info('skill', `已创建示例技能: ${file}`)
    }
  } catch (err) {
    logger.warn('skill', `创建技能目录失败: ${String(err)}`)
  }
}

/** 示例技能的内容。既要能跑，也要顺便把写法讲清楚 */
const EXAMPLE_SKILL = `---
name: 示例技能
description: 这是一个示例，说明 SKILL.md 怎么写。可以直接改，也可以删掉。
---

# 示例技能

这一行以下的正文，就是模型执行这个技能时看到的指令。

写的时候注意两点：

1. **写具体做法**，而不是「要写得好」这种空话。
   模型需要的是可执行的步骤和明确的约定。
2. **可以写很长**。技能只在被需要时才读，所以不必为了省 token 压缩它。

## 一个真实技能的写法参考

- 第一步做什么，看哪些文件
- 有哪些项目约定必须遵守（比如「这个项目的测试都放 __tests__/ 下」）
- 完成后要检查什么（比如「跑一遍 pytest 确认全绿」）
- 输出格式要求（比如「最后列出改了哪几个文件」）
`
