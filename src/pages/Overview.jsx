// Overview — summary stats, service grid, recent incidents, latency rankings, AI panel.
// Design mockup: svc-card with left border, provider, 3-col metrics, variable-height history bars.

import { useState } from 'react'
import { useLang } from '../hooks/useLang'
import { usePage } from '../utils/pageContext'
import { usePolling } from '../hooks/usePolling'
import { useSettings } from '../hooks/useSettings'
import { trackEvent } from '../utils/analytics'
import { buildCalendarFromIncidents } from '../utils/calendar'
import { formatTime, formatDate } from '../utils/time'
import SkeletonUI from '../components/SkeletonUI'
import StatusPill from '../components/StatusPill'
import EmptyState from '../components/EmptyState'

// ── Status color maps ────────────────────────────────────────

const BORDER_LEFT_CLASS = {
  operational: 'border-l-[var(--green)]',
  degraded:    'border-l-[var(--amber)]',
  down:        'border-l-[var(--red)]',
}

const HISTORY_CLASS = {
  operational:    'bg-[var(--green)]',
  degraded_perf:  'bg-[var(--yellow)]',
  degraded:       'bg-[var(--amber)]',
  down:           'bg-[var(--red)]',
}

const INC_BAR_CLASS = {
  ongoing:    'bg-[var(--red)]',
  monitoring: 'bg-[var(--amber)]',
  resolved:   'bg-[var(--green)]',
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
function HistoryBars({ history30d }) {
  return (
    <div className="flex gap-[2px] items-end" style={{ height: '18px' }} aria-hidden="true">
      {history30d.map((status, i) => {
        const cls = HISTORY_CLASS[status] ?? HISTORY_CLASS.operational
        // Deterministic pseudo-random height based on index
        const baseH = status === 'operational' ? 12 + ((i * 7 + 3) % 7) : 4 + ((i * 5) % 6)
        return (
          <div
            key={i}
            className={`flex-1 rounded-sm ${cls}`}
            style={{ height: `${baseH}px`, opacity: status === 'operational' ? 0.6 : 0.8, minHeight: '4px' }}
          />
        )
      })}
    </div>
  )
}

function ServiceCard({ service, index, onClick, t }) {
  const borderCls = BORDER_LEFT_CLASS[service.status] ?? BORDER_LEFT_CLASS.operational
  const incidentCount = (service.incidents ?? []).filter((i) => i.status !== 'resolved').length
  const hasUptime = service.uptime30d != null
  const uptimeColor = !hasUptime ? 'text-[var(--text2)]' : service.uptime30d >= 99 ? 'text-[var(--green)]' : service.uptime30d >= 97 ? 'text-[var(--amber)]' : 'text-[var(--red)]'
  const latencyColor = service.status === 'degraded' ? 'text-[var(--amber)]' : service.status === 'down' ? 'text-[var(--red)]' : 'text-[var(--text0)]'

  return (
    <button
      onClick={onClick}
      className={`w-full text-left bg-[var(--bg1)] border border-[var(--border)] border-l-2 ${borderCls} rounded-lg
                 hover:border-t-[var(--border-hi)] hover:border-r-[var(--border-hi)] hover:border-b-[var(--border-hi)] transition-colors animate-[fade-in_0.3s_ease_both]`}
      style={{ padding: '14px', animationDelay: `${index * 80}ms` }}
    >
      <div className="flex justify-between items-start" style={{ marginBottom: '10px' }}>
        <div>
          <div className="text-[13px] font-medium text-[var(--text0)]" style={{ marginBottom: '2px' }}>{service.name}</div>
          <div className="mono text-[10px] text-[var(--text2)]">{service.provider}</div>
        </div>
        <StatusPill status={service.status} />
      </div>

      <div className="grid grid-cols-3" style={{ gap: '6px', marginBottom: '10px', textAlign: 'center' }}>
        <div>
          <div className={`mono text-[13px] font-medium ${latencyColor}`}>{service.latency != null ? `${service.latency}ms` : '—'}</div>
          <div className="mono text-[9px] text-[var(--text2)]" style={{ letterSpacing: '0.04em' }}>{t('overview.card.latency')}</div>
        </div>
        <div>
          <div className={`mono text-[13px] font-medium ${uptimeColor}`}>{hasUptime ? `${service.uptime30d.toFixed(2)}%` : '—'}</div>
          <div className="mono text-[9px] text-[var(--text2)]" style={{ letterSpacing: '0.04em' }}>{t('overview.card.uptime')}</div>
        </div>
        <div>
          <div className="mono text-[13px] font-medium text-[var(--text0)]">{incidentCount}</div>
          <div className="mono text-[9px] text-[var(--text2)]" style={{ letterSpacing: '0.04em' }}>{t('overview.card.incidents')}</div>
        </div>
      </div>

      <HistoryBars history30d={buildCalendarFromIncidents(service.incidents, service.dailyImpact)} />
    </button>
  )
}

// Filter: pill-style segment control per design mockup
function FilterTabs({ filter, setFilter, total, issueCount, t }) {
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
            background: filter === tab.key ? 'var(--bg4)' : 'transparent',
            color: filter === tab.key ? 'var(--text0)' : 'var(--text2)',
          }}
        >
          {t(tab.labelKey)} <span style={{ opacity: 0.6, marginLeft: '2px' }}>{tab.count}</span>
        </button>
      ))}
    </div>
  )
}

// Incident item with time + bar + content (matching design mockup)
function IncidentItem({ incident, lang, t }) {
  const barCls = INC_BAR_CLASS[incident.status] ?? INC_BAR_CLASS.resolved
  return (
    <div className="flex gap-2.5 items-start" style={{ marginBottom: '8px' }}>
      <div className="mono text-[10px] text-[var(--text2)] whitespace-nowrap shrink-0" style={{ width: '52px', paddingTop: '1px' }}>
        {formatDate(incident.startedAt, lang).split(' ').slice(0, 2).join(' ')}
      </div>
      <div className={`w-[2px] rounded self-stretch ${barCls}`} style={{ minHeight: '32px' }} />
      <div>
        <div className="text-[12px] font-medium text-[var(--text0)]" style={{ marginBottom: '2px' }}>
          {incident.serviceName} — {incident.title}
        </div>
        <div className="mono text-[10px] text-[var(--text2)]">
          {incident.duration ?? t('overview.incidents.monitoring')}
        </div>
      </div>
    </div>
  )
}

// Latency bar with colored fill per speed tier
function LatencyBar({ service, maxLatency }) {
  const widthPct = maxLatency > 0 ? Math.round((service.latency / maxLatency) * 100) : 0
  const fillCls = service.latency < 200 ? 'bg-[var(--green)]' : service.latency < 400 ? 'bg-[var(--amber)]' : 'bg-[var(--red)]'
  const valColor = service.latency < 200 ? '' : service.latency < 400 ? 'text-[var(--amber)]' : 'text-[var(--red)]'
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

// AI Analysis — Phase 3 placeholder with lock icon
function AIPanel({ t }) {
  return (
    <div className="bg-[var(--bg1)] border border-[var(--border)] rounded-lg overflow-hidden">
      <div className="flex items-center justify-between border-b border-[var(--border)] bg-[var(--bg2)]" style={{ padding: '10px 14px' }}>
        <div className="mono text-[9px] text-[var(--text2)] uppercase tracking-wider flex items-center gap-1.5" style={{ letterSpacing: '0.1em' }}>
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
            <rect x="2" y="5.5" width="8" height="5.5" rx="1.5" stroke="currentColor" strokeWidth="1.2" opacity="0.5" />
            <path d="M4 5.5V4a2 2 0 014 0v1.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" opacity="0.5" />
          </svg>
          {t('overview.ai.title')}
        </div>
      </div>
      <div className="flex items-center gap-3" style={{ padding: '16px 14px' }}>
        <div className="flex items-center justify-center shrink-0"
             style={{ width: '36px', height: '36px', borderRadius: '6px', background: 'var(--bg2)', border: '1px solid var(--border)', opacity: 0.45 }}>
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
            <rect x="3" y="7.5" width="10" height="7" rx="2" stroke="var(--text1)" strokeWidth="1.3" />
            <path d="M5.5 7.5V5.5a2.5 2.5 0 015 0v2" stroke="var(--text1)" strokeWidth="1.3" strokeLinecap="round" />
          </svg>
        </div>
        <div>
          <div className="text-[13px] font-medium text-[var(--text1)]" style={{ marginBottom: '3px' }}>{t('overview.ai.title')}</div>
          <div className="mono text-[11px] text-[var(--text2)]">{t('overview.ai.desc')}</div>
        </div>
      </div>
    </div>
  )
}

// ── Main Component ───────────────────────────────────────────

export default function Overview() {
  const { t, lang } = useLang()
  const { setPage } = usePage()
  const { services: allServices, loading, error, lastUpdated } = usePolling()
  const { settings } = useSettings()
  const services = allServices.filter((s) => settings.enabledServices.includes(s.id))
  const [filter, setFilter] = useState('all')

  if (loading && services.length === 0) return <SkeletonUI />

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

  const operationalCount = services.filter((s) => s.status === 'operational').length
  const degradedCount    = services.filter((s) => s.status === 'degraded').length
  const downCount        = services.filter((s) => s.status === 'down').length
  const issueCount       = degradedCount + downCount
  const uptimeServices = services.filter((s) => s.uptime30d != null)
  const avgUptime = uptimeServices.length
    ? (uptimeServices.reduce((sum, s) => sum + s.uptime30d, 0) / uptimeServices.length).toFixed(1)
    : '—'

  const apiAndWebServices = services.filter((s) => s.category !== 'agent')
  const agentServices = services.filter((s) => s.category === 'agent')

  const filteredServices =
    filter === 'operational' ? apiAndWebServices.filter((s) => s.status === 'operational')
    : filter === 'issues'    ? apiAndWebServices.filter((s) => s.status !== 'operational')
    : apiAndWebServices

  const filteredAgents =
    filter === 'operational' ? agentServices.filter((s) => s.status === 'operational')
    : filter === 'issues'    ? agentServices.filter((s) => s.status !== 'operational')
    : agentServices

  const sevenDaysAgo = Date.now() - 7 * 86_400_000
  const recentIncidents = services
    .flatMap((s) => s.incidents.map((inc) => ({ ...inc, serviceName: s.name })))
    .filter((inc) => new Date(inc.startedAt).getTime() >= sevenDaysAgo)
    .sort((a, b) => {
      // Active (non-resolved) incidents always come first
      const aActive = a.status !== 'resolved' ? 1 : 0
      const bActive = b.status !== 'resolved' ? 1 : 0
      if (aActive !== bActive) return bActive - aActive
      return new Date(b.startedAt) - new Date(a.startedAt)
    })
    .slice(0, 5)

  const withLatency = services.filter((s) => s.latency != null)
  const sortedByLatency = [...withLatency].sort((a, b) => a.latency - b.latency)
  const maxLatency = withLatency.length ? Math.max(...withLatency.map((s) => s.latency)) : 1

  return (
    <div className="flex flex-col" style={{ gap: '20px' }}>

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
        <FilterTabs filter={filter} setFilter={setFilter} total={services.length} issueCount={issueCount} t={t} />
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

      {/* ── AI Analysis (Phase 3) ── */}
      <AIPanel t={t} />

    </div>
  )
}
