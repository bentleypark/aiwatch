// Uptime Report — availability page
// Summary cards: most stable, avg uptime, most issues.
// Rankings: horizontal bars with SLA baseline marker.

import { useMemo } from 'react'
import { useLang } from '../hooks/useLang'
import { usePolling } from '../hooks/usePolling'
import { useSettings } from '../hooks/useSettings'
import { UptimeSkeleton } from '../components/SkeletonUI'
import EmptyState from '../components/EmptyState'
import { isUnreliableUptime, noOfficialUptime } from '../utils/serviceReliability'

// ── Constants ────────────────────────────────────────────────

const WARN_THRESHOLD = 95.0 // < 95% → red

// ── Helpers ──────────────────────────────────────────────────

function uptimeColorClass(pct, sla) {
  if (pct >= sla) return 'bg-[var(--green)]'
  if (pct >= WARN_THRESHOLD) return 'bg-[var(--amber)]'
  return 'bg-[var(--red)]'
}

function uptimeTextClass(pct, sla) {
  if (pct >= sla) return 'text-[var(--green)]'
  if (pct >= WARN_THRESHOLD) return 'text-[var(--amber)]'
  return 'text-[var(--red)]'
}

// ── Sub-components ───────────────────────────────────────────

const STAT_TOP_COLOR = {
  'text-[var(--green)]': 'var(--green)',
  'text-[var(--blue)]':  'var(--blue)',
  'text-[var(--amber)]': 'var(--amber)',
  'text-[var(--red)]':   'var(--red)',
}

function SummaryCard({ label, value, sub, colorClass, valueSize = '26px', mono = true }) {
  const topColor = STAT_TOP_COLOR[colorClass] ?? 'var(--border)'
  return (
    <div className="relative bg-[var(--bg1)] border border-[var(--border)] rounded-lg overflow-hidden"
         style={{ padding: '14px 16px' }}>
      <span className="absolute top-0 left-0 right-0 h-px" style={{ background: topColor }} />
      <div className="mono text-[9px] text-[var(--text2)] uppercase" style={{ letterSpacing: '0.1em', marginBottom: '6px' }}>{label}</div>
      <div className={`font-semibold leading-none ${colorClass} ${mono ? 'mono' : ''}`} style={{ fontSize: valueSize, marginBottom: '4px' }}>{value}</div>
      {sub && <div className="mono text-[10px] text-[var(--text2)]">{sub}</div>}
    </div>
  )
}

function UptimeBar({ service, sla, t }) {
  // Bar width is proportional within 95–100% range to show meaningful variance
  // (all services cluster near 100%; linear 0–100% scale makes differences invisible)
  const MIN_DISPLAY = 95
  const range = 100 - MIN_DISPLAY
  const uptime = service.uptime30d ?? 0
  const hasUptime = service.uptime30d != null && !isUnreliableUptime(service)
  const clampedPct = Math.max(MIN_DISPLAY, uptime)
  const widthPct = hasUptime ? Math.round(((clampedPct - MIN_DISPLAY) / range) * 100) : 0
  const slaPos = Math.round(((sla - MIN_DISPLAY) / range) * 100)
  // #1006 — a short window can now happen on any computed source (a status-page migration resets the
  // provider's component clock), not just the 'official' one.
  const isPartialWindow = hasUptime && service.uptimeWindowDays != null
  const barColorClass = hasUptime ? uptimeColorClass(uptime, sla) : 'bg-[var(--bg3)]'
  const textColorClass = hasUptime ? uptimeTextClass(uptime, sla) : 'text-[var(--text2)]'

  return (
    <div className="flex items-center gap-3">
      <span className="w-28 shrink-0 truncate text-xs text-[var(--text1)]">{service.name}</span>
      <div className="flex-1 relative bg-[var(--bg3)] rounded-full h-2">
        <div className={`h-2 rounded-full ${barColorClass}`} style={{ width: `${widthPct}%` }} />
        <div
          className="absolute top-[-2px] bottom-[-2px] w-px bg-[var(--text2)] opacity-60"
          style={{ left: `${slaPos}%` }}
          aria-hidden="true"
        />
      </div>
      <span className={`w-16 shrink-0 text-right text-xs mono font-medium ${textColorClass}`}
            title={!hasUptime ? t(noOfficialUptime(service) ? 'uptime.noOfficial.tooltip' : 'uptime.unavailable.tooltip') : undefined}>
        {hasUptime ? `${uptime.toFixed(2)}%` : t('uptime.unavailable.short')}
      </span>
      {/* #1006 — 'off' = computed by AIWatch from the provider's official records (30d). A provider whose
          records don't reach back 30 days (status-page migration) is marked '<Nd' with the real window
          in the tooltip, so a short-window figure is never read as a 30-day one. */}
      <span className={`w-8 shrink-0 text-right text-[9px] mono ${isPartialWindow ? 'text-[var(--amber)]' : 'text-[var(--text2)]'}`}
            title={isPartialWindow ? t('uptime.partialWindow.tooltip').replace('{d}', String(service.uptimeWindowDays))
              : service.uptimeSource === 'official' ? t('uptime.sub.official')
              : service.uptimeSource === 'platform_avg' ? t('uptime.sub.platform_avg') : undefined}>
        {!hasUptime ? '' : isPartialWindow ? `${service.uptimeWindowDays}d` : service.uptimeSource === 'official' ? 'off' : service.uptimeSource === 'platform_avg' ? 'avg' : ''}
      </span>
    </div>
  )
}

// ── Main Component ───────────────────────────────────────────

export default function Uptime() {
  const { t, lang } = useLang()
  const { services: rawServices, loading, error, refresh } = usePolling()
  const { settings } = useSettings()
  const sla = settings.sla
  const services = (rawServices ?? []).filter((s) => settings.enabledServices.includes(s.id))

  const hasReliableUptime = (s) => s.uptime30d != null && !isUnreliableUptime(s)
  const sortedByUptime = useMemo(
    () => [...services]
      .sort((a, b) => {
        const aUp = isUnreliableUptime(a) ? null : a.uptime30d
        const bUp = isUnreliableUptime(b) ? null : b.uptime30d
        if (aUp == null && bUp == null) return 0
        if (aUp == null) return 1
        if (bUp == null) return -1
        return bUp - aUp
      }),
    [services]
  )

  if (loading && services.length === 0) return <UptimeSkeleton />
  if (!loading && services.length === 0 && error) return <EmptyState type="offline" onAction={refresh} />
  if (error)   return <EmptyState type="error" onAction={() => window.location.reload()} />

  if (services.length === 0) return <EmptyState type="neutral" />

  const uptimeServices = services.filter(hasReliableUptime)
  const hasUptimeData = uptimeServices.length > 0
  const mostStable = hasUptimeData
    ? uptimeServices.reduce((max, s) => s.uptime30d > max.uptime30d ? s : max)
    : null
  const mostIssues = hasUptimeData
    ? uptimeServices.reduce((min, s) => s.uptime30d < min.uptime30d ? s : min)
    : null
  const avgUptime = hasUptimeData
    ? (uptimeServices.reduce((s, v) => s + v.uptime30d, 0) / uptimeServices.length).toFixed(2)
    : '—'

  return (
    <div className="flex flex-col" style={{ gap: '20px' }}>

      {/* ── Section Header ── */}
      <div className="flex items-center justify-between">
        <h2 className="mono text-[10px] text-[var(--text2)] uppercase flex items-center gap-2" style={{ letterSpacing: '0.1em' }}>
          <span className="text-[var(--green)] font-semibold">//</span>
          {t('nav.uptime')}
        </h2>
        {/* #1006 — a LEGEND, not a claim. The rows are not on one basis: most services are AIWatch's own
            30-day computation from the provider's records (`off`), and the BetterStack ones are that
            platform's monitors, same computation (`avg`). A partial-window service adds an amber `{N}d`
            marker inline. A single header line saying "30 days" would repeat the mistake #654 removed. */}
        <span className="mono text-[10px] text-[var(--text2)] flex items-center gap-2 flex-wrap justify-end">
          {hasUptimeData ? (
            <>
              <span title={t('uptime.sub.official')}><span className="text-[var(--text1)]">off</span> {t('uptime.legend.official')}</span>
              <span className="opacity-40">·</span>
              <span title={t('uptime.sub.platform_avg')}><span className="text-[var(--text1)]">avg</span> {t('uptime.legend.platform')}</span>
            </>
          ) : t('uptime.collecting')}
        </span>
      </div>

      {/* ── Summary Cards ── */}
      <div className="grid grid-cols-1 md:grid-cols-3" style={{ gap: '10px' }}>
        <SummaryCard
          label={t('uptime.stable')}
          value={mostStable ? mostStable.name : t('uptime.collecting')}
          sub={mostStable ? `${mostStable.uptime30d.toFixed(2)}% ${t('overview.card.uptime')}` : ''}
          colorClass="text-[var(--green)]"
          valueSize="18px"
        />
        <SummaryCard
          label={t('uptime.average')}
          value={hasUptimeData ? `${avgUptime}%` : '—'}
          sub={t('overview.stats.uptime.sub')}
          colorClass="text-[var(--blue)]"
        />
        <SummaryCard
          label={t('uptime.issues')}
          value={mostIssues ? `${mostIssues.name} (${(mostIssues.incidents ?? []).length})` : t('uptime.collecting')}
          sub={mostIssues ? `${mostIssues.uptime30d.toFixed(2)}% ${t('overview.card.uptime')}` : ''}
          colorClass="text-[var(--red)]"
          valueSize="18px"
        />
      </div>

      {/* ── Uptime Rankings ── */}
      <section className="bg-[var(--bg1)] border border-[var(--border)] rounded-lg overflow-hidden">
        <div className="flex items-center justify-between border-b border-[var(--border)]" style={{ padding: '12px 16px' }}>
          <div className="mono text-[10px] text-[var(--text1)] uppercase tracking-wider flex items-center gap-1.5">
            <span className="rounded-full shrink-0" style={{ width: '5px', height: '5px', background: 'var(--teal)' }} />
            {t('uptime.rankings')}
          </div>
          <span className="mono text-[9px] text-[var(--text2)]">— {sla}% {t('uptime.sla.label')}</span>
        </div>
        <div style={{ padding: '16px' }}>
          <div className="flex flex-col gap-3">
            {sortedByUptime.map((svc) => (
              <UptimeBar key={svc.id} service={svc} sla={sla} t={t} />
            ))}
          </div>
        </div>
      </section>

    </div>
  )
}
