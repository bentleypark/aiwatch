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

function SummaryCard({ label, value, sub, colorClass }) {
  return (
    <div className="bg-[var(--bg1)] border border-[var(--border)] rounded-lg p-4 flex flex-col gap-1">
      <span className="text-xs text-[var(--text2)] uppercase tracking-wider">{label}</span>
      <span className={`text-2xl mono font-semibold ${colorClass}`}>{value}</span>
      {sub && <span className="text-xs text-[var(--text1)] truncate">{sub}</span>}
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

  if (loading) return <div className="p-4 md:p-6"><SkeletonUI /></div>
  if (error)   return <div className="p-4 md:p-6"><EmptyState type="error" onAction={() => window.location.reload()} /></div>

  if (services.length === 0) return <div className="p-4 md:p-6"><EmptyState type="neutral" /></div>

  const mostStable = sortedByUptime[0]
  const leastStable = sortedByUptime[sortedByUptime.length - 1]
  const avgUptime = (services.reduce((s, v) => s + v.uptime30d, 0) / services.length).toFixed(2)

  const mostIssues = [...services].sort(
    (a, b) => (b.incidents?.length ?? 0) - (a.incidents?.length ?? 0)
  )[0]

  // Extract month labels from the first service's history3m (all services share the same months)
  const months = (services[0]?.history3m ?? []).map((m) => m.month)

  return (
    <div className="p-4 md:p-6 space-y-6">

      {/* ── Summary Cards ── */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <SummaryCard
          label={t('uptime.stable')}
          value={`${mostStable.uptime30d.toFixed(2)}%`}
          sub={mostStable.name}
          colorClass="text-[var(--green)]"
        />
        <SummaryCard
          label={t('uptime.average')}
          value={`${avgUptime}%`}
          sub=""
          colorClass="text-[var(--blue)]"
        />
        <SummaryCard
          label={t('uptime.issues')}
          value={`${(mostIssues.incidents?.length ?? 0)} ${t('uptime.incidents')}`}
          sub={mostIssues.name}
          colorClass="text-[var(--amber)]"
        />
      </div>

      {/* ── Uptime Rankings ── */}
      <section className="bg-[var(--bg1)] border border-[var(--border)] rounded-lg p-4">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-xs mono text-[var(--text2)] uppercase tracking-wider">
            {t('uptime.rankings')}
          </h2>
          <span className="text-[10px] mono text-[var(--text2)]">
            {t('uptime.sla')}: {SLA_DEFAULT}%
          </span>
        </div>
        <div className="flex flex-col gap-3">
          {sortedByUptime.map((svc) => (
            <UptimeBar key={svc.id} service={svc} sla={SLA_DEFAULT} />
          ))}
        </div>
      </section>

      {/* ── 3-Month Matrix ── */}
      <section className="bg-[var(--bg1)] border border-[var(--border)] rounded-lg p-4 overflow-x-auto">
        <h2 className="text-xs mono text-[var(--text2)] uppercase tracking-wider mb-4">
          {t('uptime.matrix')}
        </h2>
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
      </section>

    </div>
  )
}
