import { useEffect, useState } from 'react'
import type { DoctorReport } from '@shared/types'

export default function DoctorDialog({ onClose }: { onClose: () => void }): JSX.Element {
  const [report, setReport] = useState<DoctorReport | null>(null)

  useEffect(() => {
    void window.api.doctor().then(setReport)
  }, [])

  return (
    <div className="overlay" onClick={onClose}>
      <div className="dialog" onClick={(e) => e.stopPropagation()}>
        <h2>运行环境体检</h2>
        {!report && <div className="hint">检测中…</div>}
        {report && (
          <div className="report">
            {report.checks.map((check) => (
              <div className="row" key={check.id}>
                <span className={`tag ${check.status}`}>
                  {check.status === 'pass' ? '正常' : check.status === 'warn' ? '注意' : '异常'}
                </span>
                <span style={{ flex: 'none', width: 140 }}>{check.label}</span>
                <span className="detail">{check.detail}</span>
              </div>
            ))}
          </div>
        )}
        <div className="hint" style={{ marginTop: 12 }}>
          如启动异常，请把这份结果连同日志文件一起反馈。日志目录：
          {report?.runtime.logsPath || '%APPDATA%\\AIEditor\\logs'}
        </div>
        <div className="actions">
          <button onClick={() => void window.api.openLogs()}>打开日志目录</button>
          <button onClick={onClose}>关闭</button>
        </div>
      </div>
    </div>
  )
}
