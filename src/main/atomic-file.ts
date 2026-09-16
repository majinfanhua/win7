import crypto from 'node:crypto'
import fsp from 'node:fs/promises'
import path from 'node:path'

/**
 * 原子写文件 + 同一路径串行化。
 *
 * ## 为什么需要一个单独的模块
 *
 * 这个应用里有好几处「整份覆写一个小 JSON」的场景（会话正文、归档索引、
 * 用量统计、配置）。它们的正确写法是同一个：
 *
 *   1. 写临时文件
 *   2. rename 到目标（**同文件系统内 rename 是原子的**）
 *
 * 于是「要么读到旧的完整文件，要么读到新的完整文件」，不存在读到半截
 * JSON 的中间态。直接 writeFile 覆盖的话，写到一半断电就留下坏文件。
 *
 * ## 为什么还要串行化
 *
 * 光有「写 tmp 再 rename」是不够的。**两个并发调用会撞在同一个 tmp 上**：
 *
 *   A: 写 tmp
 *   B: 写 tmp（覆盖掉 A 的内容 —— 此时 A 的数据已经丢了）
 *   A: rename tmp → target（成功，但写进去的是 B 的内容）
 *   B: rename tmp → target（**ENOENT，tmp 已经被 A 挪走了**）
 *
 * 这是真事，不是理论：归档一条会话会「先写索引，再在后台总结」，
 * 而总结过程里还会再写一次索引。用户连着归档两条就会撞上，
 * 表现为日志里一条 ENOENT，以及**其中一次数据静默丢失**。
 *
 * 用「每个路径一条 Promise 链」把它串起来：同一路径的写排队执行，
 * 不同路径互不阻塞。另外 tmp 文件名带上序号，
 * 即使队列被绕过（比如别的进程也在写）也不会互相覆盖。
 *
 * ## 为什么不用 fs 的 rename 重试
 *
 * 重试是在掩盖问题：内容已经错了（上面第 2 步），重试只会把错的内容
 * 写得更确定。要解决的是「让它们别同时写」。
 */

/** 每个目标路径一条串行链。key 是 resolve 后的绝对路径 */
const chains = new Map<string, Promise<unknown>>()

/** tmp 文件名里的自增序号，防止同毫秒内的两次调用拿到同一个名字 */
let sequence = 0

/**
 * 把一次操作排到某路径的队列末尾。
 *
 * 关键点：**返回值不能是「上一个操作的结果」**，
 * 而必须是「在它之后执行」的新 Promise。而且失败要吞掉 ——
 * 队列里前一个操作失败了，不能让后面排队的一起失败
 * （它们之间没有任何关系）。
 */
function enqueue<T>(target: string, task: () => Promise<T>): Promise<T> {
  const key = path.resolve(target)
  const previous = chains.get(key) || Promise.resolve()
  // 用 .then(task, task)：前一个无论成功失败都继续往下走
  const next = previous.then(task, task)
  /*
   * 链上只留「已完成」的标记，不留结果 ——
   * 留着结果会让链条持有每一份写过的内容（内存泄漏），
   * 而这个标记的用途仅仅是「排队」。
   */
  chains.set(
    key,
    next.then(
      () => undefined,
      () => undefined
    )
  )
  return next
}

/**
 * 把一段操作排到某个 key 的队列末尾，**返回它自己的结果**。
 *
 * 这是「读—改—写」序列的保护：如果两个并发调用各自
 * 「读索引 → 改 → 写索引」，即使每一次写都是原子的，
 * 后写的也会**覆盖掉前一次改的东西**（因为它读的是旧索引）。
 * 原子写保证的是「文件不半截」，不是「改动不丢」—— 两件事都要做。
 *
 * key 用文件名（如 'archive'），不必是路径 —— 它只是把
 * 「必须互相串行的事情」归到一组。
 */
export function withLock<T>(key: string, task: () => Promise<T>): Promise<T> {
  return enqueue(`lock:${key}`, task)
}

export interface AtomicWriteOptions {
  /**
   * 写入的编码。默认 utf8。
   * 二进制（如导出图片）要传 null，此时 content 必须是 Buffer。
   */
  encoding?: BufferEncoding | null
}

/**
 * 原子写。同一路径的并发调用会按调用顺序串行执行。
 *
 * 抛出的异常**不吞**：调用方需要知道写失败了（比如归档索引写不进去，
 * 就得告诉用户），但队列不会被它卡住。
 */
export function atomicWriteFile(
  target: string,
  content: string | Buffer,
  options: AtomicWriteOptions = {}
): Promise<void> {
  return enqueue(target, async () => {
    const encoding = options.encoding === undefined ? 'utf8' : options.encoding
    sequence += 1
    /*
     * tmp 名字里带 pid 与序号。
     * 带 pid：多个实例（开发时同时跑 dev 与打包版）不会互撞。
     * 带序号：串行队列被绕过时（不同进程）仍然不会用同一个 tmp。
     */
    const tmp = `${target}.${process.pid}.${sequence}.tmp`
    await fsp.mkdir(path.dirname(target), { recursive: true })
    try {
      if (encoding === null) await fsp.writeFile(tmp, content as Buffer)
      else await fsp.writeFile(tmp, content as string, encoding)
      await fsp.rename(tmp, target)
    } catch (err) {
      // 失败时清掉本次的 tmp，否则会一直在目录里累积
      await fsp.rm(tmp, { force: true }).catch(() => undefined)
      throw err
    }
  })
}

/**
 * 生成一个「内容 hash」用的短串。
 *
 * 放在这里是因为它和原子写经常一起用（写出去的内容顺便算个指纹，
 * 用于「文件有没有被外部改过」的比较）。纯函数，没有副作用。
 */
export function contentHash(text: string): string {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex')
}

/**
 * 等所有排队中的写完成。**只给测试与退出流程用**。
 *
 * 正常代码路径不该调它：那等于把「后台写」变回「同步写」。
 * 退出时调是为了别把最后几次写丢掉。
 */
export async function drainWrites(): Promise<void> {
  // 反复等到链上不再有新增（写操作里不会再触发写，所以两轮就够）
  for (let i = 0; i < 3; i++) {
    const pending = [...chains.values()]
    if (pending.length === 0) return
    await Promise.allSettled(pending)
    // 链已经被新任务替换过就再等一轮
    const stillSame = [...chains.values()].every((item, index) => item === pending[index])
    if (stillSame) return
  }
}
