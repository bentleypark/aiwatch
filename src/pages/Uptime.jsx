// Uptime Report — 30-day availability page
// Summary cards: most stable, avg uptime, most issues.
// Rankings: horizontal bars with SLA baseline marker.
// 3-month matrix: service × month, color-coded by uptime threshold.
// SLA_DEFAULT used until useSettings is wired in Issue #14.

import { useMemo } from 'react'
import { useLang } from '../hooks/useLang'
import { usePolling } from '../hooks/usePolling'
import SkeletonUI from '../components/SkeletonUI'
import EmptyState from '../components/EmptyState'

// ── Constants ────────────────────────────────────────────────

// SLA threshold — wired to useSettings in Issue #14
const SLA_DEFAULT = 99.9

// Uptime thresholds for bar/cell color coding
const GOOD_THRESHOLD = SLA_DEFAULT // >= 99.9% → green
const WARN_THRESHOLD = 95.0        // >= 95% and < 99.9% → amber  /  < 95% → red

// ── Helpers ──────────────────────────────────────────────────

function uptimeColorClass(pct) {
  if (pct >= GOOD_THRESHOLD) return 'bg-[var(--green)]'
  if (pct >= WARN_THRESHOLD) return 'bg-[var(--amber)]'
  return 'bg-[var(--red)]'
}

function uptimeTextClass(pct) {
  if (pct >= GOOD_THRESHOLD) return 'text-[var(--green)]'
  if (pct >= WARN_THRESHOLD) return 'text-[var(--amber)]'
  return 'text-[var(--red)]'
}

// Format month string ('YYYY-MM') to locale-aware short label (e.g. 'Jan', '1월')
function formatMonth(yyyyMM, lang) {
  const [y, m] = yyyyMM.split('-').map(Number)
  return new Intl.DateTimeFormat(lang === 'ko' ? 'ko-KR' : 'en-US', {
    month: 'short',
  }).format(new Date(y, m - 1, 1))
}

// ── Sub-components ───────────────────────────────────────────

const STAT_TOP_COLOR = {
  'text-[var(--green)]': 'var(--green)',
  'text-[var(--blue)]':  'var(--blue)',
  'text-[var(--amber)]': 'var(--amber)',
  'text-[var(--red)]':   'var(--red)',
}

function SummaryCard({ label, value, sub, colorClass }) {
  const topColor = STAT_TOP_COLOR[colorClass] ?? 'var(--border)'
  return (
    <div className="relative bg-[var(--bg1)] border border-[var(--border)] rounded-lg overflow-hidden"
         style={{ padding: '14px 16px' }}>
      <span className="absolute top-0 left-0 right-0 h-px" style={{ background: topColor }} />
      <div className="mono text-[9px] text-[var(--text2)] uppercase" style={{ letterSpacing: '0.1em', marginBottom: '6px' }}>{label}</div>
      <div className={`mono text-[26px] font-semibold leading-none ${colorClass}`} style={{ marginBottom: '4px' }}>{value}</div>
      {sub && <div className="mono text-[10px] text-[var(--text2)]">{sub}</div>}
    </div>
  )
}

function UptimeBar({ service, sla }) {
  // Bar width is proportional within 95–100% range to show meaningful variance
  // (all services cluster near 100%; linear 0–100% scale makes differences invisible)
  const MIN_DISPLAY = 95
  const range = 100 - MIN_DISPLAY
  const clampedPct = Math.max(MIN_DISPLAY, service.uptime30d)
  const widthPct = Math.round(((clampedPct - MIN_DISPLAY) / range) * 100)
  // SLA marker position within the same 95–100% range
  const slaPos = Math.round(((sla - MIN_DISPLAY) / range) * 100)
  const barColorClass = uptimeColorClass(service.uptime30d)
  const textColorClass = uptimeTextClass(service.uptime30d)

  return (
    <div className="flex items-center gap-3">
      <span className="w-28 shrink-0 truncate text-xs text-[var(--text1)]">{service.name}</span>
      <div className="flex-1 relative bg-[var(--bg3)] rounded-full h-2">
        <div className={`h-2 rounded-full ${barColorClass}`} style={{ width: `${widthPct}%` }} />
        {/* SLA baseline marker — vertical notch at the SLA threshold position */}
        <div
          className="absolute top-[-2px] bottom-[-2px] w-px bg-[var(--text2)] opacity-60"
          style={{ left: `${slaPos}%` }}
          aria-hidden="true"
        />
      </div>
      <span className={`w-16 shrink-0 text-right text-xs mono font-medium ${textColorClass}`}>
        {service.uptime30d.toFixed(2)}%
      </span>
    </div>
  )
}

function MatrixCell({ uptime }) {
  const bg   = uptimeColorClass(uptime)
  const text = uptimeTextClass(uptime)
  return (
    <td className="px-2 py-1.5 text-center">
      <span className={`inline-block px-1.5 py-0.5 rounded text-[10px] mono font-medium ${bg} text-[var(--bg0)]`}>
        {uptime.toFixed(1)}%
      </span>
    </td>
  )
}

// ── Main Component ───────────────────────────────────────────

export default function Uptime() {
  const { t, lang } = useLang()
  const { services: rawServices, loading, error } = usePolling()
  const services = rawServices ?? []

  const sortedByUptime = useMemo(
    () => [...services].sort((a, b) => b.uptime30d - a.uptime30d),
    [services]
  )

  if (loading) return <SkeletonUI />
  if (error)   return <EmptyState type="error" onAction={() => window.location.reload()} />

  if (services.length === 0) return <EmptyState type="neutral" />

  const mostStable = sortedByUptime[0]
  const leastStable = sortedByUptime[sortedByUptime.length - 1]
  const avgUptime = (services.reduce((s, v) => s + v.uptime30d, 0) / services.length).toFixed(2)

  const mostIssues = [...services].sort(
    (a, b) => (b.incidents?.length ?? 0) - (a.incidents?.length ?? 0)
  )[0]

  // Extract month labels from the first service's history3m (all services share the same months)
  const months = (services[0]?.history3m ?? []).map((m) => m.month)

  return (
    <div className="flex flex-col" style={{ gap: '20px' }}>

      {/* ── Section Header ── */}
      <div className="flex items-center justify-between">
        <h2 className="mono text-[10px] text-[var(--text2)] uppercase flex items-center gap-2" style={{ letterSpacing: '0.1em' }}>
          <span className="text-[var(--green)] font-semibold">//</span>
          {t('nav.uptime')}
        </h2>
        <span className="mono text-[10px] text-[var(--text2)]">{t('uptime.basis')}</span>
      </div>

      {/* ── Summary Cards ── */}
      <div className="grid grid-cols-1 md:grid-cols-3" style={{ gap: '10px' }}>
        <SummaryCard
          label={t('uptime.stable')}
          value={mostStable.name}
          sub={`${mostStable.uptime30d.toFixed(1)}% ${t('overview.card.uptime')}`}
          colorClass="text-[var(--green)]"
        />
        <SummaryCard
          label={t('uptime.average')}
          value={`${avgUptime}%`}
          sub={t('overview.stats.uptime.sub')}
          colorClass="text-[var(--blue)]"
        />
        <SummaryCard
          label={t('uptime.issues')}
          value={mostIssues.name}
          sub={`${mostIssues.uptime30d.toFixed(1)}% ${t('overview.card.uptime')}`}
          colorClass="text-[var(--red)]"
        />
      </div>

      {/* ── Uptime Rankings ── */}
      <div className="grid grid-cols-1 lg:grid-cols-2" style={{ gap: '10px' }}>
      <section className="bg-[var(--bg1)] border border-[var(--border)] rounded-lg overflow-hidden">
        <div className="flex items-center justify-between border-b border-[var(--border)]" style={{ padding: '12px 16px' }}>
          <div className="mono text-[10px] text-[var(--text1)] uppercase tracking-wider flex items-center gap-1.5">
            <span className="rounded-full shrink-0" style={{ width: '5px', height: '5px', background: 'var(--teal)' }} />
            {t('uptime.rankings')}
          </div>
          <span className="mono text-[9px] text-[var(--text2)]">— {SLA_DEFAULT}% SLA</span>
        </div>
        <div style={{ padding: '16px' }}>
        <div className="flex flex-col gap-3">
          {sortedByUptime.map((svc) => (
            <UptimeBar key={svc.id} service={svc} sla={SLA_DEFAULT} />
          ))}
        </div>
        </div>
      </section>

      {/* ── 3-Month Matrix ── */}
      <section className="bg-[var(--bg1)] border border-[var(--border)] rounded-lg overflow-hidden">
        <div className="flex items-center justify-between border-b border-[var(--border)]" style={{ padding: '12px 16px' }}>
          <div className="mono text-[10px] text-[var(--text1)] uppercase tracking-wider flex items-center gap-1.5">
            <span className="rounded-full shrink-0" style={{ width: '5px', height: '5px', background: 'var(--amber)' }} />
            {t('uptime.matrix')}
          </div>
          <span className="mono text-[9px] text-[var(--text2)]">{t('uptime.matrix.sub')}</span>
        </div>
        <div style={{ padding: '16px' }} className="overflow-x-auto">
        <table className="w-full min-w-[400px]">
          <thead>
            <tr className="border-b border-[var(--border)]">
              <th className="pb-2 text-left text-[10px] mono text-[var(--text2)] font-medium w-32">
                {t('incidents.col.service')}
              </th>
              {months.map((m) => (
                <th key={m} className="pb-2 text-center text-[10px] mono text-[var(--text2)] font-medium">
                  {formatMonth(m, lang)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sortedByUptime.map((svc) => (
              <tr key={svc.id} className="border-b border-[var(--border)] last:border-0">
                <td className="py-1.5 text-xs text-[var(--text1)] truncate max-w-[128px] pr-2">
                  {svc.name}
                </td>
                {(svc.history3m ?? []).map((entry) => (
                  <MatrixCell key={entry.month} uptime={entry.uptime} />
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      </section>
      </div>

    </div>
  )
}
