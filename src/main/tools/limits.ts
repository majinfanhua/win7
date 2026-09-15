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
