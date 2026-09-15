/**
 * 工具层的几个数值上限。
 *
 * 单独一个不 import 任何东西的文件，是为了让 meta.ts（模型看到的 schema）
 * 与 exec.ts / jobs.ts（真的执行）用同一份数字。
 * 两边各写一遍的话，schema 里写「上限 5 分钟」而代码只给 30 秒，
 * 模型会一直踩坑，而且没人会想到去对这两个数。
 */

/** runCommand 不传 timeoutMs 时的默认超时 */
export const RUN_TIMEOUT_DEFAULT_MS = 30_000
/** runCommand 的超时上限。再长就不该用 runCommand 了，应该用 jobRun */
export const RUN_TIMEOUT_MAX_MS = 5 * 60 * 1000

/** 单个后台任务的硬上限，到点就杀 */
export const JOB_MAX_MS = 30 * 60 * 1000
/** 同时最多几个后台任务 */
export const JOB_MAX_RUNNING = 4

/* ------------------------------------------------------------------ *
 * 搜索类工具（Glob / Grep）
 * ------------------------------------------------------------------ */

/**
 * 一次搜索最多访问多少个文件条目。
 *
 * 与 listDir 的 MAX_ENTRIES 取同一个量级：教学的目录通常几十到几百个文件，
 * 500 足够；真撞上 500 说明这个目录不该整棵搜，那时应该缩小 path。
 * 有上限是必须的：Win7 机械盘 + 杀软实时扫描下，无上限的递归遍历
 * 能让界面卡住好几秒。
 */
export const MAX_ENTRIES = 500

/**
 * 一次搜索最多扫描多少字节的**文件内容**（只有 Grep 消耗）。
 *
 * 防的是「工作区里混进一个几百 MB 的日志或数据文件，一次 Grep 把内存吃光」。
 * 教学项目的源码总计通常不到 1 MB，4 MB 足够宽裕。
 */
export const MAX_SCAN_BYTES = 4 * 1024 * 1024

/** 一次搜索最多返回多少条匹配（Glob 是文件数，Grep 是命中行数） */
export const MAX_MATCHES = 200

/** 单行超过这个长度就截断（压缩文件、base64 会有一行几 MB 的情况） */
export const MAX_LINE_CHARS = 2000

/**
 * 搜索时永远跳过的目录名。
 *
 * 前一批是「一次 readdir 几万条」的重目录，后一批（.trash / dist / out）
 * 是构建产物或回收站 —— 搜它们只会让模型看到一堆无关的副本。
 * 与 ipc/workspace.ts 的 ALWAYS_IGNORED 保持一致：
 * 文件树里看不见的东西，搜索也不该找到。
 */
export const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'out',
  'dist',
  '__pycache__',
  '.venv',
  'venv',
  '.trash',
  '.idea',
  '.vscode',
  '.cache'
])

