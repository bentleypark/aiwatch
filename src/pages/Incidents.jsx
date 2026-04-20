// Incidents — incident history and timeline page
// FilterBar: service, status, period (all stateful).
// Desktop: scrollable table (5 columns). Mobile: card list.
// Row/card click toggles a DetailPanel with per-stage timeline.

import { useState, useMemo } from 'react'
import { useLang } from '../hooks/useLang'
import { usePolling } from '../hooks/usePolling'
import { formatDate } from '../utils/time'
import { groupIncidents } from '../utils/incidentGrouping'
import { IncidentsSkeleton } from '../components/SkeletonUI'
import IncidentTimeline from '../components/IncidentTimeline'
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

// ── Helpers ──────────────────────────────────────────────────

/** Status group priority: investigating/identified → monitoring → resolved */
const STATUS_PRIORITY = { ongoing: 0, monitoring: 1, resolved: 2 }

/** Get resolved time: resolvedAt field, or last resolved timeline entry, or null */
function getResolvedTime(inc) {
  if (inc.resolvedAt) return inc.resolvedAt
  const tl = inc.timeline ?? []
  const resolvedEntry = [...tl].reverse().find(t => t.stage === 'resolved')
  return resolvedEntry?.at ?? null
}

/** Last element of array (ES5-safe) */
function last(arr) { return arr && arr.length > 0 ? arr[arr.length - 1] : undefined }

/** Get the most recent activity time for sorting */
function getLatestActivity(inc) {
  if (inc.status === 'resolved') {
    const resolved = getResolvedTime(inc)
    if (resolved) return new Date(resolved).getTime()
  }
  const lastTimeline = last(inc.timeline)
  if (lastTimeline?.at) return new Date(lastTimeline.at).getTime()
  return new Date(inc.startedAt).getTime()
}

/** Get contextual timestamp label and date based on status */
function getContextualTime(inc, t) {
  if (inc.status === 'resolved') {
    const resolved = getResolvedTime(inc)
    if (resolved) return { label: t('incidents.time.resolved'), date: resolved }
  }
  if (inc.status === 'monitoring') {
    const lt = last(inc.timeline)
    if (lt?.at) return { label: t('incidents.time.updated'), date: lt.at }
  }
  if (inc.status === 'ongoing') {
    const lt = last(inc.timeline)
    if (lt?.at && lt.at !== inc.startedAt) {
      return { label: t('incidents.time.updated'), date: lt.at }
    }
  }
  return { label: t('incidents.time.started'), date: inc.startedAt }
}

// ── Sub-components ───────────────────────────────────────────

function StatusBadge({ status, t }) {
  const cls = STATUS_BADGE_CLASS[status] ?? STATUS_BADGE_CLASS.resolved
  return (
    <span className={`inline-flex items-center rounded text-[11px] mono font-medium ${cls}`} style={{ padding: '2px 6px' }}>
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

function DetailPanel({ incident, onClose, hideHeader, t, lang }) {
  return (
    <IncidentTimeline
      title={`${incident.serviceName} — ${incident.title}`}
      subtitle={`${formatDate(incident.startedAt, lang)}  ·  ${t('incidents.col.duration')}: ${incident.duration ?? t('incidents.duration.ongoing')}`}
      timeline={incident.timeline}
      onClose={onClose}
      hideHeader={hideHeader}
      t={t}
      lang={lang}
    />
  )
}

// Desktop table row — grid layout matching design mockup: title+badge | time | service | duration | status
// Accordion: detail panel renders inline below the selected row
function IncidentRow({ incident, isSelected, onClick, onClose, t, lang }) {
  const statusCls = STATUS_BADGE_CLASS[incident.status] ?? STATUS_BADGE_CLASS.resolved
  const ctx = getContextualTime(incident, t)
  return (
    <>
      <div
        onClick={onClick}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick() } }}
        tabIndex={0}
        role="row"
        className={`cursor-pointer transition-colors
          focus:outline-none focus:ring-1 focus:ring-[var(--border-hi)]
          ${isSelected ? 'bg-[var(--bg2)] border-l-2 border-l-[var(--blue)]' : 'hover:bg-[var(--bg2)]'}`}
        style={{ display: 'grid', gridTemplateColumns: '190px 1fr 100px 80px 80px', gap: '12px', padding: '10px 14px', borderBottom: '1px solid var(--border)', alignItems: 'center' }}
      >
        <span role="cell" className="mono" style={{ fontSize: '11px', color: 'var(--text2)' }}><span style={{ color: 'var(--text2)', opacity: 0.7 }}>{ctx.label}</span> {formatDate(ctx.date, lang)}</span>
        <div role="cell" className="flex items-center gap-2 min-w-0">
          <span style={{ fontSize: '12px', fontWeight: 500, color: 'var(--text0)' }} className="truncate">{incident.title}</span>
          <span className={`shrink-0 mono ${statusCls}`} style={{ fontSize: '9px', letterSpacing: '0.04em', padding: '2px 6px', borderRadius: '3px' }}>
            {t(`incidents.status.${incident.status}`)}
          </span>
        </div>
        <span role="cell" className="mono" style={{ fontSize: '11px', color: 'var(--text1)' }}>
          {incident.affectedNames?.length > 1 ? incident.affectedNames.join(', ') : incident.serviceName}
        </span>
        <span role="cell" className="mono" style={{ fontSize: '11px', color: 'var(--text2)' }}>{incident.duration ?? t('incidents.duration.ongoing')}</span>
        <span role="cell" className="mono" style={{ fontSize: '11px', color: 'var(--text2)' }}>{t(`incidents.status.${incident.status}`)}</span>
      </div>
      {isSelected && <DetailPanel incident={incident} onClose={onClose} t={t} lang={lang} />}
    </>
  )
}

// Mobile card — accordion detail inline
function IncidentCard({ incident, isSelected, onClick, onClose, t, lang }) {
  const ctx = getContextualTime(incident, t)
  return (
    <div>
      <button
        onClick={onClick}
        className={`w-full text-left rounded border transition-colors space-y-1
          ${isSelected
            ? 'bg-[var(--bg2)] border-[var(--border-hi)]'
            : 'bg-[var(--bg1)] border-[var(--border)] hover:bg-[var(--bg2)]'}`}
        style={{ paddingTop: 10, paddingBottom: 10, paddingLeft: 10, paddingRight: 10 }}
      >
        <div className="flex items-start justify-between gap-2">
          <span style={{ fontSize: '13px', fontWeight: 500, color: 'var(--text0)', flex: 1 }}>
            {incident.title}
          </span>
          <StatusBadge status={incident.status} t={t} />
        </div>
        <div className="flex items-center flex-wrap mono text-[var(--text2)]" style={{ fontSize: '10px', gap: '6px' }}>
          <span>{ctx.label} {formatDate(ctx.date, lang)}</span>
          <span>·</span>
          <span>{incident.affectedNames?.length > 1 ? incident.affectedNames.join(', ') : incident.serviceName}</span>
          <span>·</span>
          <span>{incident.duration ?? t('incidents.duration.ongoing')}</span>
        </div>
      </button>
      {isSelected && <DetailPanel incident={incident} onClose={onClose} hideHeader t={t} lang={lang} />}
    </div>
  )
}

// Desktop group row (collapsed): single grid row with [×N flaps] badge; click toggles entries.
// Entries render as ordinary IncidentRows below in their own rowgroup.
function IncidentGroupRow({ group, expanded, onToggle, selectedId, onSelect, onClose, t, lang }) {
  const dominantStatus = group.uniformStatus
    ? Object.keys(group.statusCounts)[0]
    : (['ongoing', 'monitoring', 'resolved'].find(s => group.statusCounts[s]) ?? 'resolved')
  const statusCls = STATUS_BADGE_CLASS[dominantStatus] ?? STATUS_BADGE_CLASS.resolved
  const statusLabel = group.uniformStatus
    ? t('incidents.group.statusUniform').replace('{status}', t(`incidents.status.${dominantStatus}`).toLowerCase())
    : Object.entries(group.statusCounts).map(([s, n]) => `${n} ${t(`incidents.status.${s}`).toLowerCase()}`).join(' · ')
  const firstEntry = group.entries[0]
  const serviceLabel = firstEntry.affectedNames?.length > 1 ? firstEntry.affectedNames.join(', ') : firstEntry.serviceName
  return (
    <>
      <div
        onClick={onToggle}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onToggle() } }}
        tabIndex={0}
        role="row"
        aria-expanded={expanded}
        aria-label={expanded ? t('incidents.group.collapse') : t('incidents.group.expand')}
        className="cursor-pointer transition-colors hover:bg-[var(--bg2)] focus:outline-none focus:ring-1 focus:ring-[var(--border-hi)]"
        style={{ display: 'grid', gridTemplateColumns: '190px 1fr 100px 80px 80px', gap: '12px', padding: '10px 14px', borderBottom: '1px solid var(--border)', alignItems: 'center' }}
      >
        <span role="cell" className="mono" style={{ fontSize: '11px', color: 'var(--text2)' }}>
          {formatDate(group.rangeStart, lang)} → {formatDate(group.rangeEnd, lang)}
        </span>
        <div role="cell" className="flex items-center gap-2 min-w-0">
          <span className="text-[9px] text-[var(--text2)]" aria-hidden="true">{expanded ? '▾' : '▸'}</span>
          <span style={{ fontSize: '12px', fontWeight: 500, color: 'var(--text0)' }} className="truncate">{group.normalizedTitle}</span>
          <span
            className="shrink-0 mono text-[var(--text2)] bg-[var(--bg2)]"
            style={{ fontSize: '9px', letterSpacing: '0.04em', padding: '2px 6px', borderRadius: '3px' }}
          >
            {t('incidents.group.flaps').replace('{n}', String(group.count))}
          </span>
        </div>
        <span role="cell" className="mono" style={{ fontSize: '11px', color: 'var(--text1)' }}>{serviceLabel}</span>
        <span role="cell" className="mono" style={{ fontSize: '11px', color: 'var(--text2)' }}>—</span>
        <span role="cell" className={`mono ${statusCls}`} style={{ fontSize: '9px', letterSpacing: '0.04em', padding: '2px 6px', borderRadius: '3px', justifySelf: 'start' }}>
          {statusLabel}
        </span>
      </div>
      {expanded && (
        // Visually distinguish grouped children from siblings: tinted background +
        // left accent border. Without this, expanded children look identical to
        // ungrouped rows above/below and lose their group affiliation visually.
        <div role="rowgroup" className="bg-[var(--bg2)]" style={{ borderLeft: '2px solid var(--border-hi)', borderBottom: '1px solid var(--border)' }}>
          {group.entries.map((inc) => (
            <IncidentRow
              key={inc.id}
              incident={inc}
              isSelected={inc.id === selectedId}
              onClick={() => onSelect(inc.id)}
              onClose={onClose}
              t={t}
              lang={lang}
            />
          ))}
        </div>
      )}
    </>
  )
}

function IncidentGroupCard({ group, expanded, onToggle, selectedId, onSelect, onClose, t, lang }) {
  const dominantStatus = group.uniformStatus
    ? Object.keys(group.statusCounts)[0]
    : (['ongoing', 'monitoring', 'resolved'].find(s => group.statusCounts[s]) ?? 'resolved')
  const statusLabel = group.uniformStatus
    ? t('incidents.group.statusUniform').replace('{status}', t(`incidents.status.${dominantStatus}`).toLowerCase())
    : Object.entries(group.statusCounts).map(([s, n]) => `${n} ${t(`incidents.status.${s}`).toLowerCase()}`).join(' · ')
  const firstEntry = group.entries[0]
  const serviceLabel = firstEntry.affectedNames?.length > 1 ? firstEntry.affectedNames.join(', ') : firstEntry.serviceName
  return (
    <div>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        aria-label={expanded ? t('incidents.group.collapse') : t('incidents.group.expand')}
        // minHeight: 44px ensures touch target meets WCAG / Apple HIG recommendation
        className="w-full text-left rounded border border-[var(--border)] bg-[var(--bg1)] hover:bg-[var(--bg2)] transition-colors space-y-1"
        style={{ padding: '10px', minHeight: '44px' }}
      >
        <div className="flex items-start justify-between gap-2">
          <span style={{ fontSize: '13px', fontWeight: 500, color: 'var(--text0)', flex: 1 }}>
            {group.normalizedTitle}
          </span>
          <span
            className="shrink-0 mono text-[var(--text2)] bg-[var(--bg2)]"
            style={{ fontSize: '10px', padding: '2px 6px', borderRadius: '3px' }}
          >
            {t('incidents.group.flaps').replace('{n}', String(group.count))}
          </span>
        </div>
        <div className="flex items-center flex-wrap mono text-[var(--text2)]" style={{ fontSize: '10px', gap: '6px' }}>
          <span>{formatDate(group.rangeStart, lang)} → {formatDate(group.rangeEnd, lang)}</span>
          <span>·</span>
          <span>{serviceLabel}</span>
          <span>·</span>
          <span>{statusLabel}</span>
          <span className="ml-auto text-[var(--text2)]" aria-hidden="true">{expanded ? '▾' : '▸'}</span>
        </div>
      </button>
      {expanded && (
        // Mirror desktop: indent + left accent + bg tint so the expanded entries read
        // as belonging to the group above, not as new top-level cards.
        <div
          className="flex flex-col gap-2 bg-[var(--bg2)] rounded"
          style={{ marginTop: '8px', marginLeft: '12px', paddingLeft: '10px', paddingTop: '8px', paddingBottom: '8px', paddingRight: '6px', borderLeft: '2px solid var(--border-hi)' }}
        >
          {group.entries.map((inc) => (
            <IncidentCard
              key={inc.id}
              incident={inc}
              isSelected={inc.id === selectedId}
              onClick={() => onSelect(inc.id)}
              onClose={onClose}
              t={t}
              lang={lang}
            />
          ))}
        </div>
      )}
    </div>
  )
}

// ── Main Component ───────────────────────────────────────────

export default function Incidents() {
  const { t, lang } = useLang()
  const { services: rawServices, loading, error, refresh } = usePolling()
  const services = rawServices ?? []

  const [serviceFilter, setServiceFilter] = useState('all')
  const [statusFilter,  setStatusFilter]  = useState('all')
  const [period,        setPeriod]        = useState(7)
  const [selectedId,    setSelectedId]    = useState(null)
  const [expandedGroups, setExpandedGroups] = useState(() => new Set())

  // Flatten all incidents from all services (stable ref while services unchanged)
  // Normalize Worker statuses (investigating/identified) → 'ongoing' for display
  // Deduplicate only when no service filter — services sharing a status page (e.g., Claude API +
  // claude.ai + Claude Code) return same incident IDs. With a service filter active, show all
  // incidents belonging to that service so none get hidden by earlier-processed services.
  const allIncidents = useMemo(
    () => {
      if (serviceFilter !== 'all') {
        // With service filter: show all incidents for that service
        return services.flatMap((svc) =>
          (svc.incidents ?? []).flatMap((inc) => [{
            ...inc,
            id: `${svc.id}:${inc.id}`,
            status: inc.status === 'resolved' ? 'resolved'
              : inc.status === 'monitoring' ? 'monitoring'
              : 'ongoing',
            serviceName: svc.name,
            serviceId: svc.id,
          }])
        )
      }
      // Without filter: dedup by incidentId, collect all affected service names
      const incMap = new Map() // incidentId → merged incident
      for (const svc of services) {
        for (const inc of svc.incidents ?? []) {
          const existing = incMap.get(inc.id)
          if (existing) {
            if (!existing.affectedNames.includes(svc.name)) existing.affectedNames.push(svc.name)
          } else {
            incMap.set(inc.id, {
              ...inc,
              id: `${svc.id}:${inc.id}`,
              status: inc.status === 'resolved' ? 'resolved'
                : inc.status === 'monitoring' ? 'monitoring'
                : 'ongoing',
              serviceName: svc.name,
              serviceId: svc.id,
              affectedNames: [svc.name],
            })
          }
        }
      }
      return [...incMap.values()]
    },
    [services, serviceFilter]
  )

  // Apply service, status, and period filters; sort newest first
  const filtered = useMemo(() => {
    const cutoff = period ? Date.now() - period * 86_400_000 : null
    return allIncidents
      .filter((inc) => serviceFilter === 'all' || inc.serviceId === serviceFilter)
      .filter((inc) => statusFilter  === 'all' || inc.status    === statusFilter)
      .filter((inc) => !cutoff || inc.status !== 'resolved' || new Date(inc.startedAt).getTime() >= cutoff)
      .sort((a, b) => {
        // Priority 1: status group (ongoing → monitoring → resolved)
        const aPri = STATUS_PRIORITY[a.status] ?? 2
        const bPri = STATUS_PRIORITY[b.status] ?? 2
        if (aPri !== bPri) return aPri - bPri
        // Priority 2: most recent activity (timeline last update, resolvedAt, or startedAt)
        return getLatestActivity(b) - getLatestActivity(a)
      })
  }, [allIncidents, serviceFilter, statusFilter, period])

  // groupIncidents re-sorts purely by date — re-apply STATUS_PRIORITY so ongoing
  // incidents stay above resolved flap groups. Sort is stable (ES2019+), so
  // newest-first ordering within the same status is preserved.
  const grouped = useMemo(() => {
    const rows = groupIncidents(filtered)
    const statusOf = (r) => r.kind === 'single'
      ? r.incident.status
      : (['ongoing', 'monitoring', 'resolved'].find(s => r.statusCounts[s]) ?? 'resolved')
    return rows.slice().sort((a, b) => (STATUS_PRIORITY[statusOf(a)] ?? 2) - (STATUS_PRIORITY[statusOf(b)] ?? 2))
  }, [filtered])

  if (loading && services.length === 0) return <IncidentsSkeleton />
  if (!loading && services.length === 0 && error) return <EmptyState type="offline" onAction={refresh} />
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
  const groupKey = (g) => `${g.dayKey}::${g.normalizedTitle}`
  const toggleGroup = (key) => setExpandedGroups((prev) => {
    const next = new Set(prev)
    if (next.has(key)) next.delete(key); else next.add(key)
    return next
  })

  return (
    <div className="flex flex-col" style={{ gap: '16px' }}>

      {/* ── Section Header ── */}
      <div className="flex items-center justify-between">
        <h2 className="mono text-[10px] text-[var(--text2)] uppercase flex items-center gap-2" style={{ letterSpacing: '0.1em' }}>
          <span className="text-[var(--green)] font-semibold">//</span>
          {t('nav.incidents')}
        </h2>
        <span className="mono text-[10px] text-[var(--text2)]">{t(`incidents.period.${period}d`)}</span>
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
            <div role="row" style={{ display: 'grid', gridTemplateColumns: '190px 1fr 100px 80px 80px', gap: '12px', padding: '8px 14px', borderBottom: '1px solid var(--border)' }}>
              {TABLE_COLS.map((key) => (
                <span key={key} role="columnheader" className="mono text-[var(--text2)] uppercase font-medium" style={{ fontSize: '9px', letterSpacing: '0.08em' }}>
                  {t(`incidents.${key}`)}
                </span>
              ))}
            </div>
            {/* Rows — inline styles required: Tailwind v4 base reset zeroes padding on interactive elements */}
            <div role="rowgroup">
              {grouped.map((row) => row.kind === 'group' ? (
                <IncidentGroupRow
                  key={`group:${groupKey(row)}`}
                  group={row}
                  expanded={expandedGroups.has(groupKey(row))}
                  onToggle={() => toggleGroup(groupKey(row))}
                  selectedId={selectedId}
                  onSelect={handleSelect}
                  onClose={() => setSelectedId(null)}
                  t={t}
                  lang={lang}
                />
              ) : (
                <IncidentRow
                  key={row.incident.id}
                  incident={row.incident}
                  isSelected={row.incident.id === selectedId}
                  onClick={() => handleSelect(row.incident.id)}
                  onClose={() => setSelectedId(null)}
                  t={t}
                  lang={lang}
                />
              ))}
            </div>
          </section>

          {/* Mobile card list — shown only on mobile */}
          <div className="flex flex-col gap-2 md:hidden">
            {grouped.map((row) => row.kind === 'group' ? (
              <IncidentGroupCard
                key={`group:${groupKey(row)}`}
                group={row}
                expanded={expandedGroups.has(groupKey(row))}
                onToggle={() => toggleGroup(groupKey(row))}
                selectedId={selectedId}
                onSelect={handleSelect}
                onClose={() => setSelectedId(null)}
                t={t}
                lang={lang}
              />
            ) : (
              <IncidentCard
                key={row.incident.id}
                incident={row.incident}
                isSelected={row.incident.id === selectedId}
                onClick={() => handleSelect(row.incident.id)}
                onClose={() => setSelectedId(null)}
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
