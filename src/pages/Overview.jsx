// Shows summary stats, service grid, recent incidents, latency rankings, AI analysis panel.
// Data comes from usePolling (placeholder until Issue #15).

import { useState } from 'react'
import { useLang } from '../hooks/useLang'
import { usePage } from '../utils/pageContext'
import { usePolling } from '../hooks/usePolling'
import { formatTime, formatDate } from '../utils/time'
import SkeletonUI from '../components/SkeletonUI'
import StatusPill from '../components/StatusPill'
import EmptyState from '../components/EmptyState'

// ── Status color maps ────────────────────────────────────────

const HISTORY_CLASS = {
  operational: 'bg-[var(--green)]',
  degraded:    'bg-[var(--amber)]',
  down:        'bg-[var(--red)]',
}

const INCIDENT_DOT_CLASS = {
  ongoing:    'text-[var(--red)]',
  monitoring: 'text-[var(--amber)]',
  resolved:   'text-[var(--text2)]',
}

// ── Sub-components ───────────────────────────────────────────

const STAT_TOP_COLOR = {
  'text-[var(--green)]': 'var(--green)',
  'text-[var(--amber)]': 'var(--amber)',
  'text-[var(--red)]':   'var(--red)',
  'text-[var(--blue)]':  'var(--blue)',
}

function StatCard({ value, labelKey, colorClass, index, t }) {
  const topColor = STAT_TOP_COLOR[colorClass] ?? 'var(--border)'
  return (
    <div
      className="relative bg-[var(--bg1)] border border-[var(--border)] rounded-lg p-4
                 flex flex-col gap-1 animate-[fade-in_0.3s_ease_both] overflow-hidden"
      style={{ animationDelay: `${index * 80}ms` }}
    >
      <span className="absolute top-0 left-0 right-0 h-px" style={{ background: topColor }} />
      <span className="mono text-[9px] text-[var(--text2)] uppercase tracking-wider">{t(labelKey)}</span>
      <span className={`text-2xl mono font-semibold ${colorClass}`}>{value}</span>
    </div>
  )
}

// 30-day status history as small colored strips (aria-hidden — decorative).
// Unknown status values fall back to 'operational' styling.
function MiniHistory({ history30d }) {
  return (
    <div className="flex gap-px" aria-hidden="true">
      {history30d.map((status, i) => (
        <div
          key={i}
          className={`h-3 flex-1 rounded-sm ${HISTORY_CLASS[status] ?? HISTORY_CLASS.operational}`}
        />
      ))}
    </div>
  )
}

function ServiceCard({ service, index, onClick }) {
  const { t } = useLang()
  return (
    <button
      onClick={onClick}
      className="w-full text-left bg-[var(--bg1)] border border-[var(--border)] rounded-lg p-4
                 hover:bg-[var(--bg2)] hover:border-[var(--border-hi)] transition-colors
                 flex flex-col gap-3 animate-[fade-in_0.3s_ease_both]"
      style={{ animationDelay: `${index * 80}ms` }}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm text-[var(--text0)] font-medium truncate">{service.name}</span>
        <StatusPill status={service.status} />
      </div>
      <div className="flex items-center justify-between text-xs mono text-[var(--text2)]">
        <span>{service.latency} ms</span>
        <span>{service.uptime30d.toFixed(2)}%</span>
      </div>
      <MiniHistory history30d={service.history30d} />
      <p className="text-[10px] text-[var(--text2)] text-right -mt-1">30d</p>
    </button>
  )
}

function FilterTabs({ filter, setFilter, total, issueCount, t }) {
  const tabs = [
    { key: 'all',         labelKey: 'overview.filter.all',        count: total },
    { key: 'operational', labelKey: 'overview.filter.operational', count: total - issueCount },
    { key: 'issues',      labelKey: 'overview.filter.issues',      count: issueCount },
  ]
  return (
    <div className="flex gap-1 border-b border-[var(--border)]">
      {tabs.map((tab) => (
        <button
          key={tab.key}
          onClick={() => setFilter(tab.key)}
          className={`px-4 py-2 text-xs mono border-b-2 transition-colors
            ${filter === tab.key
              ? 'border-[var(--blue)] text-[var(--text0)]'
              : 'border-transparent text-[var(--text2)] hover:text-[var(--text1)]'
            }`}
        >
          {t(tab.labelKey)}
          <span className="ml-1.5 text-[10px] text-[var(--text2)]">{tab.count}</span>
        </button>
      ))}
    </div>
  )
}

function IncidentItem({ incident, t, lang }) {
  const dotClass = INCIDENT_DOT_CLASS[incident.status] ?? INCIDENT_DOT_CLASS.resolved
  return (
    <div className="flex items-start gap-3 py-2 border-b border-[var(--border)] last:border-0">
      <span className={`shrink-0 mt-0.5 text-[10px] mono ${dotClass}`} aria-hidden="true">●</span>
      <div className="flex-1 min-w-0">
        <p className="text-xs text-[var(--text1)] truncate">{incident.title}</p>
        <p className="text-[10px] text-[var(--text2)] mt-0.5">
          {incident.serviceName} · {formatDate(incident.startedAt, lang)}
        </p>
      </div>
      <span className={`shrink-0 text-[10px] mono ${dotClass}`}>
        {t(`incidents.status.${incident.status}`)}
      </span>
    </div>
  )
}

// Bars are relative — slowest service always fills 100%. Not comparable across data sets.
function LatencyBar({ service, maxLatency, rank }) {
  const widthPct = maxLatency > 0 ? Math.round((service.latency / maxLatency) * 100) : 0
  return (
    <div className="flex items-center gap-3">
      <span className="w-4 shrink-0 text-right text-[10px] mono text-[var(--text2)]">{rank}</span>
      <span className="w-24 shrink-0 truncate text-xs text-[var(--text1)]">{service.name}</span>
      <div className="flex-1 bg-[var(--bg3)] rounded-full h-1.5">
        <div
          className="h-1.5 rounded-full bg-[var(--blue)]"
          style={{ width: `${widthPct}%` }}
        />
      </div>
      <span className="w-14 shrink-0 text-right text-xs mono text-[var(--text0)]">
        {service.latency} ms
      </span>
    </div>
  )
}

// Phase 3 placeholder — do not remove
function AIPanel({ t }) {
  return (
    <div className="bg-[var(--bg1)] border border-[var(--border)] rounded-lg p-5
                    flex flex-col items-center justify-center gap-2 text-center py-8">
      <span className="text-2xl text-[var(--text2)]" aria-hidden="true">🔒</span>
      <p className="text-sm text-[var(--text1)]">{t('overview.ai.title')}</p>
      <span className="text-[10px] mono px-2 py-0.5 rounded bg-[var(--bg3)] text-[var(--amber)]">
        {t('overview.ai.soon')}
      </span>
    </div>
  )
}

// ── Main Component ───────────────────────────────────────────

export default function Overview() {
  const { t, lang } = useLang()
  const { setPage } = usePage()
  const { services, loading, error, lastUpdated } = usePolling()
  const [filter, setFilter] = useState('all')

  if (loading) {
    return <SkeletonUI />
  }

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

  // Derived stats
  const operationalCount = services.filter((s) => s.status === 'operational').length
  const degradedCount    = services.filter((s) => s.status === 'degraded').length
  const downCount        = services.filter((s) => s.status === 'down').length
  const issueCount       = degradedCount + downCount
  const avgUptime = services.length
    ? (services.reduce((sum, s) => sum + s.uptime30d, 0) / services.length).toFixed(2)
    : '—'

  const filteredServices =
    filter === 'operational' ? services.filter((s) => s.status === 'operational')
    : filter === 'issues'    ? services.filter((s) => s.status !== 'operational')
    : services

  // Recent incidents: last 7 days by startedAt, newest first, max 5
  // (ongoing incidents started more than 7 days ago are excluded by design)
  const sevenDaysAgo = Date.now() - 7 * 86_400_000
  const recentIncidents = services
    .flatMap((s) => s.incidents.map((inc) => ({ ...inc, serviceName: s.name })))
    .filter((inc) => new Date(inc.startedAt).getTime() >= sevenDaysAgo)
    .sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt))
    .slice(0, 5)

  const sortedByLatency = [...services].sort((a, b) => a.latency - b.latency)
  const maxLatency = services.length ? Math.max(...services.map((s) => s.latency)) : 1

  return (
    <div className=" space-y-6">

      {/* ── Summary Stats ── */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <StatCard index={0} value={operationalCount} labelKey="overview.stats.operational" colorClass="text-[var(--green)]" t={t} />
        <StatCard index={1} value={degradedCount}    labelKey="overview.stats.degraded"    colorClass="text-[var(--amber)]" t={t} />
        <StatCard index={2} value={downCount}         labelKey="overview.stats.down"         colorClass="text-[var(--red)]"   t={t} />
        <StatCard index={3} value={`${avgUptime}%`}  labelKey="overview.stats.uptime"       colorClass="text-[var(--blue)]"  t={t} />
      </div>

      {/* ── Section Header + Filter Tabs ── */}
      <div className="flex items-center justify-between">
        <h2 className="mono text-[10px] text-[var(--text2)] uppercase tracking-wider flex items-center gap-2">
          <span className="text-[var(--green)] font-semibold">//</span>
          {t('nav.services')}
        </h2>
      </div>
      <FilterTabs
        filter={filter}
        setFilter={setFilter}
        total={services.length}
        issueCount={issueCount}
        t={t}
      />

      {/* ── Service Grid ── */}
      {filter === 'issues' && filteredServices.length === 0 ? (
        <EmptyState type="good" />
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {filteredServices.map((svc, i) => (
            <ServiceCard
              key={svc.id}
              service={svc}
              index={i}
              onClick={() => setPage({ name: 'service', serviceId: svc.id })}
            />
          ))}
        </div>
      )}

      {/* ── Bottom Panels ── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">

        {/* Recent Incidents (last 7 days) */}
        <section className="bg-[var(--bg1)] border border-[var(--border)] rounded-lg p-4">
          <h2 className="text-xs mono text-[var(--text2)] uppercase tracking-wider mb-3">
            {t('overview.incidents.title')}
          </h2>
          {recentIncidents.length === 0 ? (
            <EmptyState type="good" />
          ) : (
            <div>
              {recentIncidents.map((inc) => (
                <IncidentItem key={inc.id} incident={inc} t={t} lang={lang} />
              ))}
            </div>
          )}
        </section>

        {/* Latency Rankings (fastest first) */}
        <section className="bg-[var(--bg1)] border border-[var(--border)] rounded-lg p-4">
          <h2 className="text-xs mono text-[var(--text2)] uppercase tracking-wider mb-3">
            {t('overview.latency.title')}
          </h2>
          <div className="flex flex-col gap-2.5">
            {sortedByLatency.map((svc, i) => (
              <LatencyBar key={svc.id} service={svc} maxLatency={maxLatency} rank={i + 1} />
            ))}
          </div>
        </section>

      </div>

      {/* ── AI Analysis Panel (Phase 3, disabled) ── */}
      <AIPanel t={t} />

    </div>
  )
}
