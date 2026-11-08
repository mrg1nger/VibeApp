import { useState } from 'react'

/** The written usage report (by project, the Claude/Codex split, the most expensive requests), opened on demand. */
function UsageReport() {
  const [days, setDays] = useState(7)
  const [report, setReport] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [copied, setCopied] = useState(false)

  const load = (span: number): void => {
    setDays(span)
    setLoading(true)
    window.vibe.usage
      .report(span)
      .then(setReport)
      .catch((err: Error) => setReport(`Couldn't make the report: ${err.message}`))
      .finally(() => setLoading(false))
  }

  return (
    <details className="usage-report" onToggle={(e) => (e.currentTarget.open && report === null ? load(days) : undefined)}>
      <summary>Detailed report: by project, and how Claude and Codex shared the work</summary>
      <div className="usage-report-actions">
        {[1, 7, 30].map((span) => (
          <button key={span} className={span === days ? 'active' : ''} onClick={() => load(span)} disabled={loading}>
            {span === 1 ? 'Today' : `${span} days`}
          </button>
        ))}
        <button
          onClick={() => {
            if (!report) return
            void navigator.clipboard.writeText(report).then(() => {
              setCopied(true)
              setTimeout(() => setCopied(false), 1500)
            })
          }}
          disabled={!report}
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      {loading && <p className="memory-hint">Loading…</p>}
      {report && !loading && <pre className="usage-report-text">{report}</pre>}
    </details>
  )
}

export default UsageReport
