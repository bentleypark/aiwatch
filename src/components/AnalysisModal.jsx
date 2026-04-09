// AI Analysis Modal — shows incident analysis results from Claude
import { useLang } from '../hooks/useLang'
import { getFallbacks } from '../utils/constants'

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
  // Group by service, then dedup shared incidentIds across sibling services
  // aiAnalysis: Record<svcId, AIAnalysisResult[]>
  // Result: array of { svcIds, analyses[] } — one entry per service group
  const seenIncidents = new Set() // dedup shared incidentIds across services
  const groups = [] // { svcIds: string[], analyses: analysis[], startedAt }
  for (const [svcId, rawAnalyses] of Object.entries(aiAnalysis)) {
    const arr = Array.isArray(rawAnalyses) ? rawAnalyses : [rawAnalyses]
    const validAnalyses = arr.filter(a => {
      const incId = a.incidentId ?? svcId
      if (seenIncidents.has(incId)) return false
      seenIncidents.add(incId)
      return true
    })
    if (validAnalyses.length === 0) continue
    // Check if another group already covers this service (shared incidentId → merge svcIds)
    const existingGroup = groups.find(g =>
      g.analyses.some(a => validAnalyses.some(v => v.incidentId === a.incidentId))
    )
    if (existingGroup) {
      if (!existingGroup.svcIds.includes(svcId)) existingGroup.svcIds.push(svcId)
    } else {
      const svc = services.find(s => s.id === svcId)
      const earliestInc = validAnalyses.reduce((earliest, a) => {
        const inc = svc?.incidents?.find(i => i.id === a.incidentId)
        const t = inc?.startedAt ?? a.analyzedAt ?? ''
        return t < earliest ? t : earliest
      }, validAnalyses[0].analyzedAt ?? '')
      groups.push({ svcIds: [svcId], analyses: validAnalyses, startedAt: earliestInc })
    }
  }
  groups.sort((a, b) => b.startedAt.localeCompare(a.startedAt))
  if (groups.length === 0) return null

  const totalCount = groups.reduce((sum, g) => sum + g.analyses.length, 0)

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
            <span className="mono text-[9px] text-[var(--text2)]">({totalCount})</span>
          </div>
          <button
            onClick={onClose}
            className="mono text-[11px] text-[var(--text1)] bg-[var(--bg2)] border border-[var(--border)] rounded hover:opacity-80 transition-opacity cursor-pointer"
            style={{ padding: '4px 10px' }}
          >
            ✕ {t('modal.close')}
          </button>
        </div>

        {/* Analysis entries — grouped by service */}
        <div style={{ padding: '16px' }}>
          {groups.map(({ svcIds, analyses }) => {
            const svcs = svcIds.map(id => services.find(s => s.id === id)).filter(Boolean)
            if (svcs.length === 0) return null
            const worstStatus = svcs.some(s => s.status === 'down') ? 'down'
              : svcs.some(s => s.status !== 'operational') ? 'degraded' : 'operational'
            const isAllResolved = svcs.every(s => s.status === 'operational')
            const hasActiveInc = svcs.some(s => (s.incidents ?? []).some(i => i.status !== 'resolved'))
            const allRecovered = analyses.every(a => !!a.resolvedAt)

            return (
              <div key={svcIds.join(',')} className="bg-[var(--bg2)] rounded-lg" style={{ padding: '12px 14px', marginBottom: '10px', opacity: isAllResolved && !hasActiveInc && !allRecovered ? 0.6 : 1 }}>
                {/* Service header */}
                <div className="flex items-center gap-2 flex-wrap" style={{ marginBottom: analyses.length > 1 ? '6px' : '8px' }}>
                  <span className="w-[6px] h-[6px] rounded-full" style={{ background: worstStatus === 'operational' ? 'var(--green)' : worstStatus === 'down' ? 'var(--red)' : 'var(--amber)' }} />
                  <span className="text-[13px] font-medium text-[var(--text0)]">{svcs.map(s => s.name).join(', ')}</span>
                  {analyses.length > 1 && (
                    <span className="mono text-[9px] text-[var(--text2)]">({analyses.length} {lang === 'ko' ? '건' : 'incidents'})</span>
                  )}
                  {(allRecovered || (isAllResolved && !hasActiveInc)) && (
                    <span className="mono text-[9px] rounded" style={{ color: 'var(--green)', background: 'var(--status-bg-green)', padding: '3px 8px', display: 'inline-block' }}>
                      Resolved
                    </span>
                  )}
                </div>

                {/* Incident analyses */}
                {analyses.map((analysis, idx) => {
                  const inc = svcs.flatMap(s => s.incidents ?? []).find(i => i.id === analysis.incidentId)
                  const isRecovered = !!analysis.resolvedAt
                  return (
                    <div key={analysis.incidentId ?? idx} style={analyses.length > 1 ? { borderTop: idx > 0 ? '1px solid var(--border)' : 'none', paddingTop: idx > 0 ? '8px' : '0', marginTop: idx > 0 ? '8px' : '0' } : {}}>
                      {/* Incident title — only when multiple incidents */}
                      {analyses.length > 1 && inc && (
                        <div className="mono text-[10px] text-[var(--text2)] font-medium" style={{ marginBottom: '4px' }}>
                          {isRecovered ? '✅' : '🔸'} {inc.title}
                        </div>
                      )}
                      <p className="text-[12px] text-[var(--text1)]" style={{ lineHeight: 1.6, marginBottom: '8px' }}>
                        {(analysis.summary ?? '').slice(0, 500)}
                      </p>
                      <div className="mono text-[10px] text-[var(--text2)]" style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                        <span>⏱ <strong style={{ color: 'var(--text1)' }}>{lang === 'ko' ? '예상 복구' : 'Est. Recovery'}:</strong> {analysis.estimatedRecovery === 'No historical data for estimation'
                          ? (lang === 'ko' ? '복구 신호 모니터링 중...' : 'Monitoring recovery signals...')
                          : analysis.estimatedRecovery}
                        </span>
                        {analysis.affectedScope?.length > 0 && (
                          <span>📡 <strong style={{ color: 'var(--text1)' }}>{lang === 'ko' ? '영향 범위' : 'Scope'}:</strong> {analysis.affectedScope.join(', ')}</span>
                        )}
                        {isRecovered && <span>✅ {t('analysis.recoveredAt')}: {timeAgo(analysis.resolvedAt, lang)}</span>}
                        <span>🕐 {lang === 'ko' ? '분석 업데이트' : 'Analysis updated'} {timeAgo(analysis.analyzedAt, lang)}</span>
                      </div>
                      {/* Contextual fallback recommendation */}
                      {analysis.needsFallback && !isRecovered && (() => {
                        const primarySvc = svcs[0]
                        const fallbacks = getFallbacks(primarySvc, services)
                        return (
                          <div className="mono text-[10px]" style={{ marginTop: '8px', padding: '8px 10px', background: 'var(--bg1)', borderRadius: '6px', borderLeft: '3px solid var(--amber)' }}>
                            <span style={{ color: 'var(--text1)', fontWeight: 600 }}>🔄 {lang === 'ko' ? '대안 서비스' : 'Alternatives'}</span>
                            {fallbacks.length > 0 ? (
                              <div style={{ marginTop: '4px', display: 'flex', flexDirection: 'column', gap: '3px' }}>
                                {fallbacks.map(f => (
                                  <span key={f.id} style={{ color: 'var(--text1)' }}>
                                    • {f.name}{f.aiwatchScore != null ? ` (Score: ${f.aiwatchScore})` : ''}
                                  </span>
                                ))}
                              </div>
                            ) : (
                              <div style={{ marginTop: '4px', color: 'var(--text2)' }}>
                                {lang === 'ko' ? '현재 운영 중인 대안 서비스가 없습니다' : 'No operational alternatives currently available'}
                              </div>
                            )}
                          </div>
                        )
                      })()}
                    </div>
                  )
                })}
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
