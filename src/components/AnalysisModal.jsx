// AI Analysis Modal — shows incident analysis results from Claude
import { useLang } from '../hooks/useLang'
import { isDisplayAffected, displayStatusOf } from '../utils/statusDisplay'
import { getGroupedFallbacks, shouldShowFallback } from '../utils/constants'
import { computePredictionOutcome, verdictLabel, estimateExceeded, exceededRecoveryText } from '../utils/predictionAccuracy'
import { hasLiveIncident, readsResolved } from '../utils/liveIncident'

function timeAgo(date, lang) {
  const diff = Date.now() - new Date(date).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return lang === 'ko' ? '방금 전' : 'just now'
  if (mins < 60) return lang === 'ko' ? `${mins}분 전` : `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  return lang === 'ko' ? `${hrs}시간 전` : `${hrs}h ago`
}

/** #1233 — the worst DISPLAY state across a grouped incident's services.
 *
 *  Three outcomes, not two. The old form asked `some(s => s.status !== 'operational') ? 'degraded'`,
 *  which labelled an unreadable source as an outage; replacing that test alone left an all-unreadable
 *  group falling through to `'operational'` and rendering GREEN — trading a false outage for a false
 *  all-clear. Every arm reads the DISPLAY state, so this cannot disagree with the pill beside it.
 *
 *  Exported because it was previously an inline ternary inside the render, which no test could reach. */
export function groupWorstStatus(svcs) {
  if (svcs.some(s => displayStatusOf(s) === 'down')) return 'down'
  if (svcs.some(isDisplayAffected)) return 'degraded'
  if (svcs.some(s => displayStatusOf(s) === 'unknown')) return 'unknown'
  return 'operational'
}

export default function AnalysisModal({ aiAnalysis, services, onClose }) {
  const { t, lang } = useLang()
  // aiAnalysis: Record<svcId, AIAnalysisResult[]>
  //
  // Two-pass grouping (avoids cross-service bleed — see #315):
  //   Pass 1: bucket by incidentId to collect which svcIds each incident affects.
  //           Sibling services sharing an incident (e.g. Claude API + claude.ai + Claude Code
  //           pointing at the same incidentId) collapse into one bucket here.
  //   Pass 2: a multi-svc bucket becomes its own card. Single-svc buckets for the same svcId
  //           merge into a single card so the service header and fallback block render once
  //           even when a service has multiple distinct incidents (e.g. Together AI with two
  //           concurrent model outages).
  const byIncident = new Map()
  for (const [svcId, rawAnalyses] of Object.entries(aiAnalysis)) {
    const arr = Array.isArray(rawAnalyses) ? rawAnalyses : [rawAnalyses]
    for (const a of arr) {
      const incId = a.incidentId ?? svcId
      const bucket = byIncident.get(incId)
      if (bucket) {
        if (!bucket.svcIds.includes(svcId)) bucket.svcIds.push(svcId)
        continue
      }
      const svc = services.find(s => s.id === svcId)
      const inc = svc?.incidents?.find(i => i.id === incId)
      byIncident.set(incId, {
        incId,
        svcIds: [svcId],
        analysis: a,
        startedAt: inc?.startedAt ?? a.analyzedAt ?? '',
      })
    }
  }

  const groups = []
  const singleSvcGroupByOwner = new Map() // svcId → group
  for (const bucket of byIncident.values()) {
    if (bucket.svcIds.length > 1) {
      groups.push({
        svcIds: bucket.svcIds,
        incIds: new Set([bucket.incId]),
        analyses: [bucket.analysis],
        startedAt: bucket.startedAt,
      })
      continue
    }
    const ownerSvcId = bucket.svcIds[0]
    const existing = singleSvcGroupByOwner.get(ownerSvcId)
    if (existing) {
      existing.incIds.add(bucket.incId)
      existing.analyses.push(bucket.analysis)
      // Keep the card anchored to the most recent incident in the group so sort places
      // freshly erupting issues above long-running ones.
      if (bucket.startedAt && bucket.startedAt > existing.startedAt) {
        existing.startedAt = bucket.startedAt
      }
    } else {
      const g = {
        svcIds: [ownerSvcId],
        incIds: new Set([bucket.incId]),
        analyses: [bucket.analysis],
        startedAt: bucket.startedAt,
      }
      singleSvcGroupByOwner.set(ownerSvcId, g)
      groups.push(g)
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
            const worstStatus = groupWorstStatus(svcs)
            const isAllResolved = svcs.every(s => s.status === 'operational')
            // #1104 — the shared primitive, not a fourth hand-inlined copy of the same predicate.
            // Its guard shape (`Array.isArray`) also differs from the `?? []` this line used to carry,
            // and two copies that disagree on a malformed payload is the drift `liveIncident` exists
            // to remove.
            const hasActiveInc = svcs.some(hasLiveIncident)
            // #1104 — "every ANALYSIS on this card is resolved". Still the right input for the three
            // uses below (they ask about the analyses), but NOT for the Resolved pill, which is a claim
            // about the SERVICE — see `readsResolved` in utils/liveIncident.
            const allRecovered = analyses.every(a => !!a.resolvedAt)
            // Surface the gap between the operational status dot and active analyses
            // (e.g. BetterStack per-model churn below the <30% threshold leaves the service
            // operational while individual model incidents are still being analyzed).
            // Restrict to single-service groups — a sibling-shared incident that happens to
            // show operational on every surface is a real cross-service incident, not an
            // isolated one.
            //
            // #1104 — ALSO fire on a live INCIDENT, not just a live analysis. This modal draws from
            // `aiAnalysis` alone, so an incident with no analysis yet has no row here at all. Dropping
            // the "Resolved" pill for it (correct — the service is not resolved) would otherwise leave
            // the card with nothing at all to show the reader WHY, and it would keep reading as
            // "recovered" off the resolved analysis in its body. Same chip, same meaning: the service
            // reads operational while something of its own is still open.
            // (`!allRecovered` IS `analyses.some(a => !a.resolvedAt)` — the two were one condition
            // written twice, and it is the branch that cannot see an un-analyzed incident.)
            const isolatedModelIssue = svcs.length === 1
              && isAllResolved
              && (hasActiveInc || !allRecovered)
            // Gate on service status (not the AI's needsFallback flag) so this
            // matches the Overview ActionBanner, which shows fallbacks for any
            // down/degraded service. The AI may mark partial degradation as
            // needsFallback:false, which previously hid recommendations here
            // while Overview still showed them (#454).
            const showFallback = shouldShowFallback(svcs, allRecovered)
            // Per-category alternatives across every affected service in the group
            // (a multi-service incident spans LLM + agent + app categories), not just
            // the first service's category (#445).
            const fallbackGroups = showFallback ? getGroupedFallbacks(svcs, services) : []

            return (
              <div key={svcIds.join(',')} className="bg-[var(--bg2)] rounded-lg" style={{ padding: '12px 14px', marginBottom: '10px', opacity: isAllResolved && !hasActiveInc && !allRecovered ? 0.6 : 1 }}>
                {/* Service header */}
                <div className="flex items-center gap-2 flex-wrap" style={{ marginBottom: analyses.length > 1 ? '6px' : '8px' }}>
                  <span className="w-[6px] h-[6px] rounded-full" style={{ background: worstStatus === 'operational' ? 'var(--green)' : worstStatus === 'down' ? 'var(--red)' : worstStatus === 'unknown' ? 'var(--text2)' : 'var(--amber)' }} />
                  <span className="text-[13px] font-medium text-[var(--text0)]">{svcs.map(s => s.name).join(', ')}</span>
                  {analyses.length > 1 && (
                    <span className="mono text-[9px] text-[var(--text2)]">({analyses.length} {lang === 'ko' ? '건' : 'incidents'})</span>
                  )}
                  {readsResolved(svcs) && (
                    <span className="mono text-[9px] rounded" style={{ color: 'var(--green)', background: 'var(--status-bg-green)', padding: '3px 8px', display: 'inline-block' }}>
                      Resolved
                    </span>
                  )}
                  {isolatedModelIssue && (
                    <span
                      className="mono text-[9px] rounded"
                      style={{ color: 'var(--amber)', background: 'var(--status-bg-amber)', padding: '3px 8px', display: 'inline-block' }}
                      title={lang === 'ko'
                        ? '서비스 전체는 정상이지만 일부 모델/컴포넌트에서 이슈가 감지되었습니다'
                        : 'Service operational — isolated model/component issues detected'}
                    >
                      {lang === 'ko' ? '부분 이슈' : 'Isolated issue'}
                    </span>
                  )}
                </div>

                {/* Incident analyses */}
                {analyses.map((analysis, idx) => {
                  const inc = svcs.flatMap(s => s.incidents ?? []).find(i => i.id === analysis.incidentId)
                  const isRecovered = !!analysis.resolvedAt
                  // #827 F4 — predicted vs actual once resolved (null until then or if not derivable)
                  const outcome = computePredictionOutcome(analysis, inc)
                  const outcomeVerdict = outcome && verdictLabel(outcome.verdict, lang)
                  // #827 F4 — which model produced this analysis (Gemma primary / Sonnet fallback)
                  const modelLabel = analysis.model === 'gemma' ? 'Gemma' : analysis.model === 'sonnet' ? 'Sonnet' : null
                  return (
                    <div key={analysis.incidentId ?? idx} style={analyses.length > 1 ? { borderTop: idx > 0 ? '1px solid var(--border)' : 'none', paddingTop: idx > 0 ? '8px' : '0', marginTop: idx > 0 ? '8px' : '0' } : {}}>
                      {/* Incident title — only when multiple incidents */}
                      {analyses.length > 1 && inc && (
                        <div className="mono text-[10px] text-[var(--text2)] font-medium" style={{ marginBottom: '4px' }}>
                          {isRecovered ? '✅' : '🔸'} {inc.title}
                        </div>
                      )}
                      {/* #1328 — `summary` is the durable half (what was wrong); `progress` is where
                          the incident stood when the analysis ran. Nothing rewrites the prose at
                          resolution — `markIncidentResolved` stamps `resolvedAt` and returns — so a
                          resolved row used to read "currently in the initial investigation stage with
                          no improvement reported yet" directly under its own Resolved badge. Dropping
                          only the perishable half keeps the answer to "what was this outage about",
                          which the structured lines below do not carry. Absent on older analyses. */}
                      {/* The 500 cap is on the PAIR, not each half — slicing them separately would
                          quietly double the bound a live row renders. */}
                      <p className="text-[12px] text-[var(--text1)]" style={{ lineHeight: 1.6, marginBottom: '8px' }}>
                        {[analysis.summary, !isRecovered && analysis.progress].filter(Boolean).join(' ').slice(0, 500)}
                      </p>
                      <div className="mono text-[10px] text-[var(--text2)]" style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                        {outcome ? (
                          // #827 F4 — resolved: show our estimate vs what actually happened (richer than the bare estimate)
                          <span>🎯 <strong style={{ color: 'var(--text1)' }}>{lang === 'ko' ? '예측 대비 실제' : 'Predicted vs actual'}:</strong> {lang === 'ko' ? '예측' : 'est'} ~{outcome.predictedText} · {lang === 'ko' ? '실제' : 'actual'} {outcome.actualText}{outcomeVerdict ? ` (${outcomeVerdict})` : ''}</span>
                        ) : (
                          <span>⏱ <strong style={{ color: 'var(--text1)' }}>{lang === 'ko' ? '예상 복구' : 'Est. Recovery'}:</strong> {analysis.estimatedRecovery === 'No historical data for estimation'
                            ? (lang === 'ko' ? '복구 신호 모니터링 중...' : 'Monitoring recovery signals...')
                            // incident already past its estimate → show elapsed vs estimate, not the stale range
                            : estimateExceeded(analysis, inc)
                              ? exceededRecoveryText(analysis, inc, lang)
                              : analysis.estimatedRecovery === 'N/A'
                                ? (lang === 'ko' ? '일반 패턴 초과 — 예측 불가' : 'Exceeded typical pattern')
                                : analysis.estimatedRecovery}
                          </span>
                        )}
                        {analysis.affectedScope?.length > 0 && (
                          <span>📡 <strong style={{ color: 'var(--text1)' }}>{lang === 'ko' ? '영향 범위' : 'Scope'}:</strong> {analysis.affectedScope.join(', ')}</span>
                        )}
                        {isRecovered && <span>✅ {t('analysis.recoveredAt')}: {timeAgo(analysis.resolvedAt, lang)}</span>}
                        <span>🕐 {lang === 'ko' ? '분석 업데이트' : 'Analysis updated'} {timeAgo(analysis.analyzedAt, lang)}{modelLabel ? ` · ${modelLabel}` : ''}</span>
                      </div>
                    </div>
                  )
                })}

                {/* Contextual fallback recommendation — per category for the service group.
                    #641 — only render when we actually have a recommendation; no
                    "No operational alternatives" claim (subjective, may be inaccurate). */}
                {showFallback && fallbackGroups.length > 0 && (
                  <div className="mono text-[10px]" style={{ marginTop: '10px', padding: '8px 10px', background: 'var(--bg1)', borderRadius: '6px', borderLeft: '3px solid var(--amber)' }}>
                    <span style={{ color: 'var(--text1)', fontWeight: 600 }}>🔄 {lang === 'ko' ? '대안 서비스' : 'Alternatives'}</span>
                    <div style={{ marginTop: '4px', display: 'flex', flexDirection: 'column', gap: '3px' }}>
                      {fallbackGroups.map(grp => (
                        <span key={`${grp.category}:${grp.label}`} style={{ color: 'var(--text1)' }}>
                          <span style={{ color: 'var(--text2)' }}>{grp.label} → </span>
                          {grp.items.map(f => `${f.name}${f.aiwatchScore != null ? ` (${f.aiwatchScore})` : ''}`).join(', ')}
                        </span>
                      ))}
                    </div>
                  </div>
                )}
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
