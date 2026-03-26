// AI Analysis Modal — shows incident analysis results from Claude
import { useLang } from '../hooks/useLang'

function timeAgo(date, lang) {
  const diff = Date.now() - new Date(date).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return lang === 'ko' ? '방금 전' : 'just now'
  if (mins < 60) return lang === 'ko' ? `${mins}분 전` : `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  return lang === 'ko' ? `${hrs}시간 전` : `${hrs}h ago`
}

export default function AnalysisModal({ aiAnalysis, services, onClose }) {
  const { t, lang } = useLang()
  // Group by incidentId to avoid duplicate analysis cards for shared incidents
  const grouped = new Map() // incidentId → { analysis, svcIds: [], startedAt }
  for (const [svcId, analysis] of Object.entries(aiAnalysis)) {
    const incId = analysis.incidentId ?? svcId
    if (grouped.has(incId)) {
      grouped.get(incId).svcIds.push(svcId)
    } else {
      const svc = services.find(s => s.id === svcId)
      const inc = svc?.incidents?.find(i => i.id === analysis.incidentId)
      grouped.set(incId, {
        analysis,
        svcIds: [svcId],
        startedAt: inc?.startedAt ?? analysis.analyzedAt ?? '',
      })
    }
  }
  const entries = [...grouped.values()]
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
  if (entries.length === 0) return null

  return (
    <div className="fixed inset-0 z-[300] flex items-center justify-center bg-black/60" onClick={onClose}>
      <div
        className="bg-[var(--bg1)] border border-[var(--border-hi)] rounded-lg w-full max-w-[480px] mx-4"
        style={{ maxHeight: '80vh', overflow: 'auto' }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-[var(--border)]" style={{ padding: '14px 16px' }}>
          <div className="flex items-center gap-2">
            <span style={{ fontSize: '16px' }}>🤖</span>
            <span className="mono text-[12px] font-medium text-[var(--text0)]">AI Analysis</span>
            <span className="mono text-[9px] rounded" style={{ color: 'var(--purple)', background: 'rgba(124,58,237,0.15)', padding: '2px 6px' }}>Beta</span>
            <span className="mono text-[9px] text-[var(--text2)]">({Object.keys(aiAnalysis).length})</span>
          </div>
          <button
            onClick={onClose}
            className="mono text-[11px] text-[var(--text1)] bg-[var(--bg2)] border border-[var(--border)] rounded hover:opacity-80 transition-opacity cursor-pointer"
            style={{ padding: '4px 10px' }}
          >
            ✕ {t('modal.close')}
          </button>
        </div>

        {/* Analysis entries */}
        <div style={{ padding: '16px' }}>
          {entries.map(({ analysis, svcIds }) => {
            const svcs = svcIds.map(id => services.find(s => s.id === id)).filter(Boolean)
            if (svcs.length === 0) return null
            const worstStatus = svcs.some(s => s.status === 'down') ? 'down'
              : svcs.some(s => s.status !== 'operational') ? 'degraded' : 'operational'
            const isAllResolved = svcs.every(s => s.status === 'operational')
            const hasActiveInc = svcs.some(s => (s.incidents ?? []).some(i => i.status !== 'resolved'))

            return (
              <div key={svcIds.join(',')} className="bg-[var(--bg2)] rounded-lg" style={{ padding: '12px 14px', marginBottom: '10px', opacity: isAllResolved && !hasActiveInc ? 0.6 : 1 }}>
                <div className="flex items-center gap-2 flex-wrap" style={{ marginBottom: '8px' }}>
                  <span className="w-[6px] h-[6px] rounded-full" style={{ background: worstStatus === 'operational' ? 'var(--green)' : worstStatus === 'down' ? 'var(--red)' : 'var(--amber)' }} />
                  <span className="text-[13px] font-medium text-[var(--text0)]">{svcs.map(s => s.name).join(', ')}</span>
                  {isAllResolved && !hasActiveInc && (
                    <span className="mono text-[9px] px-1.5 py-0.5 rounded bg-[var(--status-bg-green)] text-[var(--green)]">Resolved</span>
                  )}
                </div>
                <p className="text-[12px] text-[var(--text1)]" style={{ lineHeight: 1.6, marginBottom: '8px' }}>
                  {(analysis.summary ?? '').slice(0, 500)}
                </p>
                <div className="flex flex-wrap gap-3 mono text-[10px] text-[var(--text2)]">
                  <span>⏱ {analysis.estimatedRecovery === 'No historical data for estimation'
                    ? (lang === 'ko' ? '복구 신호 모니터링 중...' : 'Monitoring recovery signals...')
                    : analysis.estimatedRecovery}
                  </span>
                  {analysis.affectedScope?.length > 0 && (
                    <span>📡 {analysis.affectedScope.join(', ')}</span>
                  )}
                  <span>🕐 {timeAgo(analysis.analyzedAt, lang)}</span>
                </div>
              </div>
            )
          })}
        </div>

        {/* Disclaimer */}
        <div className="border-t border-[var(--border)]" style={{ padding: '10px 16px' }}>
          <p className="mono text-[9px] text-[var(--text2)]" style={{ lineHeight: 1.5, opacity: 0.7 }}>
            ⚠️ AI-generated estimation based on historical data. Actual recovery time may vary.
            This analysis is provided for informational purposes only.
          </p>
        </div>
      </div>
    </div>
  )
}
