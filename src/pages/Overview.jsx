// Overview — summary stats, service grid, recent incidents, latency rankings, AI panel.
// Design mockup: svc-card with left border, provider, 3-col metrics, variable-height history bars.

import { useState, useEffect } from 'react'
import IncidentTimeline from '../components/IncidentTimeline'
import { useLang } from '../hooks/useLang'
import { usePage } from '../utils/pageContext'
import { usePolling } from '../hooks/usePolling'
import { useSettings } from '../hooks/useSettings'
import { trackEvent } from '../utils/analytics'
import { SCORE_BG_CLASS, SERVICE_CATEGORIES, EXCLUDE_FALLBACK, API_TIER, getFallbacks } from '../utils/constants'
import { buildCalendarFromIncidents } from '../utils/calendar'
import { formatTime, formatDate } from '../utils/time'
import SkeletonUI from '../components/SkeletonUI'
import StatusPill from '../components/StatusPill'
import EmptyState from '../components/EmptyState'

// ── Status color maps ────────────────────────────────────────

// Border-left now applied via inline style in ServiceCard

const HISTORY_CLASS = {
  operational:    'bg-[var(--green)]',
  degraded_perf:  'bg-[var(--yellow)]',
  degraded:       'bg-[var(--amber)]',
  down:           'bg-[var(--red)]',
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

function ServiceCard({ service, index, onClick, t, isRecovered }) {
  const incidentCount = (service.incidents ?? []).filter((i) => i.status !== 'resolved').length
  const isEstimateOnly = service.uptimeSource === 'estimate' && (service.incidents ?? []).length === 0
  const hasUptime = service.uptime30d != null && !isEstimateOnly
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
        borderLeft: `3px solid ${service.status === 'down' ? 'var(--red)' : service.status === 'degraded' ? 'var(--amber)' : 'var(--green)'}`,
      }}
    >
      {/* ── Mobile compact layout ── */}
      <div className="md:hidden" style={{ padding: '10px 12px' }}>
        <div className="flex justify-between items-center" style={{ marginBottom: '4px' }}>
          <span className="text-[13px] font-medium text-[var(--text0)] truncate min-w-0">{service.name}</span>
          <div className="flex items-center gap-1.5">
            {isRecovered && <span className="mono text-[9px] rounded" style={{ color: 'var(--blue)', background: 'var(--blue-dim)', padding: '3px 8px' }}>{t('overview.recovered')}</span>}
            <StatusPill status={service.status} />
          </div>
        </div>
        <div className="flex items-center justify-between" style={{ marginBottom: '4px' }}>
          <span className="mono text-[10px] text-[var(--text2)]">
            <span className={uptimeColor}>{uptimeStr}</span>
            {!isEstimateOnly && incidentCount > 0 && <>{' · '}<span className="text-[var(--red)]">{incidentCount}{t('overview.card.incidents.compact')}</span></>}
            {!isEstimateOnly && scoreStr && <>{' · '}{scoreStr}</>}
          </span>
        </div>
        <HistoryBars history30d={buildCalendarFromIncidents(service.incidents, service.dailyImpact)} compact />
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
            <StatusPill status={service.status} />
          </div>
        </div>

        <div className="grid grid-cols-3" style={{ gap: '6px', marginBottom: '10px', textAlign: 'center' }}>
          <div>
            <div className={`mono text-[13px] font-medium ${latencyColor}`}>{service.latency != null ? `${service.latency}ms` : '—'}</div>
            <div className="mono text-[9px] text-[var(--text2)]" style={{ letterSpacing: '0.04em' }}>{t('overview.card.latency')}</div>
          </div>
          <div>
            <div className={`mono text-[13px] font-medium ${uptimeColor}`} title={!hasUptime ? t('uptime.unavailable.tooltip') : undefined}>
              {uptimeStr}
            </div>
            <div className="mono text-[9px] text-[var(--text2)]" style={{ letterSpacing: '0.04em' }}>{t('overview.card.uptime')}</div>
          </div>
          <div>
            <div className={`mono text-[13px] font-medium ${isEstimateOnly ? 'text-[var(--text2)]' : 'text-[var(--text0)]'}`}>{isEstimateOnly ? '—' : incidentCount}</div>
            <div className="mono text-[9px] text-[var(--text2)]" style={{ letterSpacing: '0.04em' }}>{t('overview.card.incidents')}</div>
          </div>
        </div>

        {service.aiwatchScore != null && !isEstimateOnly && (
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

        <HistoryBars history30d={buildCalendarFromIncidents(service.incidents, service.dailyImpact)} />
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
        <div className="mono text-[10px] text-[var(--text2)] whitespace-nowrap shrink-0" style={{ width: '52px', paddingTop: '1px' }}>
          {formatDate(incident.startedAt, lang).split(' ').slice(0, 2).join(' ')}
        </div>
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

function ActionBanner({ services, setPage, t }) {
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

  // Collect fallbacks per tier group — exclude non-operational + same provider
  const TIER_LABEL = { 1: 'LLM', 2: 'LLM', 3: 'Infra', 4: 'Voice' }
  const CATEGORY_LABEL = { api: 'API', app: 'AI Apps', agent: 'Coding' }
  const nonOperationalIds = new Set(services.filter(s => s.status !== 'operational').map(s => s.id))
  const affectedProviders = new Set(affected.map(s => s.provider))
  const seenGroups = new Set() // category or category:tierLabel for api services
  const categoryGroups = [] // [{ category, label, items: [{ id, name, aiwatchScore }] }]
  const eligibleAffected = affected.filter(a => !EXCLUDE_FALLBACK.includes(a.id))
  const numGroups = new Set(eligibleAffected.map(a => {
    const tier = API_TIER[a.id] ?? 99
    const tierLabel = TIER_LABEL[tier]
    return tierLabel ? `${a.category}:${tierLabel}` : a.category
  })).size
  const perGroup = numGroups === 1 ? 2 : 1
  for (const svc of affected) {
    if (EXCLUDE_FALLBACK.includes(svc.id)) continue
    const tier = API_TIER[svc.id] ?? 99
    const tierLabel = TIER_LABEL[tier]
    const groupKey = tierLabel ? `${svc.category}:${tierLabel}` : svc.category
    if (seenGroups.has(groupKey)) continue
    seenGroups.add(groupKey)
    const candidates = getFallbacks(svc, services).filter(f => {
      if (nonOperationalIds.has(f.id)) return false
      const fSvc = services.find(s => s.id === f.id)
      if (fSvc?.provider && affectedProviders.has(fSvc.provider)) return false
      return true
    })
    if (candidates.length === 0) continue
    const label = tierLabel || CATEGORY_LABEL[svc.category] || svc.category
    categoryGroups.push({ category: svc.category, label, items: candidates.slice(0, perGroup) })
  }

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
      {categoryGroups.length > 0 ? (
        <div className="mono text-[11px] text-[var(--text2)]" style={{ marginTop: '4px' }}>
          <span>{t('overview.banner.fallback')}</span>
          {categoryGroups.map((grp, gi) => (
            <span key={grp.category}>
              {gi > 0 && ' · '}
              {' '}<span className="text-[var(--text2)]">{grp.label} → </span>
              {grp.items.map((f, fi) => (
                <span key={f.id}>
                  {fi > 0 && ', '}
                  <span
                    className="text-[var(--green)] hover:underline cursor-pointer"
                    onClick={() => { trackEvent('fallback_click', { from_service: 'banner', to_service: f.id, location: 'action_banner' }); setPage({ name: 'service', serviceId: f.id }) }}
                  >
                    {f.name}{f.aiwatchScore != null ? ` (${f.aiwatchScore})` : ''}
                  </span>
                </span>
              ))}
            </span>
          ))}
        </div>
      ) : affected.length > 0 ? (
        <div className="mono text-[11px] text-[var(--text2)]" style={{ marginTop: '4px' }}>
          {t('overview.banner.noFallback')}
        </div>
      ) : null}
    </div>
  )
}

// ── Main Component ───────────────────────────────────────────

export default function Overview() {
  const { t, lang } = useLang()
  const { setPage, categoryFilter, setCategoryFilter } = usePage()
  const { services: allServices, loading, error, lastUpdated, refresh, recentlyRecovered, aiAnalysis, securityAlerts } = usePolling()
  const { settings } = useSettings()
  const services = allServices.filter((s) => settings.enabledServices.includes(s.id))
  const [filter, setFilter] = useState('all')

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
  const uptimeServices = catServices.filter((s) => s.uptime30d != null && !(s.uptimeSource === 'estimate' && (s.incidents ?? []).length === 0))
  const avgUptime = uptimeServices.length
    ? (uptimeServices.reduce((sum, s) => sum + s.uptime30d, 0) / uptimeServices.length).toFixed(1)
    : '—'

  const apiAndWebServices = catServices.filter((s) => s.category !== 'agent')
  const agentServices = catServices.filter((s) => s.category === 'agent')

  const statusPriority = { down: 0, degraded: 1, operational: 2 }
  const issueSort = (a, b) => (statusPriority[a.status] - statusPriority[b.status]) || ((a.aiwatchScore ?? 0) - (b.aiwatchScore ?? 0))

  const filteredServices =
    filter === 'operational' ? apiAndWebServices.filter((s) => s.status === 'operational')
    : filter === 'issues'    ? [...apiAndWebServices.filter((s) => s.status !== 'operational')].sort(issueSort)
    : apiAndWebServices

  const filteredAgents =
    filter === 'operational' ? agentServices.filter((s) => s.status === 'operational')
    : filter === 'issues'    ? [...agentServices.filter((s) => s.status !== 'operational')].sort(issueSort)
    : agentServices

  const sevenDaysAgo = Date.now() - 7 * 86_400_000
  // Dedup by incident ID (Anthropic bulk-links one incident to claude.ai + Claude API + Claude Code)
  // while collecting every affected service name. Mirrors the Incidents.jsx aggregation pattern.
  const incMap = new Map()
  for (const s of catServices) {
    for (const inc of s.incidents ?? []) {
      const existing = incMap.get(inc.id)
      if (existing) {
        if (!existing.affectedNames.includes(s.name)) existing.affectedNames.push(s.name)
      } else {
        incMap.set(inc.id, { ...inc, serviceName: s.name, affectedNames: [s.name] })
      }
    }
  }
  const recentIncidents = [...incMap.values()]
    .filter((inc) => inc.status !== 'resolved' || new Date(inc.startedAt).getTime() >= sevenDaysAgo)
    .sort((a, b) => {
      const aActive = a.status !== 'resolved' ? 1 : 0
      const bActive = b.status !== 'resolved' ? 1 : 0
      if (aActive !== bActive) return bActive - aActive
      return new Date(b.startedAt) - new Date(a.startedAt)
    })
    .slice(0, 5)

  const withLatency = catServices.filter((s) => s.latency != null)
  const sortedByLatency = [...withLatency].sort((a, b) => a.latency - b.latency)
  const maxLatency = withLatency.length ? Math.max(...withLatency.map((s) => s.latency)) : 1

  return (
    <div className="flex flex-col" style={{ gap: '20px' }}>

      {/* ── Action Banner (outage fallback) ── */}
      <ActionBanner services={services} setPage={setPage} t={t} />

      {/* ── Recently Resolved Banner ── */}
      {Object.keys(recentlyRecovered).some(id => services.find(s => s.id === id)) && (
        <div className="rounded-lg border" style={{ borderColor: 'var(--blue)', background: 'var(--blue-dim)', padding: '12px 16px' }}>
          <div className="flex items-center gap-2 flex-wrap text-[12px]">
            <span style={{ color: 'var(--blue)' }}>✓</span>
            <span className="text-[var(--text0)] font-medium">
              {t('overview.recentlyResolved')}
            </span>
            <span className="text-[var(--text1)]">
              {Object.keys(recentlyRecovered).map(id => {
                const svc = services.find(s => s.id === id)
                if (!svc) return null
                return (
                  <span
                    key={id}
                    className="cursor-pointer hover:underline"
                    style={{ color: 'var(--blue)' }}
                    onClick={() => setPage({ name: 'service', serviceId: id })}
                  >{svc.name}</span>
                )
              }).filter(Boolean).reduce((acc, el, i) => i === 0 ? [el] : [...acc, ', ', el], [])}
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
        </div>
      )}

      {/* ── Security Alerts Banner (24h only) ── */}
      {(() => {
        const cutoff = Date.now() - 24 * 3600_000
        const recent = (securityAlerts ?? []).filter(a => a.detectedAt && new Date(a.detectedAt).getTime() > cutoff)
        if (recent.length === 0) return null
        return (
          <div className="rounded-lg border border-[var(--purple)]" style={{ background: 'color-mix(in srgb, var(--purple) 8%, transparent)', padding: '12px 16px' }}>
            <div className="flex items-start gap-2 text-[12px]">
              <span>🔒</span>
              <div className="flex flex-col gap-1 min-w-0">
                <span className="text-[var(--text0)] font-medium mono text-[11px]">
                  {t('overview.security.title')} ({recent.length})
                </span>
                {recent.slice(0, 3).map((a, i) => {
                  const safeUrl = a.url?.startsWith('https://') ? a.url : '#'
                  // Derive service tag: use service field (OSV) or detect from title (HN)
                  let tag = a.service || ''
                  if (!tag) {
                    const titleLC = a.title?.toLowerCase() ?? ''
                    const match = services.find(s => titleLC.includes(s.name.toLowerCase()) || titleLC.includes(s.provider.toLowerCase()))
                    if (match) tag = match.name
                  }
                  return (
                    <a key={i} href={safeUrl} target="_blank" rel="noopener noreferrer"
                      className="text-[var(--text1)] hover:text-[var(--purple)] truncate text-[11px]"
                    >
                      {a.severity === 'critical' ? '🔴' : a.severity === 'high' ? '🟠' : '🟡'} {tag ? `[${tag}] ` : ''}{a.title}
                    </a>
                  )
                })}
              </div>
            </div>
          </div>
        )
      })()}

      {/* ── Summary Stats ── */}
      <div className="grid grid-cols-2 md:grid-cols-4" style={{ gap: '10px' }}>
        <StatCard index={0} value={operationalCount} sub={t('overview.stats.operational')} labelKey="overview.stats.operational" colorClass="text-[var(--green)]" t={t} />
        <StatCard index={1} value={degradedCount}    sub={t('overview.stats.degraded')}    labelKey="overview.stats.degraded"    colorClass="text-[var(--amber)]" t={t} />
        <StatCard index={2} value={downCount}         sub="—"                                labelKey="overview.stats.down"         colorClass="text-[var(--red)]"   t={t} />
        <StatCard index={3} value={avgUptime === '—' ? '—' : `${avgUptime}%`}  sub={t('overview.stats.uptime.sub')}  labelKey="overview.stats.uptime"       colorClass="text-[var(--blue)]"  t={t} />
      </div>

      {/* ── Section Header + Filter ── */}
      <div className="flex items-center justify-between">
        <h2 className="mono text-[10px] text-[var(--text2)] uppercase flex items-center gap-2" style={{ letterSpacing: '0.1em' }}>
          <span className="text-[var(--green)] font-semibold">//</span>
          {t('nav.services')}
        </h2>
        <FilterTabs filter={filter} setFilter={setFilter} total={catServices.length} issueCount={issueCount} downCount={downCount} t={t} />
      </div>

      {/* ── Service Grid ── */}
      {filter === 'issues' && filteredServices.length === 0 ? (
        <EmptyState type="good" />
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3" style={{ gap: '8px' }}>
          {filteredServices.map((svc, i) => (
            <ServiceCard
              key={svc.id}
              service={svc}
              index={i}
              t={t}
              isRecovered={!!recentlyRecovered[svc.id]}
              onClick={() => { trackEvent('select_service', { service_id: svc.id }); setPage({ name: 'service', serviceId: svc.id }) }}
            />
          ))}
        </div>
      )}

      {/* ── Coding Agents ── */}
      {filteredAgents.length > 0 && (
        <>
          <div className="flex items-center justify-between" style={{ marginTop: '16px' }}>
            <h2 className="mono text-[10px] text-[var(--text2)] uppercase flex items-center gap-2" style={{ letterSpacing: '0.1em' }}>
              <span className="text-[var(--green)] font-semibold">//</span>
              {t('nav.agents')}
            </h2>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3" style={{ gap: '8px' }}>
            {filteredAgents.map((svc, i) => (
              <ServiceCard
                key={svc.id}
                service={svc}
                index={i}
                t={t}
                isRecovered={!!recentlyRecovered[svc.id]}
                onClick={() => { trackEvent('select_service', { service_id: svc.id }); setPage({ name: 'service', serviceId: svc.id }) }}
              />
            ))}
          </div>
        </>
      )}

      {/* ── Bottom Panels ── */}
      <div className="grid grid-cols-1 lg:grid-cols-2" style={{ gap: '10px' }}>
        <Panel title={t('overview.incidents.title')} dotColor="var(--red)" subtitle={t('overview.panel.incidents.sub')}>
          {recentIncidents.length === 0 ? (
            <EmptyState type="good" />
          ) : (
            <div>
              {recentIncidents.map((inc) => (
                <IncidentItem key={inc.id} incident={inc} lang={lang} t={t} />
              ))}
            </div>
          )}
        </Panel>

        <Panel title={t('overview.latency.title')} dotColor="var(--teal)" subtitle={t('overview.panel.latency.sub')}>
          <div className="flex flex-col" style={{ gap: '8px' }}>
            {sortedByLatency.map((svc) => (
              <LatencyBar key={svc.id} service={svc} maxLatency={maxLatency} />
            ))}
          </div>
        </Panel>
      </div>

    </div>
  )
}
