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
  const entries = Object.entries(aiAnalysis)
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
            <span className="mono text-[9px] text-[var(--text2)]">({entries.length})</span>
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
          {entries.map(([svcId, analysis]) => {
            const svc = services.find(s => s.id === svcId)
            if (!svc) return null
            const isResolved = svc.status === 'operational'
            const hasActiveInc = (svc.incidents ?? []).some(i => i.status !== 'resolved' && i.id === analysis.incidentId)

            return (
              <div key={svcId} className="bg-[var(--bg2)] rounded-lg" style={{ padding: '12px 14px', marginBottom: '10px', opacity: isResolved && !hasActiveInc ? 0.6 : 1 }}>
                <div className="flex items-center gap-2" style={{ marginBottom: '8px' }}>
                  <span className="w-[6px] h-[6px] rounded-full" style={{ background: isResolved ? 'var(--green)' : svc.status === 'down' ? 'var(--red)' : 'var(--amber)' }} />
                  <span className="text-[13px] font-medium text-[var(--text0)]">{svc.name}</span>
                  {isResolved && !hasActiveInc && (
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
