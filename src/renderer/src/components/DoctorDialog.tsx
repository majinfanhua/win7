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
        {/*
          开发运行时清单。
          没装 python / node 不算「体检不通过」—— 它只是能力清单，
          所以不复用上面那套「正常/注意/异常」标签。
          这一段也是 AI 判断用哪个解释器的依据（见 runtimes.ts）。
        */}
        {report && (
          <div className="runtime-block">
            <div className="runtime-title">本机开发环境</div>
            {report.runtimes.length === 0 ? (
              <div className="hint">
                没有探测到 python / node 等运行时。学生要跑脚本的话需要先安装，
                装完重启本应用即可重新探测。
              </div>
            ) : (
              <div className="runtime-list">
                {report.runtimes.map((item) => (
                  <div className="runtime-row" key={item.name}>
                    <span className="runtime-name">{item.name}</span>
                    <span className="runtime-version">{item.version || '版本未知'}</span>
                    <span className="runtime-path" title={item.path}>
                      {item.path}
                    </span>
                  </div>
                ))}
              </div>
            )}
            <div className="hint">
              这些信息会随每次提问一起告诉 AI，它就能直接选对解释器，
              不用靠试错。
            </div>
          </div>
        )}

        <div className="hint" style={{ marginTop: 12 }}>
          如启动异常，请把这份结果连同日志文件一起反馈。日志目录：
          {report?.runtime.logsPath || '%APPDATA%\\hangkeIDE\\logs'}
        </div>
        <div className="actions">
          <button onClick={() => void window.api.openLogs()}>打开日志目录</button>
          <button onClick={onClose}>关闭</button>
        </div>
      </div>
    </div>
  )
}
