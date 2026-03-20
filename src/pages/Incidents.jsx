// Incidents — incident history and timeline page
// FilterBar: service, status, period (all stateful).
// Desktop: scrollable table (5 columns). Mobile: card list.
// Row/card click toggles a DetailPanel with per-stage timeline.

import { useState, useMemo, useRef, useEffect } from 'react'
import { useLang } from '../hooks/useLang'
import { usePolling } from '../hooks/usePolling'
import { formatDate } from '../utils/time'
import SkeletonUI from '../components/SkeletonUI'
import EmptyState from '../components/EmptyState'
import { trackEvent } from '../utils/analytics'

// ── Constants ────────────────────────────────────────────────

const STATUS_BADGE_CLASS = {
  ongoing:    'bg-[var(--status-bg-red)]   text-[var(--red)]',
  monitoring: 'bg-[var(--status-bg-amber)] text-[var(--amber)]',
  resolved:   'bg-[var(--status-bg-green)] text-[var(--green)]',
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
const PERIODS = [7, 30, 90]

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
  const selectStyle = { fontFamily: 'var(--font-mono)', fontSize: '11px', padding: '5px 10px', background: 'var(--bg2)', border: '1px solid var(--border-hi)', borderRadius: '5px', color: 'var(--text1)', cursor: 'pointer', outline: 'none' }
  return (
    <div className="flex flex-wrap gap-2">
      <select
        value={serviceFilter}
        onChange={(e) => setServiceFilter(e.target.value)}
        style={selectStyle}
        aria-label={t('incidents.filter.service')}
      >
        <option value="all">{t('incidents.filter.service.all')}</option>
        {services.map((svc) => (
          <option key={svc.id} value={svc.id}>{svc.name}</option>
        ))}
      </select>

      <select
        value={statusFilter}
        onChange={(e) => setStatusFilter(e.target.value)}
        style={selectStyle}
        aria-label={t('incidents.filter.status')}
      >
        <option value="all">{t('incidents.filter.status.all')}</option>
        {['ongoing', 'monitoring', 'resolved'].map((s) => (
          <option key={s} value={s}>{t(`incidents.status.${s}`)}</option>
        ))}
      </select>

      <select
        value={period}
        onChange={(e) => setPeriod(Number(e.target.value))}
        style={selectStyle}
        aria-label={t('incidents.filter.period')}
      >
        {PERIODS.map((p) => (
          <option key={p} value={p}>
            {t(`incidents.period.${p}d`)}
          </option>
        ))}
      </select>
    </div>
  )
}

function TimelineStep({ stage, text, at, isLast, t, lang }) {
  const { dot: dotCls = 'bg-[var(--text2)]', text: textCls = 'text-[var(--text2)]' } = STAGE_CLASS[stage] ?? {}
  return (
    <div className="flex gap-[14px]">
      <div className="flex flex-col items-center w-[14px] shrink-0">
        <span className={`w-2.5 h-2.5 rounded-full shrink-0 mt-[3px] ${dotCls}`} aria-hidden="true" />
        {!isLast && <div className="w-px flex-1 bg-[var(--border)] my-[3px] min-h-[16px]" />}
      </div>
      <div className="pb-4">
        <p className={`mono font-medium text-[10px] mb-[3px] ${textCls}`}>{t(`incidents.timeline.${stage}`)}</p>
        {text && <p className="text-xs text-[var(--text1)] mb-[3px]" style={{ lineHeight: 1.6 }}>{text}</p>}
        <p className="mono text-[10px] text-[var(--text2)]">{formatDate(at, lang)}</p>
      </div>
    </div>
  )
}

function DetailPanel({ incident, onClose, t, lang }) {
  const panelRef = useRef(null)
  useEffect(() => {
    const timer = setTimeout(() => {
      panelRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
    }, 50)
    return () => clearTimeout(timer)
  }, [incident.id])

  return (
    <div ref={panelRef} className="bg-[var(--bg1)] border border-[var(--border)] rounded-lg overflow-hidden mt-[10px]">
      <div className="flex items-start justify-between border-b border-[var(--border)]" style={{ padding: '14px 16px' }}>
        <div>
          <p className="text-sm font-medium text-[var(--text0)] mb-1">
            {incident.serviceName} — {incident.title}
          </p>
          <p className="mono text-[10px] text-[var(--text2)]">
            {formatDate(incident.startedAt, lang)}  ·  {t('incidents.col.duration')}: {incident.duration ?? t('incidents.duration.ongoing')}
          </p>
        </div>
        <button
          onClick={onClose}
          className="shrink-0 mono text-[11px] text-[var(--text1)] bg-[var(--bg2)] border border-[var(--border)] rounded hover:opacity-80 transition-opacity cursor-pointer"
          style={{ padding: '4px 10px' }}
          aria-label={t('modal.close')}
        >
          ✕ {t('modal.close')}
        </button>
      </div>
      <div style={{ padding: '20px 24px' }}>
        {(incident.timeline ?? []).length === 0 ? (
          <p className="text-xs text-[var(--text2)]">{t('incidents.timeline.empty')}</p>
        ) : (
          (incident.timeline ?? []).map((step, i) => (
            <TimelineStep
              key={`${step.stage}-${i}`}
              stage={step.stage}
              text={step.text}
              at={step.at}
              isLast={i === (incident.timeline?.length ?? 0) - 1}
              t={t}
              lang={lang}
            />
          ))
        )}
      </div>
    </div>
  )
}

// Desktop table row — grid layout matching design mockup: title+badge | time | service | duration | status
function IncidentRow({ incident, isSelected, onClick, t, lang }) {
  const statusCls = STATUS_BADGE_CLASS[incident.status] ?? STATUS_BADGE_CLASS.resolved
  return (
    <div
      onClick={onClick}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick() } }}
      tabIndex={0}
      role="row"
      className={`cursor-pointer transition-colors
        focus:outline-none focus:ring-1 focus:ring-[var(--border-hi)]
        ${isSelected ? 'bg-[var(--bg2)] border-l-2 border-l-[var(--blue)]' : 'hover:bg-[var(--bg2)]'}`}
      style={{ display: 'grid', gridTemplateColumns: '140px 1fr 100px 80px 80px', gap: '12px', padding: '10px 14px', borderBottom: '1px solid var(--border)', alignItems: 'center' }}
    >
      <span role="cell" className="mono" style={{ fontSize: '11px', color: 'var(--text2)' }}>{formatDate(incident.startedAt, lang)}</span>
      <div role="cell" className="flex items-center gap-2 min-w-0">
        <span style={{ fontSize: '12px', fontWeight: 500, color: 'var(--text0)' }} className="truncate">{incident.title}</span>
        <span className={`shrink-0 mono ${statusCls}`} style={{ fontSize: '9px', letterSpacing: '0.04em', padding: '2px 6px', borderRadius: '3px' }}>
          {t(`incidents.status.${incident.status}`)}
        </span>
      </div>
      <span role="cell" className="mono" style={{ fontSize: '11px', color: 'var(--text1)' }}>{incident.serviceName}</span>
      <span role="cell" className="mono" style={{ fontSize: '11px', color: 'var(--text2)' }}>{incident.duration ?? t('incidents.duration.ongoing')}</span>
      <span role="cell" className="mono" style={{ fontSize: '11px', color: 'var(--text2)' }}>{t(`incidents.status.${incident.status}`)}</span>
    </div>
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
        <span style={{ fontSize: '13px', fontWeight: 500, color: 'var(--text0)', flex: 1 }}>
          {incident.title}
        </span>
        <StatusBadge status={incident.status} t={t} />
      </div>
      <div className="flex items-center flex-wrap mono text-[var(--text2)]" style={{ fontSize: '10px', gap: '6px' }}>
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
  // Normalize Worker statuses (investigating/identified) → 'ongoing' for display
  const allIncidents = useMemo(
    () =>
      services.flatMap((svc) =>
        (svc.incidents ?? []).map((inc) => ({
          ...inc,
          status: inc.status === 'resolved' ? 'resolved'
            : inc.status === 'monitoring' ? 'monitoring'
            : 'ongoing',
          serviceName: svc.name,
          serviceId: svc.id,
        }))
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

  if (loading && services.length === 0) return <SkeletonUI />
  if (error)   return <EmptyState type="error" onAction={() => window.location.reload()} />

  const selectedIncident = filtered.find((inc) => inc.id === selectedId) ?? null
  const handleSelect = (id) => {
    setSelectedId((prev) => {
      const next = prev === id ? null : id
      if (next !== null) trackEvent('view_incident', { incident_id: id })
      return next
    })
  }
  const handleResetFilters = () => {
    setServiceFilter('all')
    setStatusFilter('all')
    setPeriod(7)
    setSelectedId(null)
  }

  return (
    <div className="flex flex-col" style={{ gap: '16px' }}>

      {/* ── Section Header ── */}
      <div className="flex items-center justify-between">
        <h2 className="mono text-[10px] text-[var(--text2)] uppercase flex items-center gap-2" style={{ letterSpacing: '0.1em' }}>
          <span className="text-[var(--green)] font-semibold">//</span>
          {t('nav.incidents')}
        </h2>
        <span className="mono text-[10px] text-[var(--text2)]">{t('overview.panel.incidents.sub')}</span>
      </div>

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
            {/* Header row */}
            <div role="row" style={{ display: 'grid', gridTemplateColumns: '140px 1fr 100px 80px 80px', gap: '12px', padding: '8px 14px', borderBottom: '1px solid var(--border)' }}>
              {TABLE_COLS.map((key) => (
                <span key={key} role="columnheader" className="mono text-[var(--text2)] uppercase font-medium" style={{ fontSize: '9px', letterSpacing: '0.08em' }}>
                  {t(`incidents.${key}`)}
                </span>
              ))}
            </div>
            {/* Rows — inline styles required: Tailwind v4 base reset zeroes padding on interactive elements */}
            <div role="rowgroup">
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
            </div>
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

      {/* ── Detail panel (shown below list when an incident is selected) ── */}
      {selectedIncident && (
        <DetailPanel
          incident={selectedIncident}
          onClose={() => setSelectedId(null)}
          t={t}
          lang={lang}
        />
      )}

    </div>
  )
}
