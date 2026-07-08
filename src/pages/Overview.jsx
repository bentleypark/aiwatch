// Overview — summary stats, service grid, recent incidents, latency rankings, AI panel.
// Design mockup: svc-card with left border, provider, 3-col metrics, variable-height history bars.

import { useState, useEffect, useMemo, Fragment } from 'react'
import IncidentTimeline from '../components/IncidentTimeline'
import ReportModal from '../components/ReportModal'
import RecentUserReports from '../components/RecentUserReports'
import { useLang } from '../hooks/useLang'
import { usePage } from '../utils/pageContext'
import { usePolling } from '../hooks/usePolling'
import { useSettings } from '../hooks/useSettings'
import { trackEvent } from '../utils/analytics'
import { isUnreliableUptime, noOfficialUptime } from '../utils/serviceReliability'
import { tagServiceForAlert } from '../utils/securityAlerts'
import { computePredictionOutcome, withinEstimateText } from '../utils/predictionAccuracy'
import { SCORE_BG_CLASS, SERVICE_CATEGORIES, getGroupedFallbacksExcludingRegionSwitchable, ALL_SERVICES_FEED_URL, outboundReferralUrl, sendReferralBeacon } from '../utils/constants'
import RssCopyIcon from '../components/RssCopyIcon'
import { regionStatusOf } from '../utils/regionStatus'
import { buildCalendarFromIncidents } from '../utils/calendar'
import { compareIncidents, compareGroupedRows, getContextualTime, dominantGroupStatus, sumGroupDuration, formatDurationMs } from '../utils/incidentSort'
import { groupIncidents } from '../utils/incidentGrouping'
import { formatTime, formatDate } from '../utils/time'
import SkeletonUI from '../components/SkeletonUI'
import StatusPill from '../components/StatusPill'
import { resolveStatusDisplay } from '../utils/statusDisplay'
import EmptyState from '../components/EmptyState'

// ── Status color maps ────────────────────────────────────────

// Border-left now applied via inline style in ServiceCard

// Calendar cell status → bar color (#663 impact-aligned keys, matches CALENDAR_CLASS in ServiceDetails)
const HISTORY_CLASS = {
  operational:  'bg-[var(--green)]',
  minor:        'bg-[var(--yellow)]',
  major:        'bg-[var(--amber)]',
  critical:     'bg-[var(--red)]',
}

const INC_BAR_CLASS = {
  ongoing:        'bg-[var(--red)]',
  investigating:  'bg-[var(--red)]',
  identified:     'bg-[var(--red)]',
  monitoring:     'bg-[var(--amber)]',
  resolved:       'bg-[var(--green)]',
}

// ── Sub-components ───────────────────────────────────────────

const STAT_TOP_COLOR = {
  'text-[var(--green)]': 'var(--green)',
  'text-[var(--amber)]': 'var(--amber)',
  'text-[var(--red)]':   'var(--red)',
  'text-[var(--blue)]':  'var(--blue)',
}

function StatCard({ value, sub, labelKey, colorClass, index, t }) {
  const topColor = STAT_TOP_COLOR[colorClass] ?? 'var(--border)'
  return (
    <div
      className="relative bg-[var(--bg1)] border border-[var(--border)] rounded-lg overflow-hidden animate-[fade-in_0.3s_ease_both]"
      style={{ padding: '14px 16px', animationDelay: `${index * 80}ms` }}
    >
      <span className="absolute top-0 left-0 right-0 h-px" style={{ background: topColor }} />
      <div className="mono text-[9px] text-[var(--text2)] uppercase tracking-wider" style={{ letterSpacing: '0.1em', marginBottom: '6px' }}>
        {t(labelKey)}
      </div>
      <div className={`mono text-[26px] font-semibold leading-none ${colorClass}`} style={{ marginBottom: '4px' }}>
        {value}
      </div>
      {sub && <div className="mono text-[10px] text-[var(--text2)]">{sub}</div>}
    </div>
  )
}

// Variable-height history bars matching design mockup (18px container, bars 4-18px)
function HistoryBars({ history30d, compact }) {
  const h = compact ? 10 : 18
  const bars = compact ? history30d.slice(-30) : history30d
  return (
    <div className="flex gap-[2px] items-end" style={{ height: `${h}px` }} aria-hidden="true">
      {bars.map((status, i) => {
        const cls = HISTORY_CLASS[status] ?? HISTORY_CLASS.operational
        const baseH = compact
          ? (status === 'operational' ? 6 + ((i * 7 + 3) % 5) : 3 + ((i * 5) % 4))
          : (status === 'operational' ? 12 + ((i * 7 + 3) % 7) : 4 + ((i * 5) % 6))
        return (
          <div
            key={i}
            className={`flex-1 rounded-sm ${cls}`}
            style={{ height: `${baseH}px`, opacity: status === 'operational' ? 0.6 : 0.8, minHeight: compact ? '3px' : '4px' }}
          />
        )
      })}
    </div>
  )
}

function ServiceCard({ service, index, onClick, t, isRecovered, isProbed }) {
  const incidentCount = (service.incidents ?? []).filter((i) => i.status !== 'resolved').length
  // #591 — blank UPTIME / score for estimate-no-data OR stale-source (showing frozen/assumed figures
  // as current would mislead). #653 — the incident COUNT, however, is the LIVE list and blanks only for
  // a stale/frozen feed, NOT for estimate-no-data: an estimate-only service with a live informational
  // incident has a baseless uptime but a real incident count (matches ServiceDetails `incidentsBlanked`).
  const isUnreliable = isUnreliableUptime(service)
  const incidentsBlanked = !!service.incidentSourceStale
  const hasUptime = service.uptime30d != null && !isUnreliable
  const uptimeColor = !hasUptime ? 'text-[var(--text2)]' : service.uptime30d >= 99 ? 'text-[var(--green)]' : service.uptime30d >= 97 ? 'text-[var(--amber)]' : 'text-[var(--red)]'
  const latencyColor = service.latency == null ? 'text-[var(--text2)]'
    : service.latency < 500 ? 'text-[var(--green)]'
    : service.latency < 800 ? 'text-[var(--amber)]'
    : 'text-[var(--red)]'
  const uptimeStr = hasUptime ? `${service.uptime30d.toFixed(2)}%` : t('uptime.unavailable.short')
  const scoreStr = service.aiwatchScore != null ? `${service.aiwatchScore} ${service.scoreGrade}` : null

  return (
    <button
      onClick={onClick}
      className="w-full text-left bg-[var(--bg1)] border border-[var(--border)] rounded-lg
                 hover:border-t-[var(--border-hi)] hover:border-r-[var(--border-hi)] hover:border-b-[var(--border-hi)] transition-colors animate-[fade-in_0.3s_ease_both]"
      style={{
        animationDelay: `${index * 80}ms`,
        // #744 — match the StatusPill badge: partial (operational + partialCount) → yellow, not green.
        borderLeft: `3px solid ${
          service.status === 'down' ? 'var(--red)'
          : service.status === 'degraded' ? 'var(--amber)'
          : resolveStatusDisplay(service.status, service.partialCount, service.sourceDead && !service.probeConfirmed) === 'partial' ? 'var(--yellow)'
          : 'var(--green)'}`,
      }}
    >
      {/* ── Mobile compact layout ── */}
      <div className="md:hidden" style={{ padding: '10px 12px' }}>
        <div className="flex justify-between items-center" style={{ marginBottom: '4px' }}>
          <span className="text-[13px] font-medium text-[var(--text0)] truncate min-w-0">{service.name}</span>
          <div className="flex items-center gap-1.5">
            {isRecovered && <span className="mono text-[9px] rounded" style={{ color: 'var(--blue)', background: 'var(--blue-dim)', padding: '3px 8px' }}>{t('overview.recovered')}</span>}
            <StatusPill status={service.status} partialCount={service.partialCount} sourceDead={service.sourceDead && !service.probeConfirmed} />
          </div>
        </div>
        <div className="flex items-center justify-between" style={{ marginBottom: '4px' }}>
          <span className="mono text-[10px] text-[var(--text2)]">
            <span className={uptimeColor}>{uptimeStr}</span>
            {!incidentsBlanked && incidentCount > 0 && <>{' · '}<span className="text-[var(--red)]">{incidentCount}{t('overview.card.incidents.compact')}</span></>}
            {!incidentsBlanked && scoreStr && <>{' · '}{scoreStr}</>}
          </span>
        </div>
        <HistoryBars history30d={buildCalendarFromIncidents(service.incidents, service.dailyImpact, 30, service.status)} compact />
      </div>

      {/* ── Desktop full layout ── */}
      <div className="hidden md:block" style={{ padding: '14px' }}>
        <div className="flex justify-between items-start" style={{ marginBottom: '10px' }}>
          <div>
            <div className="text-[13px] font-medium text-[var(--text0)]" style={{ marginBottom: '2px' }}>{service.name}</div>
            <div className="mono text-[10px] text-[var(--text2)]">{service.provider}</div>
          </div>
          <div className="flex items-center gap-1.5">
            {isRecovered && <span className="mono text-[9px] rounded" style={{ color: 'var(--blue)', background: 'var(--blue-dim)', padding: '3px 8px' }}>{t('overview.recovered')}</span>}
            <StatusPill status={service.status} partialCount={service.partialCount} sourceDead={service.sourceDead && !service.probeConfirmed} />
          </div>
        </div>

        <div className="grid grid-cols-3" style={{ gap: '6px', marginBottom: '10px', textAlign: 'center' }}>
          <div>
            <div className={`mono text-[13px] font-medium ${latencyColor}`}>{service.latency != null ? `${service.latency}ms` : '—'}</div>
            {/* #658 — probed services (24 API services, #678) show direct API RTT; label must say so, not
                "status page" (matches ServiceDetails svc.latency vs svc.latency.statusPage). */}
            <div className="mono text-[9px] text-[var(--text2)]" style={{ letterSpacing: '0.04em' }}>{t(isProbed ? 'overview.card.latency.api' : 'overview.card.latency')}</div>
          </div>
          <div>
            <div className={`mono text-[13px] font-medium ${uptimeColor}`} title={!hasUptime ? t(noOfficialUptime(service) ? 'uptime.noOfficial.tooltip' : 'uptime.unavailable.tooltip') : undefined}>
              {uptimeStr}
            </div>
            <div className="mono text-[9px] text-[var(--text2)]" style={{ letterSpacing: '0.04em' }}>{t('overview.card.uptime')}</div>
          </div>
          <div>
            <div className={`mono text-[13px] font-medium ${incidentsBlanked ? 'text-[var(--text2)]' : 'text-[var(--text0)]'}`}>{incidentsBlanked ? '—' : incidentCount}</div>
            <div className="mono text-[9px] text-[var(--text2)]" style={{ letterSpacing: '0.04em' }}>{t('overview.card.incidents')}</div>
          </div>
        </div>

        {service.aiwatchScore != null && !incidentsBlanked && (
          <div className="flex items-center gap-2" style={{ marginBottom: '8px' }}>
            <span className="mono text-[9px] text-[var(--text2)]">{t('score.bar.label')}</span>
            <div className="flex-1 bg-[var(--bg3)] rounded-full" style={{ height: '4px' }}>
              <div className={`rounded-full ${SCORE_BG_CLASS[service.scoreGrade] ?? 'bg-[var(--bg3)]'}`}
                   style={{ height: '4px', width: `${service.aiwatchScore}%` }} />
            </div>
            <span className={`mono text-[10px] font-medium rounded ${SCORE_BG_CLASS[service.scoreGrade] ?? 'bg-[var(--bg3)]'} text-[var(--bg0)]`}
                  style={{ padding: '2px 6px' }}>
              {service.aiwatchScore} {service.scoreGrade}
            </span>
          </div>
        )}

        <HistoryBars history30d={buildCalendarFromIncidents(service.incidents, service.dailyImpact, 30, service.status)} />
      </div>
    </button>
  )
}

// Score color maps from constants

// Filter: pill-style segment control per design mockup
function FilterTabs({ filter, setFilter, total, issueCount, downCount, t }) {
  const tabs = [
    { key: 'all',         labelKey: 'overview.filter.all',        count: total },
    { key: 'operational', labelKey: 'overview.filter.operational', count: total - issueCount },
    { key: 'issues',      labelKey: 'overview.filter.issues',      count: issueCount },
  ]
  return (
    <div className="flex bg-[var(--bg2)] rounded-[6px] border border-[var(--border)]" style={{ padding: '2px', gap: '1px' }}>
      {tabs.map((tab) => (
        <button
          key={tab.key}
          onClick={() => { setFilter(tab.key); trackEvent('change_filter', { filter: tab.key }) }}
          className={`mono text-[10px] rounded transition-all cursor-pointer`}
          style={{
            padding: '4px 10px',
            letterSpacing: '0.04em',
            whiteSpace: 'nowrap',
            background: filter === tab.key ? 'var(--bg4)' : 'transparent',
            color: filter === tab.key ? 'var(--text0)' : 'var(--text2)',
          }}
        >
          {t(tab.labelKey)} <span style={{ marginLeft: '2px' }}>{tab.count}</span>
          {tab.key === 'issues' && issueCount > 0 && (
            <span
              className="inline-block rounded-full"
              style={{
                width: '6px', height: '6px', marginLeft: '6px', verticalAlign: 'middle',
                background: downCount > 0 ? 'var(--red)' : 'var(--amber)',
              }}
            />
          )}
        </button>
      ))}
    </div>
  )
}

// Service categories rendered as Overview sections (mirrors the sidebar taxonomy, #646; dev-audience
// ordering, #658). Order matches SERVICE_CATEGORIES key order — keep the two in sync. 'all' is the
// meta-bucket (no section of its own); the seven below partition every service.
const SECTION_KEYS = ['llm', 'agents', 'voice', 'inference', 'observability', 'video', 'image', 'apps']
const CATEGORY_TAB_KEYS = ['all', ...SECTION_KEYS]

// Category selector on the Overview itself (#646) — mirrors the sidebar's category filter so the
// active category is both visible AND changeable from the main screen, including on mobile where the
// sidebar is hidden behind the hamburger. Drives the same shared `categoryFilter` (usePage).
function CategoryTabs({ categoryFilter, setCategoryFilter, t }) {
  return (
    <div className="flex flex-wrap" style={{ gap: '4px' }} role="tablist" aria-label={t('nav.services')}>
      {CATEGORY_TAB_KEYS.map((key) => {
        const active = categoryFilter === key
        return (
          <button
            key={key}
            role="tab"
            aria-selected={active}
            onClick={() => { setCategoryFilter(key); trackEvent('category_filter', { category: key, location: 'overview' }) }}
            className="mono text-[10px] rounded transition-all cursor-pointer"
            style={{
              padding: '4px 10px',
              letterSpacing: '0.03em',
              whiteSpace: 'nowrap',
              background: active ? 'var(--bg4)' : 'var(--bg2)',
              color: active ? 'var(--text0)' : 'var(--text2)',
              border: active ? '1px solid var(--border-hi)' : '1px solid var(--border)',
            }}
          >
            {t(SERVICE_CATEGORIES[key].labelKey)}
          </button>
        )
      })}
    </div>
  )
}

// Grouped flap incidents (same title, same day) — compact expandable row (#496)
export function GroupIncidentItem({ group, lang, t }) {
  const [expanded, setExpanded] = useState(false)
  // Use canonical dominantGroupStatus (handles 'ongoing' alias + uniformStatus fast-path)
  const dominantStatus = dominantGroupStatus(group)
  const barCls = INC_BAR_CLASS[dominantStatus] ?? INC_BAR_CLASS.resolved
  // entries[0] is newest because Overview pre-sorts input by compareIncidents before groupIncidents()
  const representative = group.entries[0]
  const serviceName = representative.serviceName ?? representative.affectedNames?.[0] ?? ''
  const dateStr = formatDate(group.rangeEnd, lang).split(' ').slice(0, 2).join(' ')
  // Show the SUM of all grouped flips' downtime (labeled "총"/"total"), not just
  // the newest entry's duration — a "×N" group's impact is every flip combined.
  // Reuses the canonical sumGroupDuration/formatDurationMs shared with Incidents.jsx;
  // null when nothing has resolved yet → falls back to the monitoring/ongoing label.
  const summed = sumGroupDuration(group)
  const totalDuration = summed.resolvedCount === 0
    ? null
    : summed.hasOngoing
      ? `${t('overview.incidents.total').replace('{d}', formatDurationMs(summed.totalMs))} + ${t('incidents.duration.ongoing')}`
      : t('overview.incidents.total').replace('{d}', formatDurationMs(summed.totalMs))
  return (
    <div style={{ marginBottom: '8px' }}>
      <div
        role="button"
        tabIndex={0}
        aria-expanded={expanded}
        className="flex gap-2.5 items-start cursor-pointer hover:bg-[var(--bg2)] rounded transition-colors focus:outline-none focus:ring-1 focus:ring-[var(--border-hi)]"
        style={{ padding: '2px 4px', margin: '-2px -4px' }}
        onClick={() => setExpanded(v => !v)}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setExpanded(v => !v) } }}
      >
        <div
          className="mono text-[10px] text-[var(--text2)] whitespace-nowrap shrink-0"
          style={{ width: '52px', paddingTop: '1px' }}
          title={`${dateStr} · ${group.count} occurrences`}
        >
          {dateStr}
        </div>
        <div className={`w-[2px] rounded self-stretch ${barCls}`} style={{ minHeight: '32px' }} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5 flex-wrap" style={{ marginBottom: '2px' }}>
            <div className="text-[12px] font-medium text-[var(--text0)] truncate">
              {serviceName} — {group.normalizedTitle}
            </div>
            <span
              className="shrink-0 mono bg-[var(--bg3)] text-[var(--text2)]"
              style={{ fontSize: '9px', padding: '1px 5px', borderRadius: '3px', letterSpacing: '0.04em' }}
            >
              ×{group.count}
            </span>
            <span className="shrink-0 text-[9px] text-[var(--text2)]" aria-hidden="true">
              {expanded ? '▾' : '▸'}
            </span>
          </div>
          <div className="mono text-[10px] text-[var(--text2)]">
            {totalDuration
              ?? (dominantStatus === 'monitoring' ? t('overview.incidents.monitoring') : t('incidents.status.ongoing'))}
          </div>
        </div>
      </div>
      {expanded && (
        <div
          className="border-l-2 border-[var(--border)]"
          style={{ marginLeft: '6px', paddingLeft: '8px', paddingTop: '4px', background: 'var(--bg0)', borderRadius: '0 4px 4px 0' }}
        >
          {group.entries.map(inc => (
            <IncidentItem key={inc.id} incident={{ ...inc, serviceName: inc.serviceName ?? serviceName, affectedNames: inc.affectedNames ?? [serviceName] }} lang={lang} t={t} />
          ))}
        </div>
      )}
    </div>
  )
}

// Incident item with time + bar + content + accordion timeline
function IncidentItem({ incident, lang, t }) {
  const [expanded, setExpanded] = useState(false)
  const barCls = INC_BAR_CLASS[incident.status] ?? INC_BAR_CLASS.resolved
  const hasTimeline = (incident.timeline ?? []).length > 0
  return (
    <div style={{ marginBottom: '8px' }}>
      <div
        className={`flex gap-2.5 items-start ${hasTimeline ? 'cursor-pointer hover:bg-[var(--bg2)] rounded transition-colors' : ''}`}
        style={{ padding: '2px 4px', margin: '-2px -4px' }}
        onClick={hasTimeline ? () => setExpanded((v) => !v) : undefined}
      >
        {(() => {
          // #406: align the displayed date with the sort axis (`getLatestActivity`).
          // Resolved → resolvedAt; monitoring/ongoing with a fresh timeline → last update;
          // else startedAt. Tooltip exposes the full label so users can still tell whether
          // the date is the start, an update, or the resolution.
          const ctx = getContextualTime(incident, t)
          return (
            <div
              className="mono text-[10px] text-[var(--text2)] whitespace-nowrap shrink-0"
              style={{ width: '52px', paddingTop: '1px' }}
              title={`${ctx.label} ${formatDate(ctx.date, lang)}`}
            >
              {formatDate(ctx.date, lang).split(' ').slice(0, 2).join(' ')}
            </div>
          )
        })()}
        <div className={`w-[2px] rounded self-stretch ${barCls}`} style={{ minHeight: '32px' }} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5">
            <div className="text-[12px] font-medium text-[var(--text0)] truncate" style={{ marginBottom: '2px' }}>
              {(incident.affectedNames?.length > 1 ? incident.affectedNames.join(', ') : incident.serviceName)} — {incident.title}
            </div>
            {hasTimeline && expanded && (
              <span className="shrink-0 text-[9px] text-[var(--text2)]">▾</span>
            )}
          </div>
          <div className="mono text-[10px] text-[var(--text2)]">
            {incident.duration ?? (incident.status === 'monitoring' ? t('overview.incidents.monitoring') : t('incidents.status.ongoing'))}
          </div>
        </div>
      </div>
      {expanded && (
        <div className="ml-[66px]">
          <IncidentTimeline
            title={`${incident.affectedNames?.length > 1 ? incident.affectedNames.join(', ') : incident.serviceName} — ${incident.title}`}
            subtitle={`${formatDate(incident.startedAt, lang)}  ·  ${incident.duration ?? (incident.status === 'monitoring' ? t('overview.incidents.monitoring') : t('incidents.status.ongoing'))}`}
            timeline={incident.timeline}
            onClose={() => setExpanded(false)}
            hideHeader
            t={t}
            lang={lang}
          />
        </div>
      )}
    </div>
  )
}

// Latency bar with colored fill per speed tier
function LatencyBar({ service, maxLatency }) {
  const widthPct = maxLatency > 0 ? Math.round((service.latency / maxLatency) * 100) : 0
  const fillCls = service.latency < 500 ? 'bg-[var(--green)]' : service.latency < 800 ? 'bg-[var(--amber)]' : 'bg-[var(--red)]'
  const valColor = service.latency < 500 ? '' : service.latency < 800 ? 'text-[var(--amber)]' : 'text-[var(--red)]'
  return (
    <div className="flex items-center" style={{ gap: '10px' }}>
      <span className="mono text-[10px] text-[var(--text1)] shrink-0 whitespace-nowrap truncate" style={{ width: '90px' }}>{service.name}</span>
      <div className="flex-1 bg-[var(--bg3)] rounded-sm overflow-hidden" style={{ height: '4px' }}>
        <div className={`h-full rounded-sm ${fillCls}`} style={{ width: `${widthPct}%` }} />
      </div>
      <span className={`mono text-[10px] shrink-0 text-right ${valColor || 'text-[var(--text1)]'}`} style={{ width: '40px' }}>
        {service.latency != null ? `${service.latency}ms` : '—'}
      </span>
    </div>
  )
}

// Panel wrapper matching design mockup (header + body)
function Panel({ title, dotColor, subtitle, children }) {
  return (
    <div className="bg-[var(--bg1)] border border-[var(--border)] rounded-lg overflow-hidden">
      <div className="flex items-center justify-between border-b border-[var(--border)]" style={{ padding: '12px 14px' }}>
        <div className="mono text-[10px] text-[var(--text1)] uppercase tracking-wider flex items-center gap-1.5">
          <span className="w-[5px] h-[5px] rounded-full shrink-0" style={{ background: dotColor }} />
          {title}
        </div>
        {subtitle && <span className="mono text-[9px] text-[var(--text2)]">{subtitle}</span>}
      </div>
      <div style={{ padding: '14px' }}>
        {children}
      </div>
    </div>
  )
}

// ── Action Banner — shows fallback recommendations during outages ──

// #574 — Supply-chain correlation banner: an AWS region is degraded AND ≥1 AWS-dependent AI service
// is also degraded (the worker's correlation gate; `banner` is null otherwise). Rendered as a sibling
// ABOVE ActionBanner. AIWatch's differentiator vs AIDown's static dependency map = this LIVE gate.
function SupplyChainBanner({ banner, setPage, t }) {
  if (!banner) return null
  const isDown = banner.severity === 'down'
  const borderColor = isDown ? 'var(--red)' : 'var(--amber)'
  const regionStr = banner.regions.map(r => r.region).join(', ')
  const sevLabel = t(isDown ? 'supplychain.region.down' : 'supplychain.region.degraded')
  const summary = banner.regions.find(r => r.summary)?.summary
  const names = (list) => list.map((s, i) => (
    <span key={s.id}>
      {i > 0 && ', '}
      <span className="hover:underline cursor-pointer" onClick={() => setPage({ name: 'service', serviceId: s.id })}>{s.name}</span>
    </span>
  ))
  // NOTE: spacing via inline style — this project's Tailwind build does NOT compile the p-/m-/gap-
  // scale utilities (e.g. `.p-4` resolves to 0), so all padding/margins are inline (see StatCard).
  return (
    <div data-testid="supply-chain-banner" className="bg-[var(--bg1)] border border-[var(--border)] rounded-lg" style={{ borderLeft: `3px solid ${borderColor}`, padding: '14px 16px' }}>
      <div className="mono text-[12px] font-medium" style={{ color: borderColor }}>
        ⚠ {t('supplychain.title')} — {regionStr} ({sevLabel})
      </div>
      {summary && <div className="mono text-[11px] text-[var(--text2)]" style={{ marginTop: '4px' }}>{summary}</div>}
      {banner.affectedNow.length > 0 && (
        <div className="mono text-[11px] text-[var(--text1)]" style={{ marginTop: '8px' }}>
          <span className="text-[var(--text2)]">{t('supplychain.affectingNow')} </span>{names(banner.affectedNow)}
        </div>
      )}
      {banner.mayBeAffected.length > 0 && (
        <div className="mono text-[11px] text-[var(--text2)]" style={{ marginTop: '4px' }}>
          {t('supplychain.mayAffect')} {names(banner.mayBeAffected)}
        </div>
      )}
    </div>
  )
}

export function ActionBanner({ services, setPage, t }) {
  const affected = services.filter(s => s.status === 'down' || s.status === 'degraded')
  const withActiveIncidents = services.filter(s => s.status === 'operational' && (s.incidents ?? []).some(i => i.status !== 'resolved'))
  const monitoring = withActiveIncidents.filter(s => (s.incidents ?? []).some(i => i.status === 'monitoring') && !(s.incidents ?? []).some(i => i.status === 'investigating' || i.status === 'identified'))
  const investigating = withActiveIncidents.filter(s => !monitoring.includes(s))
  if (affected.length === 0 && withActiveIncidents.length === 0) return null

  const downList = affected.filter(s => s.status === 'down')
  const degradedList = affected.filter(s => s.status === 'degraded')
  const hasDown = downList.length > 0
  const borderColor = hasDown ? 'var(--red)' : affected.length > 0 ? 'var(--amber)' : 'var(--blue)'

  // Render clickable service names
  const renderNames = (list) => list.map((svc, i) => (
    <span key={svc.id}>
      {i > 0 && ', '}
      <span className="hover:underline cursor-pointer" onClick={() => setPage({ name: 'service', serviceId: svc.id })}>{svc.name}</span>
    </span>
  ))

  // Region-switch recommendations (refs #422 Phase 1). For each affected service
  // whose status page reports per-region incidents AND has at least one healthy
  // region, surface "Pinecone → AWS US West" alongside the cross-service fallback.
  // Region switch is structurally cheaper than service switch (same SDK / IAM /
  // billing) so it deserves first-line visibility — today this guidance is
  // siloed in ServiceDetails and requires a click to discover.
  //
  // Skip when:
  //   • regionStatusOf returns null (no region map / no relevant incidents)
  //   • hasRegionSpecific === false (global-incident fallback path — every
  //     region marked affected; suggesting "switch region" would be misleading)
  //   • allDown — no OK region to recommend
  const regionRecs = []
  for (const svc of affected) {
    const rs = regionStatusOf(svc)
    if (!rs || !rs.hasRegionSpecific || rs.allDown || !rs.recommendedRegion) continue
    regionRecs.push({
      svc,
      recommendedRegion: rs.recommendedRegion,
      docsUrl: rs.docsUrl,
    })
  }

  // Per-category fallback groups (#445), EXCLUDING services that already have a region-switch
  // recommendation (#641 — a region-specific outage is solved by the cheaper same-provider region
  // switch shown above, so a cross-provider fallback alongside it is redundant noise). Per-service:
  // an affected service without a region switch keeps its cross-service fallback. Helper is unit-tested.
  const categoryGroups = getGroupedFallbacksExcludingRegionSwitchable(affected, services)

  return (
    <div className="bg-[var(--bg1)] border border-[var(--border)] rounded-lg" style={{ padding: '10px 14px', lineHeight: 1.5, borderLeft: `3px solid ${borderColor}` }}>
      {downList.length > 0 && (
        <div className="text-[13px] font-medium text-[var(--text0)]">
          🔴 <span className="text-[var(--red)]">{t('overview.banner.downCount').replace('{n}', downList.length)}</span> {renderNames(downList)}
        </div>
      )}
      {degradedList.length > 0 && (
        <div className="text-[13px] font-medium text-[var(--text0)]">
          ⚠️ <span className="text-[var(--amber)]">{t('overview.banner.degradedCount').replace('{n}', degradedList.length)}</span> {renderNames(degradedList)}
        </div>
      )}
      {investigating.length > 0 && (
        <div className="text-[13px] font-medium text-[var(--text0)]">
          🔍 <span className="text-[var(--blue)]">{t('overview.banner.investigatingCount').replace('{n}', investigating.length)}</span> {renderNames(investigating)}
        </div>
      )}
      {monitoring.length > 0 && (
        <div className="text-[13px] font-medium text-[var(--text0)]">
          👀 <span className="text-[var(--blue)]">{t('overview.banner.monitoringCount').replace('{n}', monitoring.length)}</span> {renderNames(monitoring)}
        </div>
      )}
      {(withActiveIncidents.length > 0 || affected.some(s => (s.incidents ?? []).some(i => i.status !== 'resolved'))) && (
        <div className="mono text-[11px]" style={{ marginTop: '4px' }}>
          <button
            onClick={() => setPage({ name: 'incidents' })}
            className="text-[var(--blue)] hover:underline cursor-pointer"
            style={{ background: 'none', border: 'none', padding: 0, font: 'inherit' }}
          >
            👉 {t('overview.banner.viewIncidents')}
          </button>
        </div>
      )}
      {/* Subscribe CTA at the visitor's peak-intent moment (#433) — an incident
          is active, so motivation is highest. A labeled orange link (not a bare
          corner glyph, which got lost) in the action row; copies /feed.xml. */}
      <div className="mono text-[11px]" style={{ marginTop: '4px' }}>
        <RssCopyIcon url={ALL_SERVICES_FEED_URL} location="action_banner" label={t('rss.copy.subscribe')} />
      </div>
      {/* Region-switch recommendation line (refs #422 Phase 1). Renders before
          cross-service fallback so the cheaper-to-execute action lands first.
          Service name is clickable (drills into ServiceDetails for the full
          region card); the recommended-region label links out to the provider's
          region docs and fires region_switch_intent GA4 with location=action_banner. */}
      {regionRecs.length > 0 && (
        <div className="mono text-[11px] text-[var(--text2)]" style={{ marginTop: '4px' }}>
          <span>{t('overview.banner.regionSwitch')}</span>
          {regionRecs.map((rec, ri) => (
            <span key={rec.svc.id}>
              {ri > 0 && ' · '}
              {' '}
              <span
                className="text-[var(--text0)] hover:underline cursor-pointer"
                onClick={() => setPage({ name: 'service', serviceId: rec.svc.id })}
              >
                {rec.svc.name}
              </span>
              <span className="text-[var(--text2)]"> → </span>
              {rec.docsUrl ? (
                <a
                  href={rec.docsUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-[var(--green)] hover:underline"
                  onClick={() => trackEvent('region_switch_intent', { service_id: rec.svc.id, recommended_region: rec.recommendedRegion.key, location: 'action_banner' })}
                >
                  {rec.recommendedRegion.label}
                </a>
              ) : (
                <span className="text-[var(--green)]">{rec.recommendedRegion.label}</span>
              )}
            </span>
          ))}
        </div>
      )}
      {categoryGroups.length > 0 ? (
        // #842 — inline fallback line (natural with the banner), but each alternative's name is
        // followed by a compact "Open ↗" PILL button placed right after it (no wasted space-between
        // gap, no heavy boxed area). Name → ServiceDetails (internal); pill → provider site (outbound).
        <div className="mono text-[11px] text-[var(--text2)]" style={{ marginTop: '4px' }}>
          <span>{t('overview.banner.fallback')}</span>
          {categoryGroups.map((grp, gi) => (
            <span key={`${grp.category}:${grp.label}`}>
              {gi > 0 && ' · '}
              {' '}<span className="text-[var(--text2)]">{grp.label} → </span>
              {grp.items.map((f, fi) => {
                const outUrl = outboundReferralUrl(f.id)
                return (
                  // #903 — the ', ' separator lives OUTSIDE the nowrap item span so a line
                  // break can occur BETWEEN alternatives (else two glued items overflow the
                  // banner on mobile, clipping the trailing "Open ↗" pill). Intra-item nowrap
                  // still keeps each name+pill together.
                  <Fragment key={f.id}>
                    {fi > 0 && ', '}
                    <span style={{ whiteSpace: 'nowrap' }}>
                      <span
                        className="text-[var(--green)] hover:underline cursor-pointer"
                        onClick={() => { trackEvent('fallback_click', { from_service: 'banner', to_service: f.id, location: 'action_banner' }); setPage({ name: 'service', serviceId: f.id }) }}
                      >
                        {f.name}{f.aiwatchScore != null ? ` (${f.aiwatchScore})` : ''}
                      </span>
                      {outUrl && (
                        <a
                          href={outUrl} target="_blank" rel="nofollow noopener noreferrer"
                          className="text-[9px] rounded-sm border border-[var(--green)] text-[var(--green)] hover:bg-[var(--green)] hover:text-[var(--bg0)] no-underline"
                          style={{ marginLeft: '4px', padding: '0 4px', verticalAlign: 'middle', lineHeight: '1.4' }}
                          onClick={() => { trackEvent('outbound_fallback_click', { from_service: 'banner', to_service: f.id, location: 'action_banner' }); sendReferralBeacon('', f.id) }}
                          aria-label={`Open ${f.name} (opens provider site)`}
                        >{t('overview.banner.openAlt')}</a>
                      )}
                    </span>
                  </Fragment>
                )
              })}
            </span>
          ))}
          {categoryGroups.some(g => g.items.some(f => outboundReferralUrl(f.id))) && (
            <div className="text-[10px] text-[var(--text2)]" style={{ marginTop: '3px', opacity: 0.8 }}>
              {t('overview.banner.outboundNote')}
            </div>
          )}
        </div>
      ) : null}
      {/* #641 — when there's no fallback recommendation we render nothing here (no
          "No direct fallback available" claim — that's a subjective statement from our
          own incomplete coverage). Region-switch above stays; it's a real alternative. */}
    </div>
  )
}

// ── Main Component ───────────────────────────────────────────

export default function Overview() {
  const { t, lang } = useLang()
  const { setPage, categoryFilter, setCategoryFilter } = usePage()
  const { services: allServices, loading, error, lastUpdated, refresh, recentlyRecovered, aiAnalysis, securityAlerts, probeServiceIds, reportFeed, supplyChainBanner } = usePolling()
  const { settings } = useSettings()
  const services = allServices.filter((s) => settings.enabledServices.includes(s.id))
  const [filter, setFilter] = useState('all')
  const [reportOpen, setReportOpen] = useState(false)

  // #575 — flatten the gated crowd-report map into a single newest-first list for the panel.
  const reportItems = useMemo(() => {
    const nameOf = new Map(allServices.map((s) => [s.id, s.name]))
    return Object.entries(reportFeed ?? {})
      .flatMap(([id, entries]) => (entries ?? []).map((e) => ({ serviceName: nameOf.get(id) ?? id, cat: e.cat, desc: e.desc, ts: e.ts })))
      .sort((a, b) => b.ts - a.ts)
      .slice(0, 20)
  }, [reportFeed, allServices])

  // Reset status filter when category changes
  useEffect(() => { setFilter('all') }, [categoryFilter])

  // Apply sidebar category filter
  const categoryIds = SERVICE_CATEGORIES[categoryFilter]?.ids
  const catServices = categoryIds ? services.filter((s) => categoryIds.includes(s.id)) : services

  if (loading && services.length === 0) return <SkeletonUI />
  if (!loading && services.length === 0 && error) return <EmptyState type="offline" onAction={refresh} />

  if (error) {
    return (
      <div>
        <EmptyState type="error" onAction={() => window.location.reload()} />
        {lastUpdated && (
          <p className="mt-2 text-center text-xs text-[var(--text2)]">
            {t('overview.last.updated')}: {formatTime(lastUpdated, lang)}
          </p>
        )}
      </div>
    )
  }

  // Stats are based on category-filtered services
  const operationalCount = catServices.filter((s) => s.status === 'operational').length
  const degradedCount    = catServices.filter((s) => s.status === 'degraded').length
  const downCount        = catServices.filter((s) => s.status === 'down').length
  const issueCount       = degradedCount + downCount
  const uptimeServices = catServices.filter((s) => s.uptime30d != null && !isUnreliableUptime(s))
  const avgUptime = uptimeServices.length
    ? (uptimeServices.reduce((sum, s) => sum + s.uptime30d, 0) / uptimeServices.length).toFixed(1)
    : '—'

  const statusPriority = { down: 0, degraded: 1, operational: 2 }
  const issueSort = (a, b) => (statusPriority[a.status] - statusPriority[b.status]) || ((a.aiwatchScore ?? 0) - (b.aiwatchScore ?? 0))
  const applyStatusFilter = (list) =>
    filter === 'operational' ? list.filter((s) => s.status === 'operational')
    : filter === 'issues'    ? [...list.filter((s) => s.status !== 'operational')].sort(issueSort)
    : list

  // Build per-category sections mirroring the sidebar taxonomy (#646), replacing the old
  // Services-blob + Coding-Agents-only split. In 'all' mode render all six sections in SECTION_KEYS
  // (dev-audience) order (#658); when a specific category is active, catServices is already scoped to
  // it → render just that one section.
  const sectionKeys = categoryFilter === 'all' ? SECTION_KEYS : SECTION_KEYS.filter((k) => k === categoryFilter)
  const matched = new Set()
  const sections = sectionKeys.map((key) => {
    const ids = SERVICE_CATEGORIES[key].ids
    const members = catServices.filter((s) => ids.includes(s.id))
    members.forEach((s) => matched.add(s.id))
    return { key, labelKey: SERVICE_CATEGORIES[key].labelKey, services: applyStatusFilter(members) }
  })
  // Defensive catch-all (only reachable in 'all' mode — in single-category mode catServices is itself
  // scoped to that category's ids): a known/enabled service that no category claims (e.g. a new service
  // added to ALL_SERVICE_IDS but not yet to SERVICE_CATEGORIES) would otherwise silently vanish —
  // surface it under "Services". The partition invariant is pinned by constants.test.js.
  const leftover = catServices.filter((s) => !matched.has(s.id))
  if (leftover.length) sections.push({ key: 'other', labelKey: 'nav.services', services: applyStatusFilter(leftover) })
  // #553: the empty state spans ALL rendered sections. issueCount and totalShown are both derived from
  // the category-scoped catServices, so they stay consistent — an issue in any rendered section keeps
  // "No Issues" from showing.
  const totalShown = sections.reduce((n, sec) => n + sec.services.length, 0)

  const sevenDaysAgo = Date.now() - 7 * 86_400_000
  // Dedup by incident ID (Anthropic bulk-links one incident to claude.ai + Claude API + Claude Code)
  // while collecting every affected service name. Mirrors the Incidents.jsx aggregation pattern.
  // Recent Incidents intentionally spans ALL enabled services (`services`), NOT the category-filtered
  // `catServices` — a category filter scopes the stats/sections, but the incidents panel is a
  // cross-category "what's happening right now" view, so picking a category must not hide live incidents
  // from other categories. (Still honors the user's enabled-services subset via `services`.)
  // #798 — Latency Rankings (below) is ALSO cross-category for the same reason: it ranks fastest/slowest
  // across everything, so it uses `services`, not `catServices` — only stats + the service grid scope.
  const incMap = new Map()
  for (const s of services) {
    for (const inc of s.incidents ?? []) {
      const existing = incMap.get(inc.id)
      if (existing) {
        if (!existing.affectedNames.includes(s.name)) existing.affectedNames.push(s.name)
      } else {
        incMap.set(inc.id, { ...inc, serviceName: s.name, affectedNames: [s.name] })
      }
    }
  }
  // Apply flap grouping (#496): BetterStack services emit many same-title incidents per day
  // with unique IDs (Fireworks, Together, Mistral). groupIncidents() collapses ≥2 same-title
  // incidents on the same local day into one group row, preventing them from filling the panel.
  const recentIncidents = groupIncidents(
    [...incMap.values()]
      .filter((inc) => inc.status !== 'resolved' || new Date(inc.startedAt).getTime() >= sevenDaysAgo)
      .sort(compareIncidents)
  ).sort(compareGroupedRows).slice(0, 5)

  const withLatency = services.filter((s) => s.latency != null) // #798 — all services, not catServices (cross-category like Recent Incidents)
  const sortedByLatency = [...withLatency].sort((a, b) => a.latency - b.latency)
  const maxLatency = withLatency.length ? Math.max(...withLatency.map((s) => s.latency)) : 1

  return (
    <div className="flex flex-col" style={{ gap: '20px' }}>

      {/* ── #575 — crowd report entry: a floating action button (no layout row; reachable while
            scrolling). Input is never gated; the modal picks the service. The gated "Recent user
            reports" panel is at the bottom. ── */}
      <button
        type="button"
        onClick={() => setReportOpen(true)}
        aria-label={t('report.button')}
        className="fixed flex items-center gap-1.5 mono text-[11px] text-[var(--text0)] rounded-full shadow-lg hover:brightness-110 z-40"
        style={{ bottom: '20px', right: '20px', padding: '10px 16px', background: 'var(--bg3)', border: '1px solid var(--border-hi)' }}
      >
        <span aria-hidden="true">⚠</span> {t('report.button')}
      </button>
      <ReportModal isOpen={reportOpen} onClose={() => setReportOpen(false)} services={services} />

      {/* ── Action Banner (outage fallback) ── */}
      <ActionBanner services={services} setPage={setPage} t={t} />

      {/* ── Recently Resolved Banner ── */}
      {Object.keys(recentlyRecovered).some(id => services.find(s => s.id === id)) && (
        <div className="rounded-lg border" style={{ borderColor: 'var(--blue)', background: 'var(--blue-dim)', padding: '12px 16px' }}>
          {/* Header row: label + See-Analysis link */}
          <div className="flex items-center gap-2 flex-wrap text-[12px]">
            <span style={{ color: 'var(--blue)' }}>✓</span>
            <span className="text-[var(--text0)] font-medium">
              {t('overview.recentlyResolved')}
            </span>
            {Object.keys(recentlyRecovered).some(id => aiAnalysis[id]) && (
              <span
                className="mono text-[10px] cursor-pointer hover:underline"
                style={{ color: 'var(--blue)' }}
                onClick={() => window.dispatchEvent(new CustomEvent('open-analysis'))}
              >
                🤖 {t('overview.seeAnalysis')}
              </span>
            )}
          </div>
          {/* One row per recovered service so multiple services stay visually distinct (#827 F4) */}
          <div className="flex flex-col" style={{ gap: '3px', marginTop: '6px' }}>
            {Object.keys(recentlyRecovered).map(id => {
              const svc = services.find(s => s.id === id)
              if (!svc) return null
              // #827 F4 — "how our estimate held up" beside the recovered service (detail stays in the
              // modal). Null when not computable (e.g. the incident already aged out of the feed).
              const recIncIds = recentlyRecovered[id] ?? []
              const analyses = aiAnalysis[id] ?? []
              const analysis = analyses.find(a => recIncIds.includes(a.incidentId)) ?? analyses[0]
              const inc = svc.incidents?.find(i => i.id === analysis?.incidentId)
              const outcome = computePredictionOutcome(analysis, inc)
              // Natural phrase: actual recovery time as the lead, the estimate folded into one
              // direction-aware fragment — "42m 만에 복구 (예측 ~1h 이내)" / "3h 10m 만에 복구 (예측 ~1h 초과)".
              const detail = outcome && (lang === 'ko'
                ? `${outcome.actualText} 만에 복구 (${withinEstimateText(outcome, lang)})`
                : `recovered in ${outcome.actualText} (${withinEstimateText(outcome, lang)})`)
              return (
                <div key={id} className="text-[12px]">
                  <span
                    className="cursor-pointer hover:underline font-medium"
                    style={{ color: 'var(--blue)' }}
                    onClick={() => setPage({ name: 'service', serviceId: id })}
                  >{svc.name}</span>
                  {detail && <span className="mono text-[10px] text-[var(--text2)]"> — {detail}</span>}
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* ── Security Alerts Banner (24h only) ── */}
      {(() => {
        const cutoff = Date.now() - 24 * 3600_000
        const recent = (securityAlerts ?? []).filter(a => a.detectedAt && new Date(a.detectedAt).getTime() > cutoff)
        if (recent.length === 0) return null
        return (
          <div className="rounded-lg border border-[var(--purple)]" style={{ background: 'color-mix(in srgb, var(--purple) 8%, transparent)', padding: '8px 12px' }}>
            <div className="flex flex-col gap-0.5 text-[12px] min-w-0">
              <span className="text-[var(--text0)] font-medium mono text-[11px]">
                🔒 {t('overview.security.title')} ({recent.length})
              </span>
              {recent.slice(0, 3).map((a, i) => {
                const safeUrl = a.url?.startsWith('https://') ? a.url : '#'
                // Derive service tag: use service field (OSV) or detect from title (HN).
                // #821 — provider-only HN matches resolve to the provider's primary service
                // (shared helper, mirrors the detail-page matcher). Logic in src/utils/securityAlerts.js.
                let tag = a.service || ''
                if (!tag) {
                  // Use the FULL service list (not the enabled-filtered `services`) so the
                  // provider-primary resolution matches the detail page, which sees all services.
                  const match = tagServiceForAlert(a, allServices)
                  if (match) tag = match.name
                }
                // #326: EPSS prefix mirroring ServiceDetails. Thresholds duplicated
                // here because the frontend bundle cannot import from worker — keep
                // in sync with EPSS_ACTIVE (0.8) / EPSS_ELEVATED (0.5) in
                // worker/src/security-monitor.ts.
                const epss = a.epssPercentile
                let epssTag = null
                if (typeof epss === 'number') {
                  if (epss >= 0.8) epssTag = { icon: '🔥', color: 'var(--red)' }
                  else if (epss >= 0.5) epssTag = { icon: '⚠️', color: 'var(--amber)' }
                }
                return (
                  <a key={i} href={safeUrl} target="_blank" rel="noopener noreferrer"
                    className="text-[var(--text1)] hover:text-[var(--purple)] truncate text-[11px]"
                  >
                    {a.severity === 'critical' ? '🔴' : a.severity === 'high' ? '🟠' : '🟡'}
                    {epssTag && (
                      <span style={{ color: epssTag.color, marginLeft: '4px' }}
                        title={`EPSS ${Math.round(epss * 100)}th percentile — ${epss >= 0.8 ? 'actively exploited' : 'elevated exploit risk'}`}
                      >{epssTag.icon}</span>
                    )}
                    {' '}{tag ? `[${tag}] ` : ''}{a.title}
                  </a>
                )
              })}
            </div>
          </div>
        )
      })()}

      {/* #574 — supply-chain banner: directly ABOVE the "Operational · N services running" summary cards. */}
      <SupplyChainBanner banner={supplyChainBanner} setPage={setPage} t={t} />

      {/* ── Summary Stats ── */}
      <div className="grid grid-cols-2 md:grid-cols-4" style={{ gap: '10px' }}>
        <StatCard index={0} value={operationalCount} sub={t('overview.stats.operational.sub')} labelKey="overview.stats.operational" colorClass="text-[var(--green)]" t={t} />
        <StatCard index={1} value={degradedCount}    sub={t('overview.stats.degraded.sub')}    labelKey="overview.stats.degraded"    colorClass="text-[var(--amber)]" t={t} />
        <StatCard index={2} value={downCount}         sub={t('overview.stats.down.sub')}        labelKey="overview.stats.down"         colorClass="text-[var(--red)]"   t={t} />
        <StatCard index={3} value={avgUptime === '—' ? '—' : `${avgUptime}%`}  sub={t('overview.stats.uptime.sub')}  labelKey="overview.stats.uptime"       colorClass="text-[var(--blue)]"  t={t} />
      </div>

      {/* ── Services controls (#646) ──
          No standalone "// Services" group title: the category tab row already labels this area, and a
          group title stacked above the per-category section headers (// AI Apps, // LLM APIs, …) was
          redundant. Layout: category row above status row on mobile (items-start so the status filter
          shrinks to its content width instead of stretching full-width); centered single row on desktop. */}
      <div className="flex flex-col items-start gap-3 md:flex-row md:items-center md:justify-between">
        <CategoryTabs categoryFilter={categoryFilter} setCategoryFilter={setCategoryFilter} t={t} />
        <FilterTabs filter={filter} setFilter={setFilter} total={catServices.length} issueCount={issueCount} downCount={downCount} t={t} />
      </div>

      {/* ── Per-category service sections (#646) ──
          Each category (AI Apps / LLM APIs / Voice & Inference / Coding Agents) is a peer section
          with its own header — no Coding-Agents-only special case. Empty sections are not rendered;
          the shared "No Issues" empty state shows only when NO section has a match (#553). */}
      {filter === 'issues' && totalShown === 0 ? (
        <EmptyState type="good" />
      ) : (
        sections.filter((sec) => sec.services.length > 0).map((sec) => (
          <section key={sec.key} className="flex flex-col" style={{ gap: '8px' }}>
            <h2 className="mono text-[10px] text-[var(--text2)] uppercase flex items-center gap-2" style={{ letterSpacing: '0.1em' }}>
              <span className="text-[var(--green)] font-semibold">//</span>
              {t(sec.labelKey)}
            </h2>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3" style={{ gap: '8px' }}>
              {sec.services.map((svc, i) => (
                <ServiceCard
                  key={svc.id}
                  service={svc}
                  index={i}
                  t={t}
                  isProbed={probeServiceIds.includes(svc.id)}
                  isRecovered={!!recentlyRecovered[svc.id]}
                  onClick={() => { trackEvent('select_service', { service_id: svc.id }); setPage({ name: 'service', serviceId: svc.id }) }}
                />
              ))}
            </div>
          </section>
        ))
      )}

      {/* ── Recent Incidents (official) vs Recent user reports (crowd) — side by side so the two can
            be compared. The crowd panel is gated (#575): rendered only when the worker surfaced
            corroborated reports; when absent, Recent Incidents takes the full width. ── */}
      <div className={reportItems.length > 0 ? 'grid grid-cols-1 lg:grid-cols-2' : ''} style={{ gap: '10px' }}>
        <Panel title={t('overview.incidents.title')} dotColor="var(--red)" subtitle={t('overview.panel.incidents.sub')}>
          {recentIncidents.length === 0 ? (
            <EmptyState type="good" />
          ) : (
            <div>
              {recentIncidents.map((row) =>
                row.kind === 'single'
                  ? <IncidentItem key={row.incident.id} incident={row.incident} lang={lang} t={t} />
                  : <GroupIncidentItem key={`group:${row.dayKey}:${row.normalizedTitle}`} group={row} lang={lang} t={t} />
              )}
            </div>
          )}
        </Panel>

        {reportItems.length > 0 && (
          <Panel title={t('report.feed.title')} dotColor="var(--purple)" subtitle={t('report.feed.sub')}>
            <RecentUserReports items={reportItems} />
          </Panel>
        )}
      </div>

      {/* ── Latency Rankings — full width, at the very bottom ── */}
      <Panel title={t('overview.latency.title')} dotColor="var(--teal)" subtitle={t('overview.panel.latency.sub')}>
        <div className="flex flex-col" style={{ gap: '8px' }}>
          {sortedByLatency.map((svc) => (
            <LatencyBar key={svc.id} service={svc} maxLatency={maxLatency} />
          ))}
        </div>
      </Panel>

    </div>
  )
}
