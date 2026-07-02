// Ranking — AI service reliability ranking based on AIWatch Score (responsive)

import { useMemo } from 'react'
import { useLang } from '../hooks/useLang'
import { usePolling } from '../hooks/usePolling'
import { usePage } from '../utils/pageContext'
import { useSettings } from '../hooks/useSettings'
import { SCORE_BG_CLASS, SCORE_TEXT_CLASS } from '../utils/constants'
import { formatTime } from '../utils/time'
import { hasReliableScoreData, isRecentlyAdded, MIN_COVERAGE_DAYS } from '../utils/serviceReliability'
import { trackEvent } from '../utils/analytics'
import SkeletonUI from '../components/SkeletonUI'
import EmptyState from '../components/EmptyState'

const MEDALS = ['🥇', '🥈', '🥉']

export default function Ranking() {
  const { t } = useLang()
  const { setPage } = usePage()
  const { services: rawServices, loading, error, lastUpdated, refresh } = usePolling()
  const { settings } = useSettings()
  const services = (rawServices ?? []).filter((s) => settings.enabledServices.includes(s.id))

  const ranked = useMemo(() => {
    const scored = services.filter((s) => s.aiwatchScore != null && hasReliableScoreData(s))
      .sort((a, b) => b.aiwatchScore - a.aiwatchScore)
      .map((svc, i, arr) => {
        const score = Math.round(svc.aiwatchScore)
        const rank = arr.findIndex((s) => Math.round(s.aiwatchScore) === score) + 1
        const isTied = arr.filter((s) => Math.round(s.aiwatchScore) === score).length > 1
        return { ...svc, rank, isTied }
      })
    const na = services.filter((s) => s.aiwatchScore == null || !hasReliableScoreData(s))
    // #802/#870 — split the not-ranked bucket by REASON so "recently added" isn't conflated with "not
    // enough measurement signal". A service is "recently added" when coverage is its sole disqualifier
    // (already scorable, just <30d) OR its only gap is a warming probe (new probe target, e.g.
    // turbopuffer days 1-7 — no official uptime by design + a probe that reaches `available` at ~7d, so
    // it WILL rank). Genuinely un-measurable (no probe target + no uptime → `unsupported`, or a stale
    // feed) stays in the insufficient group. See serviceReliability.isRecentlyAdded.
    const recentlyAdded = na.filter(isRecentlyAdded)
    const recentIds = new Set(recentlyAdded.map((s) => s.id))
    const insufficient = na.filter((s) => !recentIds.has(s.id))
    return { scored, recentlyAdded, insufficient }
  }, [services])

  if (loading && services.length === 0) return <SkeletonUI />
  if (!loading && services.length === 0 && error) return <EmptyState type="offline" onAction={refresh} />
  if (error) return <EmptyState type="error" onAction={() => window.location.reload()} />
  if (services.length === 0) return <EmptyState type="neutral" />

  return (
    <div className="flex flex-col" style={{ gap: '20px' }}>

      {/* Header */}
      <div className="flex items-center justify-between">
        <h2 className="mono text-[10px] text-[var(--text2)] uppercase flex items-center gap-2" style={{ letterSpacing: '0.1em' }}>
          <span className="text-[var(--green)] font-semibold">//</span>
          {t('ranking.title')}
        </h2>
        <span className="mono text-[10px] text-[var(--text2)]">
          30{t('settings.period.suffix')} {t('uptime.basis.suffix')}
        </span>
      </div>

      {/* Top 3 Highlight */}
      {ranked.scored.length >= 3 && (
        <div className="grid grid-cols-1 md:grid-cols-3" style={{ gap: '10px' }}>
          {ranked.scored.slice(0, 3).map((svc, i) => (
            <button
              key={svc.id}
              onClick={() => setPage({ name: 'service', serviceId: svc.id })}
              className="bg-[var(--bg1)] border border-[var(--border)] rounded-lg text-left cursor-pointer hover:bg-[var(--bg3)] transition-colors"
              style={{ padding: '16px' }}
            >
              <div className="flex items-center gap-2" style={{ marginBottom: '8px' }}>
                <span style={{ fontSize: '18px' }}>{MEDALS[svc.rank - 1] ?? `#${svc.rank}`}</span>
                <span className="text-xs text-[var(--text0)] font-medium truncate">{svc.name}</span>
              </div>
              <div className="flex items-center gap-3">
                <span className={`mono text-[22px] font-semibold ${SCORE_TEXT_CLASS[svc.scoreGrade] ?? 'text-[var(--text2)]'}`}>
                  {svc.aiwatchScore}
                </span>
                <span className={`mono text-[10px] rounded ${SCORE_BG_CLASS[svc.scoreGrade] ?? 'bg-[var(--bg3)]'} text-[var(--bg0)]`} style={{ padding: '3px 8px' }}>
                  {svc.scoreGrade}
                </span>
              </div>
            </button>
          ))}
        </div>
      )}

      {/* Score methodology — the public /methodology page (#673, was the in-dashboard #about-score).
          #681 — same-tab internal nav + "→" + GA tracking, matching ServiceDetails (NOT ↗+new-tab,
          which is reserved for EXTERNAL links like Official Status). */}
      <div>
        <a
          href="/methodology#score"
          onClick={() => trackEvent('click_methodology', { location: 'ranking', source: 'score_link' })}
          className="mono text-[10px] text-[var(--blue)] hover:underline cursor-pointer"
        >
          {t('ranking.aboutScore')} →
        </a>
      </div>

      {/* Full Ranking */}
      <section className="bg-[var(--bg1)] border border-[var(--border)] rounded-lg overflow-hidden">
        <div className="border-b border-[var(--border)]" style={{ padding: '12px 16px' }}>
          <div className="mono text-[10px] text-[var(--text1)] uppercase tracking-wider flex items-center gap-1.5">
            <span className="rounded-full shrink-0" style={{ width: '5px', height: '5px', background: 'var(--teal)' }} />
            {t('ranking.table')}
          </div>
        </div>

        {/* Desktop: Table */}
        <div className="hidden md:block overflow-x-auto">
          <table className="w-full mono text-[11px]" style={{ borderCollapse: 'collapse' }}>
            <thead>
              <tr className="border-b border-[var(--border)] text-[var(--text2)]">
                <th style={{ padding: '8px 12px', textAlign: 'left', fontWeight: 500 }}>#</th>
                <th style={{ padding: '8px 12px', textAlign: 'left', fontWeight: 500 }}>{t('ranking.service')}</th>
                <th style={{ padding: '8px 12px', textAlign: 'right', fontWeight: 500 }}>{t('ranking.score')}</th>
                <th style={{ padding: '8px 12px', textAlign: 'center', fontWeight: 500 }}>{t('ranking.grade')}</th>
                <th style={{ padding: '8px 12px', textAlign: 'right', fontWeight: 500 }}>{t('ranking.uptime')}</th>
                <th style={{ padding: '8px 12px', textAlign: 'right', fontWeight: 500 }}>{t('ranking.responsiveness')}</th>
                <th style={{ padding: '8px 12px', textAlign: 'right', fontWeight: 500 }}>{t('ranking.affectedDays')}</th>
              </tr>
            </thead>
            <tbody>
              {ranked.scored.map((svc) => (
                <tr
                  key={svc.id}
                  className="border-b border-[var(--border)] hover:bg-[var(--bg3)] cursor-pointer transition-colors"
                  onClick={() => setPage({ name: 'service', serviceId: svc.id })}
                >
                  <td style={{ padding: '10px 12px' }} className="text-[var(--text2)]">
                    {svc.isTied ? `${svc.rank}=` : svc.rank}
                  </td>
                  <td style={{ padding: '10px 12px' }} className="text-[var(--text0)] font-medium">{svc.name}</td>
                  <td style={{ padding: '10px 12px', textAlign: 'right' }} className={`font-semibold ${SCORE_TEXT_CLASS[svc.scoreGrade] ?? ''}`}>
                    {svc.aiwatchScore}
                  </td>
                  <td style={{ padding: '10px 12px', textAlign: 'center' }}>
                    <span className={`inline-block rounded text-[9px] ${SCORE_BG_CLASS[svc.scoreGrade] ?? 'bg-[var(--bg3)]'} text-[var(--bg0)]`} style={{ padding: '3px 8px' }}>
                      {svc.scoreGrade}
                    </span>
                  </td>
                  <td style={{ padding: '10px 12px', textAlign: 'right' }} className="text-[var(--text1)]">
                    {svc.uptime30d != null ? `${svc.uptime30d.toFixed(2)}%` : '—'}
                  </td>
                  <td style={{ padding: '10px 12px', textAlign: 'right' }} className="text-[var(--text1)]">
                    {svc.scoreMetrics?.probe?.p50 != null ? `${svc.scoreMetrics.probe.p50}ms` : '—'}
                  </td>
                  <td style={{ padding: '10px 12px', textAlign: 'right' }} className="text-[var(--text1)]">
                    {svc.scoreMetrics?.affectedDays30d != null ? `${svc.scoreMetrics.affectedDays30d}${t('ranking.day')}` : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Mobile: Card List */}
        <div className="md:hidden flex flex-col">
          {ranked.scored.map((svc, i) => {
            const affectedDays = svc.scoreMetrics?.affectedDays30d ?? null
            const probeP50 = svc.scoreMetrics?.probe?.p50 ?? null
            const hasUptime = svc.uptime30d != null
            const hasAffected = affectedDays != null && affectedDays > 0
            const hasProbe = probeP50 != null
            const metaParts = [
              hasUptime ? `${svc.uptime30d.toFixed(2)}%` : null,
              hasProbe ? `${probeP50}ms` : null,
              hasAffected ? `${affectedDays}${t('ranking.day')}` : null,
            ].filter(Boolean)
            return (
              <div
                key={svc.id}
                onClick={() => setPage({ name: 'service', serviceId: svc.id })}
                className={`cursor-pointer hover:bg-[var(--bg3)] active:bg-[var(--bg3)] transition-colors${i < ranked.scored.length - 1 ? ' border-b border-[var(--border)]' : ''}`}
                style={{ padding: '10px 16px' }}
              >
                {/* Row 1: Rank + Name + Score + Grade */}
                <div className="flex items-baseline flex-wrap gap-x-2 gap-y-0.5">
                  <span className="mono text-[11px] text-[var(--text2)] shrink-0 text-right" style={{ width: '20px' }}>
                    {svc.isTied ? `${svc.rank}=` : svc.rank}
                  </span>
                  <span className="text-[12px] text-[var(--text0)] font-medium">{svc.name}</span>
                  <span className={`mono text-[13px] font-semibold shrink-0 ${SCORE_TEXT_CLASS[svc.scoreGrade] ?? ''}`}>
                    {svc.aiwatchScore}
                  </span>
                  <span className={`mono text-[9px] rounded shrink-0 ${SCORE_BG_CLASS[svc.scoreGrade] ?? 'bg-[var(--bg3)]'} text-[var(--bg0)]`} style={{ padding: '2px 6px' }}>
                    {svc.scoreGrade}
                  </span>
                  {metaParts.length > 0 && (
                    <span className="mono text-[10px] text-[var(--text2)]">
                      {metaParts.join(' · ')}
                    </span>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      </section>

      {/* #802 — Recently Added (excluded only for a <30d window — distinct from insufficient data) */}
      {ranked.recentlyAdded.length > 0 && (
        <section className="bg-[var(--bg1)] border border-[var(--border)] rounded-lg overflow-hidden">
          <div className="border-b border-[var(--border)]" style={{ padding: '12px 16px' }}>
            <div className="mono text-[10px] text-[var(--text2)] uppercase tracking-wider">
              {t('ranking.na.recent')}
            </div>
          </div>
          <div style={{ padding: '16px' }}>
            <p className="text-[11px] text-[var(--text2)]" style={{ marginBottom: '10px' }}>{t('ranking.na.recentReason')}</p>
            <div className="flex flex-col gap-2">
              {ranked.recentlyAdded.map((svc) => (
                <div key={svc.id} className="flex items-center gap-2 text-[11px] text-[var(--text2)]">
                  <span>•</span>
                  <span className="text-[var(--text1)]">{svc.name}</span>
                  {svc.coverageDays != null && (
                    <span className="text-[var(--text2)]">— {t('ranking.na.ranksIn').replace('{n}', String(Math.max(1, MIN_COVERAGE_DAYS - svc.coverageDays)))}</span>
                  )}
                </div>
              ))}
            </div>
          </div>
        </section>
      )}

      {/* Insufficient measurement data — no official uptime + no probe (low confidence), or a stale feed */}
      {ranked.insufficient.length > 0 && (
        <section className="bg-[var(--bg1)] border border-[var(--border)] rounded-lg overflow-hidden">
          <div className="border-b border-[var(--border)]" style={{ padding: '12px 16px' }}>
            <div className="mono text-[10px] text-[var(--text2)] uppercase tracking-wider">
              {t('ranking.na')}
            </div>
          </div>
          <div style={{ padding: '16px' }}>
            {/* #591 — the exclusion reason is shared by the whole bucket, so show it once here
                instead of repeating it on every row. */}
            <p className="text-[11px] text-[var(--text2)]" style={{ marginBottom: '10px' }}>{t('ranking.naReason')}</p>
            <div className="flex flex-col gap-2">
              {ranked.insufficient.map((svc) => (
                <div key={svc.id} className="flex items-center gap-2 text-[11px] text-[var(--text2)]">
                  <span>•</span>
                  <span className="text-[var(--text1)]">{svc.name}</span>
                </div>
              ))}
            </div>
          </div>
        </section>
      )}


    </div>
  )
}
