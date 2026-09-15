import { useEffect, useRef } from 'react'
import type { LogLine } from '@shared/types'
import { useAppStore } from '../store/useAppStore'

/**
 * 底部日志抽屉。
 *
 * 为什么必须有它：主进程的 `pushLog` 一路写进 store 的 `logs`（500 条环形缓冲），
 * `dormant.css` 里 `.logs` 的配色也早就写好了，**但整条链路上没有任何消费者** ——
 * 渲染层从来没订阅过 `onLog`，store 里的 logs 也从来没人渲染。
 *
 * 这不只是「少了个便利功能」，而是让一条安全机制静默失效：
 * `store.handleFileChanged()` 在「磁盘上的文件被改过，但编辑器里有未保存改动」
 * 那个分支里只做一件事 —— pushLog 一条 warn，明确告诉学生「已保留你的版本」。
 * 而那条 warn 没有任何地方会显示出来，学生遇到冲突时界面上**什么都不会发生**。
 *
 * 所以这个抽屉是那条警告的落点，不是可有可无的调试面板。
 *
 * 实现上刻意从简：不做虚拟滚动。500 条纯文本 div 在 Win7 上渲染没问题，
 * 而引入虚拟列表的复杂度与收益完全不成比例。
 */
export default function LogDrawer({ onClose }: { onClose: () => void }): JSX.Element {
  const logs = useAppStore((s) => s.logs)
  const clearLogs = useAppStore((s) => s.clearLogs)
  const scrollRef = useRef<HTMLDivElement | null>(null)

  // 新日志到达时滚到底。和对话区一样：停下来看历史时不该被拽走，
  // 但这里日志是「一直在追加」的，跟随底部才是默认预期
  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [logs])

  const warns = logs.filter((line) => line.level === 'warn' || line.level === 'error').length

  return (
    <section className="log-drawer" aria-label="日志">
      <div className="log-head">
        <span className="log-title">日志</span>
        <span className="muted log-count">
          共 {logs.length} 条{warns > 0 ? `，其中警告 / 错误 ${warns} 条` : ''}
        </span>
        <span className="spacer" />
        <button className="ghost btn-xs" onClick={() => void window.api.openLogs()}>
          打开日志目录
        </button>
        <button className="ghost btn-xs" onClick={clearLogs} disabled={logs.length === 0}>
          清空
        </button>
        <button className="ghost btn-xs" aria-label="关闭日志" onClick={onClose}>
          关闭
        </button>
      </div>

      <div className="logs" ref={scrollRef}>
        {logs.length === 0 ? (
          <div className="muted">还没有日志。AI 改动文件、保存失败、模板写入失败等都会出现在这里。</div>
        ) : (
          logs.map((line, index) => <LogRow key={index} line={line} />)
        )}
      </div>
    </section>
  )
}

/**
 * 一行日志。
 *
 * key 用 index 是刻意的：日志是只追加的，没有稳定 id，
 * 而带上 index 后 React 只会为新行建节点，已有行原地复用。
 * 用 `${time}-${text}` 这类合成 key 反而会在同一秒出现两条相同日志时撞车。
 */
function LogRow({ line }: { line: LogLine }): JSX.Element {
  return (
    <div className={line.level}>
      <span className="log-time">{line.time}</span>
      <span className="log-scope">[{line.scope}]</span>
      <span className="log-text">{line.text}</span>
    </div>
  )
}
