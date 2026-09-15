import { useCallback, useEffect, useRef, useState } from 'react'
import { extOf } from '../store/useAppStore'

/**
 * 内嵌 HTML 预览面板。
 *
 * ## 为什么用 iframe 而不是 <webview> / BrowserView
 *
 * Electron 里三种都行，但代价不同：
 *   - `<webview>` 官方标记为「不推荐、行为不稳定」，且需要开
 *     `webviewTag: true`（等于给渲染层多开一个攻击面）
 *   - `BrowserView` 是**独立进程 + 主进程手动同步坐标**。这个项目里
 *     拖分割条时每帧都在改宽度，坐标同步会让拖动明显掉帧 ——
 *     而 `useSplitter` 特意做了「拖动期间不 setState」就是为了避开这个
 *   - `<iframe>` 同进程、无坐标同步、跟着 CSS 自然布局
 *
 * 代价是 iframe 里是普通网页环境（没有 Node 集成）。但**预览 HTML
 * 本来就不需要** —— 学生的页面要的就是浏览器环境。
 *
 * ## 为什么不是 srcDoc
 *
 * 用 `srcDoc` 塞 HTML 源码的话，页面里的 `./style.css`、`./main.js`
 * 全都加载不了（没有基准路径），学生看到的是「没样式也没反应」的页面。
 * 所以走主进程已有的临时静态服务（把工作区当根目录），
 * 相对路径就正常了 —— 那套服务本来是为「交系统浏览器预览」写的，直接复用。
 *
 * ## 自动刷新
 *
 * 文件变化事件（AI 改的、学生存的）到达时重设 iframe 的 src。
 * 带时间戳参数绕开缓存，否则浏览器会拿旧页面糊弄人。
 */

/** 哪些文件能内嵌预览。与主进程 canPreview 保持一致（只有 HTML） */
export function canPreviewFile(path: string): boolean {
  if (!path) return false
  return ['html', 'htm'].includes(extOf(path))
}

export default function PreviewPane({
  path,
  onClose
}: {
  /** 要预览的文件绝对路径。空串表示没有可预览的文件 */
  path: string
  onClose: () => void
}): JSX.Element {
  const [url, setUrl] = useState('')
  const [error, setError] = useState('')
  /** 每次刷新自增，用来强制 iframe 重新加载（见 reload） */
  const [nonce, setNonce] = useState(0)
  const iframeRef = useRef<HTMLIFrameElement | null>(null)

  /** 取（或重新取）预览 URL。主进程的 serveOnce 每次都会带新的时间戳 */
  const load = useCallback(async (): Promise<void> => {
    if (!path) {
      setUrl('')
      return
    }
    try {
      const next = await window.api.previewUrl(path)
      setUrl(next)
      setError('')
    } catch (err) {
      setUrl('')
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [path])

  // 切换预览目标时重新取 URL
  useEffect(() => {
    void load()
  }, [load])

  /**
   * 文件变化 → 自动刷新。
   *
   * 只对**当前正在预览的这个文件**刷新：别的文件变了不该让预览闪一下。
   * 另外 AI 改文件通常触发多次事件（写 .tmp + rename），
   * 所以拖一个 150ms 的防抖，否则会连着重载好几次。
   */
  useEffect(() => {
    if (!path) return
    let timer: number | null = null
    const off = window.api.onFileChanged((event) => {
      if (event.path !== path) return
      if (timer !== null) window.clearTimeout(timer)
      timer = window.setTimeout(() => {
        timer = null
        setNonce((n) => n + 1)
      }, 150)
    })
    return () => {
      off()
      if (timer !== null) window.clearTimeout(timer)
    }
  }, [path])

  return (
    <section className="preview-pane" aria-label="页面预览">
      <div className="preview-head">
        <span className="preview-title" title={path}>
          预览：{path.split(/[\\/]/).filter(Boolean).pop() || '（未选择）'}
        </span>
        <span className="spacer" />
        <button className="ghost btn-xs" onClick={() => void load()} title="重新加载">
          刷新
        </button>
        <button
          className="ghost btn-xs"
          title="在系统浏览器里打开（相对路径同样能加载）"
          onClick={() => void window.api.previewInBrowser(path)}
        >
          在浏览器中打开
        </button>
        <button className="ghost btn-xs" aria-label="关闭预览" onClick={onClose}>
          关闭
        </button>
      </div>

      {error ? (
        <div className="preview-empty">
          <div className="muted">预览失败：{error}</div>
          <div className="muted">如果文件被移动或删除了，关掉预览重开一次。</div>
        </div>
      ) : !url ? (
        <div className="preview-empty">
          <div className="muted">
            在文件树里右键一个 HTML 文件 → 「在预览面板中打开」，
            或在编辑器里打开 HTML 后点顶栏的预览按钮。
          </div>
        </div>
      ) : (
        /*
         * key 带 nonce：改 key 会让 React 重建 iframe，
         * 这比改 src 更可靠 —— 某些情况下同源同 URL 的 src 变化
         * 不会触发重新加载。
         */
        <iframe
          key={`${url}-${nonce}`}
          ref={iframeRef}
          className="preview-frame"
          src={url}
          title="页面预览"
          // 预览的是学生自己的代码，需要脚本运行；但不给它任何特权
          sandbox="allow-scripts allow-forms allow-modals allow-popups allow-same-origin"
        />
      )}
    </section>
  )
}
