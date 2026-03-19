// Incidents — incident history and timeline page
// FilterBar: service, status, period (all stateful).
// Desktop: scrollable table (5 columns). Mobile: card list.
// Row/card click toggles a DetailPanel with per-stage timeline.

import { useState, useMemo } from 'react'
import { useLang } from '../hooks/useLang'
import { usePolling } from '../hooks/usePolling'
import { formatDate } from '../utils/time'
import SkeletonUI from '../components/SkeletonUI'
import EmptyState from '../components/EmptyState'

// ── Constants ────────────────────────────────────────────────

const STATUS_BADGE_CLASS = {
  ongoing:    'bg-[var(--status-bg-red)]   text-[var(--red)]',
  monitoring: 'bg-[var(--status-bg-amber)] text-[var(--amber)]',
  resolved:   'bg-[var(--bg3)]             text-[var(--text2)]',
}

// Timeline stage colors: amber=investigating, blue=identified, teal=monitoring, green=resolved.
// Dot and text classes are co-located so adding a new stage can't cause them to diverge.
const STAGE_CLASS = {
  investigating: { dot: 'bg-[var(--amber)]',  text: 'text-[var(--amber)]' },
  identified:    { dot: 'bg-[var(--blue)]',   text: 'text-[var(--blue)]'  },
  monitoring:    { dot: 'bg-[var(--teal)]',   text: 'text-[var(--teal)]'  },
  resolved:      { dot: 'bg-[var(--green)]',  text: 'text-[var(--green)]' },
}

// Period filter options in days; null = all time
const PERIODS = [7, 30, 90, null]

const TABLE_COLS = ['col.time', 'col.title', 'col.service', 'col.duration', 'col.status']

// ── Sub-components ───────────────────────────────────────────

function StatusBadge({ status, t }) {
  const cls = STATUS_BADGE_CLASS[status] ?? STATUS_BADGE_CLASS.resolved
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded text-[11px] mono font-medium ${cls}`}>
      {t(`incidents.status.${status}`)}
    </span>
  )
}

function FilterBar({ services, serviceFilter, setServiceFilter, statusFilter, setStatusFilter, period, setPeriod, t }) {
  const selectCls = 'bg-[var(--bg2)] border border-[var(--border)] rounded px-2 py-1 text-xs mono text-[var(--text1)] focus:outline-none focus:border-[var(--border-hi)]'
  const all = t('incidents.filter.all')
  return (
    <div className="flex flex-wrap gap-2">
      <select
        value={serviceFilter}
        onChange={(e) => setServiceFilter(e.target.value)}
        className={selectCls}
        aria-label={t('incidents.filter.service')}
      >
        <option value="all">{t('incidents.filter.service')}: {all}</option>
        {services.map((svc) => (
          <option key={svc.id} value={svc.id}>{svc.name}</option>
        ))}
      </select>

      <select
        value={statusFilter}
        onChange={(e) => setStatusFilter(e.target.value)}
        className={selectCls}
        aria-label={t('incidents.filter.status')}
      >
        <option value="all">{t('incidents.filter.status')}: {all}</option>
        {['ongoing', 'monitoring', 'resolved'].map((s) => (
          <option key={s} value={s}>{t(`incidents.status.${s}`)}</option>
        ))}
      </select>

      <select
        value={period ?? ''}
        onChange={(e) => setPeriod(e.target.value === '' ? null : Number(e.target.value))}
        className={selectCls}
        aria-label={t('incidents.filter.period')}
      >
        {PERIODS.map((p) => (
          <option key={p ?? 'all'} value={p ?? ''}>
            {t(p ? `incidents.period.${p}d` : 'incidents.period.all')}
          </option>
        ))}
      </select>
    </div>
  )
}

function TimelineStep({ stage, at, isLast, t, lang }) {
  const { dot: dotCls = 'bg-[var(--text2)]', text: textCls = 'text-[var(--text2)]' } = STAGE_CLASS[stage] ?? {}
  return (
    <div className="flex gap-3">
      <div className="flex flex-col items-center">
        <span className={`w-2.5 h-2.5 rounded-full shrink-0 mt-0.5 ${dotCls}`} aria-hidden="true" />
        {!isLast && <div className="w-px flex-1 bg-[var(--border)] mt-1" />}
      </div>
      <div className="pb-4">
        <p className={`text-xs mono font-medium ${textCls}`}>{t(`incidents.timeline.${stage}`)}</p>
        <p className="text-[10px] text-[var(--text2)] mono mt-0.5">{formatDate(at, lang)}</p>
      </div>
    </div>
  )
}

function DetailPanel({ incident, onClose, t, lang }) {
  return (
    <div className="bg-[var(--bg2)] border border-[var(--border)] rounded-lg p-4 space-y-3">
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="text-sm text-[var(--text0)] font-medium">{incident.title}</p>
          <p className="text-[10px] text-[var(--text2)] mono mt-0.5">
            {incident.serviceName} · {formatDate(incident.startedAt, lang)}
            {incident.duration ? ` · ${incident.duration}` : ''}
          </p>
        </div>
        <button
          onClick={onClose}
          className="shrink-0 text-xl leading-none text-[var(--text2)] hover:text-[var(--text1)] transition-colors"
          aria-label={t('modal.close')}
        >
          ×
        </button>
      </div>

      <h3 className="text-[10px] mono text-[var(--text2)] uppercase tracking-wider">
        {t('incidents.timeline.title')}
      </h3>

      {/* timeline may be absent for incidents fetched before Issue #15 adds historical data */}
      <div>
        {(incident.timeline ?? []).map((step, i) => (
          <TimelineStep
            key={`${step.stage}-${i}`}
            stage={step.stage}
            at={step.at}
            isLast={i === (incident.timeline?.length ?? 0) - 1}
            t={t}
            lang={lang}
          />
        ))}
      </div>
    </div>
  )
}

// Desktop table row
function IncidentRow({ incident, isSelected, onClick, t, lang }) {
  return (
    <tr
      onClick={onClick}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick() } }}
      tabIndex={0}
      className={`cursor-pointer transition-colors border-b border-[var(--border)] last:border-0
        focus:outline-none focus:ring-1 focus:ring-[var(--border-hi)]
        ${isSelected ? 'bg-[var(--bg2)]' : 'hover:bg-[var(--bg2)]'}`}
    >
      <td className="px-3 py-2.5 text-xs mono text-[var(--text2)] whitespace-nowrap">
        {formatDate(incident.startedAt, lang)}
      </td>
      <td className="px-3 py-2.5 text-xs text-[var(--text1)] max-w-[220px] truncate">
        {incident.title}
      </td>
      <td className="px-3 py-2.5 text-xs mono text-[var(--text2)] whitespace-nowrap">
        {incident.serviceName}
      </td>
      <td className="px-3 py-2.5 text-xs mono text-[var(--text2)] whitespace-nowrap">
        {incident.duration ?? t('incidents.duration.ongoing')}
      </td>
      <td className="px-3 py-2.5">
        <StatusBadge status={incident.status} t={t} />
      </td>
    </tr>
  )
}

// Mobile card
function IncidentCard({ incident, isSelected, onClick, t, lang }) {
  return (
    <button
      onClick={onClick}
      className={`w-full text-left rounded border p-3 transition-colors space-y-1
        ${isSelected
          ? 'bg-[var(--bg2)] border-[var(--border-hi)]'
          : 'bg-[var(--bg1)] border-[var(--border)] hover:bg-[var(--bg2)]'}`}
    >
      <div className="flex items-start justify-between gap-2">
        <span className="text-xs text-[var(--text1)] font-medium truncate flex-1">
          {incident.title}
        </span>
        <StatusBadge status={incident.status} t={t} />
      </div>
      <div className="flex flex-wrap gap-x-1.5 text-[10px] mono text-[var(--text2)]">
        <span>{formatDate(incident.startedAt, lang)}</span>
        <span>·</span>
        <span>{incident.serviceName}</span>
        <span>·</span>
        <span>{incident.duration ?? t('incidents.duration.ongoing')}</span>
      </div>
    </button>
  )
}

// ── Main Component ───────────────────────────────────────────

export default function Incidents() {
  const { t, lang } = useLang()
  const { services: rawServices, loading, error } = usePolling()
  const services = rawServices ?? []

  const [serviceFilter, setServiceFilter] = useState('all')
  const [statusFilter,  setStatusFilter]  = useState('all')
  const [period,        setPeriod]        = useState(7)
  const [selectedId,    setSelectedId]    = useState(null)

  // Flatten all incidents from all services (stable ref while services unchanged)
  const allIncidents = useMemo(
    () =>
      services.flatMap((svc) =>
        (svc.incidents ?? []).map((inc) => ({ ...inc, serviceName: svc.name, serviceId: svc.id }))
      ),
    [services]
  )

  // Apply service, status, and period filters; sort newest first
  const filtered = useMemo(() => {
    const cutoff = period ? Date.now() - period * 86_400_000 : null
    return allIncidents
      .filter((inc) => serviceFilter === 'all' || inc.serviceId === serviceFilter)
      .filter((inc) => statusFilter  === 'all' || inc.status    === statusFilter)
      .filter((inc) => !cutoff || new Date(inc.startedAt).getTime() >= cutoff)
      .sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt))
  }, [allIncidents, serviceFilter, statusFilter, period])

  if (loading) return <div className=""><SkeletonUI /></div>
  if (error)   return <div className=""><EmptyState type="error" onAction={() => window.location.reload()} /></div>

  const selectedIncident = filtered.find((inc) => inc.id === selectedId) ?? null
  const handleSelect = (id) => setSelectedId((prev) => (prev === id ? null : id))
  const handleResetFilters = () => {
    setServiceFilter('all')
    setStatusFilter('all')
    setPeriod(7)
    setSelectedId(null)
  }

  return (
    <div className=" space-y-4">

      {/* ── Filters ── */}
      <FilterBar
        services={services}
        serviceFilter={serviceFilter}
        setServiceFilter={setServiceFilter}
        statusFilter={statusFilter}
        setStatusFilter={setStatusFilter}
        period={period}
        setPeriod={setPeriod}
        t={t}
      />

      {/* ── Detail panel (shown above list when an incident is selected) ── */}
      {selectedIncident && (
        <DetailPanel
          incident={selectedIncident}
          onClose={() => setSelectedId(null)}
          t={t}
          lang={lang}
        />
      )}

      {/* ── Incident list ── */}
      {filtered.length === 0 ? (
        <EmptyState type="neutral" onAction={handleResetFilters} />
      ) : (
        <>
          {/* Desktop table — hidden on mobile */}
          <section
            className="hidden md:block bg-[var(--bg1)] border border-[var(--border)] rounded-lg overflow-hidden"
            aria-label={t('nav.incidents')}
          >
            <table className="w-full">
              <thead>
                <tr className="border-b border-[var(--border)] bg-[var(--bg2)]">
                  {TABLE_COLS.map((key) => (
                    <th
                      key={key}
                      className="px-3 py-2 text-left text-[10px] mono text-[var(--text2)] uppercase tracking-wider font-medium"
                    >
                      {t(`incidents.${key}`)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filtered.map((inc) => (
                  <IncidentRow
                    key={inc.id}
                    incident={inc}
                    isSelected={inc.id === selectedId}
                    onClick={() => handleSelect(inc.id)}
                    t={t}
                    lang={lang}
                  />
                ))}
              </tbody>
            </table>
          </section>

          {/* Mobile card list — shown only on mobile */}
          <div className="flex flex-col gap-2 md:hidden">
            {filtered.map((inc) => (
              <IncidentCard
                key={inc.id}
                incident={inc}
                isSelected={inc.id === selectedId}
                onClick={() => handleSelect(inc.id)}
                t={t}
                lang={lang}
              />
            ))}
          </div>
        </>
      )}

    </div>
  )
}
