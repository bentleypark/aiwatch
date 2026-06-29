// Service Details — per-service monitoring page
// Receives serviceId prop from App.jsx (page.serviceId).
// Shows header, 4 metric cards, incident history, 30-day status calendar.

import { useEffect, useMemo, useRef, useState } from 'react'
import IncidentTimeline from '../components/IncidentTimeline'
import ReportModal from '../components/ReportModal'
import RecentUserReports from '../components/RecentUserReports'
import { useLang } from '../hooks/useLang'
import { usePage } from '../utils/pageContext'
import { usePolling } from '../hooks/usePolling'
import { trackEvent } from '../utils/analytics'
import { formatDate } from '../utils/time'
import { buildCalendarFromIncidents } from '../utils/calendar'
import { groupIncidents } from '../utils/incidentGrouping'
import { buildBadgeMarkdown } from '../utils/badge'
import { compareGroupedRows, dominantGroupStatus } from '../utils/incidentSort'
import { SCORE_TEXT_CLASS, feedUrlOf } from '../utils/constants'
import { computeRecoveryStats, formatRecoveryMin } from '../utils/recovery'
import { isUnreliableUptime, noOfficialUptime } from '../utils/serviceReliability'
import { regionStatusOf, SERVICE_REGIONS } from '../utils/regionStatus'
import { ServiceDetailsSkeleton } from '../components/SkeletonUI'
import EmptyState from '../components/EmptyState'
import StatusPill from '../components/StatusPill'
import { ensureChart } from '../utils/chartLoader'
import { filterLast24h } from '../utils/time'

// ── Constants ────────────────────────────────────────────────

// Per-service chart line colors (visualization palette — not design tokens).
// Canvas-based charts cannot use CSS custom properties directly.
// Must stay in sync with the same map in Latency.jsx.
const SERVICE_COLOR = {
  claude:      '#79c0ff',
  openai:      '#56d364',
  gemini:      '#f78166',
  mistral:     '#d2a8ff',
  cohere:      '#ffb86c',
  groq:        '#50fa7b',
  together:    '#8be9fd',
  perplexity:  '#ff79c6',
  huggingface: '#f1fa8c',
  replicate:   '#bd93f9',
  fal:         '#ff8cc8',
  elevenlabs:  '#6be5e2',
  xai:         '#e0e0e0',
  deepseek:    '#ff6b6b',
}

// Official status page URLs for each monitored service
const STATUS_URL = {
  claude:      'https://status.claude.com',
  openai:      'https://status.openai.com',
  gemini:      'https://aistudio.google.com/status',
  mistral:     'https://status.mistral.ai',
  cohere:      'https://status.cohere.ai',
  groq:        'https://status.groq.com',
  together:    'https://status.together.ai',
  fireworks:   'https://status.fireworks.ai',
  cerebras:    'https://status.cerebras.ai',
  perplexity:  'https://status.perplexity.ai',
  huggingface: 'https://status.huggingface.co',
  replicate:   'https://www.replicatestatus.com',
  fal:         'https://status.fal.ai',
  elevenlabs:  'https://status.elevenlabs.io',
  xai:         'https://status.x.ai',
  deepseek:    'https://status.deepseek.com',
  openrouter:  'https://status.openrouter.ai',
  bedrock:     'https://health.aws.amazon.com/health/status',
  pinecone:    'https://status.pinecone.io',
  stability:   'https://status.stability.ai',
  bfl:         'https://status.bfl.ml',
  voyageai:    'https://voyageai-status.statuspage.io',
  modal:       'https://status.modal.com',
  langsmith:   'https://status.smith.langchain.com',
  helicone:    'https://status.helicone.ai',
  langfuse:    'https://status.langfuse.com',
  runway:      'https://status.runwayml.com',
  luma:        'https://status.lumalabs.ai',
  assemblyai:  'https://status.assemblyai.com',
  deepgram:    'https://status.deepgram.com',
  azureopenai: 'https://azure.status.microsoft/en-us/status',
  characterai: 'https://status.character.ai',
  claudeai:    'https://status.claude.com',
  chatgpt:     'https://status.openai.com',
  deepseekapp: 'https://status.deepseek.com',
  claudecode:  'https://status.claude.com',
  copilot:     'https://githubstatus.com',
  cursor:      'https://status.cursor.com',
  windsurf:    'https://status.windsurf.com',
  junie:       'https://status.jetbrains.ai',
  codex:       'https://status.openai.com',
}

// #717 — services whose status is sourced from MORE THAN ONE upstream status page. The worker
// already merges both feeds (e.g. Gemini = AI Studio + Google Cloud / Vertex); this surfaces both
// links so users can reach either source. Services absent here fall back to the single STATUS_URL.
const STATUS_SOURCES = {
  gemini: [
    { url: 'https://aistudio.google.com/status', labelKey: 'svc.status.linkAistudio' },
    { url: 'https://status.cloud.google.com',    labelKey: 'svc.status.linkGcloud' },
  ],
}

// Services that cannot provide incident data (no API, bot-protected, etc.)
const NO_INCIDENT_SUPPORT = new Set([])

// Calendar cell status → Tailwind color class (#663 impact-aligned keys, frontend-internal)
const CALENDAR_CLASS = {
  operational:  'bg-[var(--green)]',
  minor:        'bg-[var(--yellow)]',
  major:        'bg-[var(--amber)]',
  critical:     'bg-[var(--red)]',
}

// Compute calendar date label for index i (0 = oldest, last = today)
function calendarDate(i, lang, days = 30) {
  const d = new Date(Date.now() - (days - 1 - i) * 86_400_000)
  return new Intl.DateTimeFormat(lang === 'ko' ? 'ko-KR' : 'en-US', {
    month: 'short',
    day: 'numeric',
  }).format(d)
}

// ── Sub-components ───────────────────────────────────────────

const METRIC_TOP_COLOR = {
  'text-[var(--blue)]':  'var(--blue)',
  'text-[var(--green)]': 'var(--green)',
  'text-[var(--amber)]': 'var(--amber)',
  'text-[var(--red)]':   'var(--red)',
  'text-[var(--text1)]': 'var(--border)',
  'text-[var(--text2)]': 'var(--border)',
}

function MetricCard({ label, value, sub, colorClass }) {
  const topColor = METRIC_TOP_COLOR[colorClass] ?? 'var(--border)'
  return (
    <div className="relative bg-[var(--bg1)] border border-[var(--border)] rounded-lg overflow-hidden" style={{ padding: '14px 16px' }}>
      <span className="absolute top-0 left-0 right-0 h-px" style={{ background: topColor }} />
      <div className="mono text-[9px] text-[var(--text2)] uppercase" style={{ letterSpacing: '0.1em', marginBottom: '6px' }}>{label}</div>
      <div className={`mono text-[26px] font-semibold leading-none ${colorClass}`} style={{ marginBottom: '4px' }}>{value}</div>
      {sub && <div className="mono text-[10px] text-[var(--text2)]">{sub}</div>}
    </div>
  )
}

function ServiceLatencyTrend({ service, t, hourlyData }) {
  const canvasRef = useRef(null)
  const chartRef = useRef(null)
  const hasData = hourlyData && hourlyData.length > 0

  useEffect(() => {
    if (!canvasRef.current || !hasData) return
    let cancelled = false
    ensureChart().then((Chart) => {
      if (cancelled || !canvasRef.current) return
      if (chartRef.current) chartRef.current.destroy()

    const labels = hourlyData.map((s) => {
      const d = new Date(s.t)
      return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
    })
    const values = hourlyData.map((s) => {
      const val = s.data[service.id]
      if (val == null) return null
      if (typeof val === 'object') return val.rtt > 0 ? val.rtt : null
      return val
    })
    const color = SERVICE_COLOR[service.id] ?? '#8b949e'

    const styles = getComputedStyle(document.documentElement)
    const textMuted = styles.getPropertyValue('--text2').trim() || '#6b7280'
    const borderColor = styles.getPropertyValue('--border').trim() || 'rgba(107,114,128,0.1)'

    chartRef.current = new Chart(canvasRef.current, {
      type: 'line',
      data: {
        labels,
        datasets: [{
          data: values,
          borderColor: color,
          backgroundColor: color + '20',
          borderWidth: 1.5,
          pointRadius: 2,
          pointHoverRadius: 4,
          tension: 0.3,
          fill: true,
          spanGaps: true,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              label: (ctx) => ctx.parsed.y != null ? `${ctx.parsed.y}ms` : null,
            },
          },
        },
        scales: {
          x: {
            ticks: { font: { size: 9, family: 'var(--font-mono)' }, color: textMuted, maxTicksLimit: 12, callback: (_, i) => { const l = labels[i]; return l ? l.slice(0, 3) + '00' : '' } },
            grid: { display: false },
          },
          y: {
            ticks: { font: { size: 9, family: 'var(--font-mono)' }, color: textMuted, callback: (v) => `${v}ms` },
            grid: { color: borderColor },
          },
        },
      },
    })

    }) // ensureChart
    return () => { cancelled = true; if (chartRef.current) { chartRef.current.destroy(); chartRef.current = null } }
  }, [hasData, hourlyData, service.id])

  return (
    <section className="bg-[var(--bg1)] border border-[var(--border)] rounded-lg overflow-hidden">
      <div className="border-b border-[var(--border)]" style={{ padding: '12px 16px' }}>
        <div className="mono text-[10px] text-[var(--text1)] uppercase tracking-wider flex items-center gap-1.5">
          <span className="rounded-full shrink-0" style={{ width: '5px', height: '5px', background: 'var(--blue)' }} />
          {t('latency.trend')}
        </div>
      </div>
      {hasData ? (
        <div style={{ padding: '16px' }}>
          <div style={{ height: '200px' }}>
            <canvas ref={canvasRef} />
          </div>
        </div>
      ) : (
        <div className="flex items-center justify-center" style={{ padding: '40px 16px' }}>
          <p className="text-xs text-[var(--text2)] mono">{t('uptime.collecting')}</p>
        </div>
      )}
    </section>
  )
}

function IncidentRow({ incident, isRecentlyRecovered, t, lang }) {
  const [expanded, setExpanded] = useState(false)
  const STATUS_CLS = {
    investigating: 'text-[var(--red)]',
    identified:    'text-[var(--red)]',
    ongoing:       'text-[var(--red)]',
    monitoring:    'text-[var(--amber)]',
    resolved:      'text-[var(--text2)]',
  }
  const dotCls = STATUS_CLS[incident.status] ?? STATUS_CLS.resolved
  const displayStatus = incident.status === 'resolved' ? 'resolved'
    : incident.status === 'monitoring' ? 'monitoring'
    : 'ongoing'
  const hasTimeline = (incident.timeline ?? []).length > 0

  return (
    <div>
      <div
        className={`flex items-start gap-[10px] ${hasTimeline ? 'cursor-pointer hover:bg-[var(--bg2)] rounded transition-colors' : ''}`}
        style={{ padding: '2px 4px', margin: '-2px -4px' }}
        onClick={hasTimeline ? () => setExpanded((v) => !v) : undefined}
      >
        <span className={`shrink-0 mt-0.5 text-[10px] mono ${dotCls}`} aria-hidden="true">●</span>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <p className="text-xs text-[var(--text1)] truncate">{incident.title}</p>
            {hasTimeline && expanded && (
              <span className="shrink-0 text-[9px] text-[var(--text2)]">▾</span>
            )}
          </div>
          <p className="text-[10px] text-[var(--text2)] mono mt-0.5">
            {formatDate(incident.startedAt, lang)}
            {incident.duration ? ` · ${incident.duration}` : ''}
          </p>
        </div>
        {isRecentlyRecovered ? (
          <span className="shrink-0 mono text-[9px] rounded" style={{ color: 'var(--blue)', background: 'var(--blue-dim)', padding: '1px 5px' }}>
            {t('overview.recovered')}
          </span>
        ) : (
          <span className={`shrink-0 text-[10px] mono ${dotCls}`}>
            {t(`incidents.status.${displayStatus}`)}
          </span>
        )}
      </div>
      {expanded && (
        <div className="ml-6">
          <IncidentTimeline
            title={incident.title}
            subtitle={`${formatDate(incident.startedAt, lang)}  ·  ${incident.duration ?? t('incidents.duration.ongoing')}`}
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

function IncidentGroupRow({ group, t, lang }) {
  const [expanded, setExpanded] = useState(false)
  const dominantStatus = dominantGroupStatus(group)
  const STATUS_CLS = {
    investigating: 'text-[var(--red)]',
    identified:    'text-[var(--red)]',
    monitoring:    'text-[var(--amber)]',
    resolved:      'text-[var(--text2)]',
  }
  const dotCls = STATUS_CLS[dominantStatus] ?? STATUS_CLS.resolved
  const statusLabel = group.uniformStatus
    ? t('incidents.group.statusUniform').replace('{status}', t(`incidents.status.${dominantStatus === 'investigating' || dominantStatus === 'identified' ? 'ongoing' : dominantStatus}`).toLowerCase())
    : Object.entries(group.statusCounts).map(([s, n]) => `${n} ${t(`incidents.status.${s === 'investigating' || s === 'identified' ? 'ongoing' : s}`).toLowerCase()}`).join(' · ')

  return (
    <div>
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        aria-label={expanded ? t('incidents.group.collapse') : t('incidents.group.expand')}
        className="w-full text-left flex items-start gap-[10px] cursor-pointer hover:bg-[var(--bg2)] rounded transition-colors"
        style={{ padding: '8px 4px', margin: '-2px -4px', minHeight: '44px' }}
      >
        <span className={`shrink-0 mt-0.5 text-[10px] mono ${dotCls}`} aria-hidden="true">●</span>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <p className="text-xs text-[var(--text1)] truncate">{group.normalizedTitle}</p>
            <span
              className="shrink-0 mono text-[9px] text-[var(--text2)] bg-[var(--bg2)] rounded"
              style={{ padding: '1px 5px' }}
            >
              {t('incidents.group.flaps').replace('{n}', String(group.count))}
            </span>
            <span className="shrink-0 text-[9px] text-[var(--text2)]">{expanded ? '▾' : '▸'}</span>
          </div>
          <p className="text-[10px] text-[var(--text2)] mono mt-0.5">
            {formatDate(group.rangeStart, lang)} → {formatDate(group.rangeEnd, lang)} · {statusLabel}
          </p>
        </div>
      </button>
      {expanded && (
        <div
          className="flex flex-col bg-[var(--bg2)]"
          style={{
            gap: '6px',
            marginLeft: '12px',
            marginTop: '4px',
            paddingLeft: '12px',
            paddingTop: '8px',
            paddingBottom: '8px',
            paddingRight: '8px',
            borderLeft: '2px solid var(--border-hi)',
            borderRadius: '0 4px 4px 0',
          }}
        >
          {group.entries.map((inc) => (
            <IncidentRow key={inc.id} incident={inc} isRecentlyRecovered={false} t={t} lang={lang} />
          ))}
        </div>
      )}
    </div>
  )
}

// ── Regional Availability ────────────────────────────────
// Renders the per-region status card on service detail pages. Region matching
// + recommendation logic now lives in src/utils/regionStatus.js so the Overview
// ActionBanner and future Worker / Edge surfaces share one source of truth
// (refs #422 Phase 1). This component is presentation-only.

// Label key for each incident type
const INCIDENT_TYPE_LABEL = {
  down: 'svc.region.type.down',
  degraded_perf: 'svc.region.type.degraded',
  inference: 'svc.region.type.inference',
  incident: 'svc.region.incident',
}

const INCIDENT_TYPE_COLOR = {
  down: 'text-[var(--red)]',
  degraded_perf: 'text-[var(--amber)]',
  inference: 'text-[var(--red)]',
  incident: 'text-[var(--red)]',
}

const INCIDENT_DOT_COLOR = {
  down: 'bg-[var(--red)]',
  degraded_perf: 'bg-[var(--amber)]',
  inference: 'bg-[var(--red)]',
  incident: 'bg-[var(--red)]',
}

// #604 — per-component snapshot status colors (operational/degraded/down)
const COMPONENT_DOT_COLOR = {
  operational: 'bg-[var(--green)]',
  degraded: 'bg-[var(--amber)]',
  down: 'bg-[var(--red)]',
}
const COMPONENT_TEXT_COLOR = {
  operational: 'text-[var(--green)]',
  degraded: 'text-[var(--amber)]',
  down: 'text-[var(--red)]',
}

// #606 — worst-of a component set, for a group's header dot.
function worstComponentStatus(members) {
  if (members.some((c) => c.status === 'down')) return 'down'
  if (members.some((c) => c.status === 'degraded')) return 'degraded'
  return 'operational'
}

function ComponentRow({ c, t }) {
  const label = t(`status.${c.status}`)
  // #606 — operational is conveyed by the green dot alone; a visible "Operational" label on
  // every row (18+ for per-model services) is noise. Show the text only for degraded/down,
  // where it should stand out; keep the status on `title` for hover + a11y.
  return (
    <div className="flex items-center gap-2" title={`${c.name} — ${label}`}>
      <span className={`rounded-full shrink-0 ${COMPONENT_DOT_COLOR[c.status] ?? COMPONENT_DOT_COLOR.operational}`} style={{ width: '6px', height: '6px' }} />
      <span className="mono text-xs text-[var(--text1)]">{c.name}</span>
      {c.status !== 'operational'
        ? <span className={`mono text-[10px] ml-auto ${COMPONENT_TEXT_COLOR[c.status]}`}>{label}</span>
        : <span className="sr-only">{label}</span>}
    </div>
  )
}

// #606 — collapsible group (e.g. "Models · 18 components ▸"). The header row IS the toggle
// (chevron in-header, mirroring IncidentGroupRow), so there is no separate bottom button.
// Expanded members render in the same 4-col grid as the surface rows.
function ComponentGroup({ name, members, t }) {
  const [open, setOpen] = useState(false)
  const worst = worstComponentStatus(members)
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="w-full flex items-center gap-2 hover:bg-[var(--bg2)] rounded transition-colors"
        style={{ padding: '6px 8px', margin: '0 -8px', minHeight: '32px' }}
      >
        <span className={`rounded-full shrink-0 ${COMPONENT_DOT_COLOR[worst]}`} style={{ width: '6px', height: '6px' }} />
        <span className="mono text-xs text-[var(--text1)]">{name}</span>
        <span className="mono text-[10px] text-[var(--text2)]">{t('svc.components.groupCount').replace('{n}', String(members.length))}</span>
        {worst !== 'operational' && (
          <span className={`mono text-[10px] ${COMPONENT_TEXT_COLOR[worst]}`}>{t(`status.${worst}`)}</span>
        )}
        <span aria-hidden="true" className="text-[9px] text-[var(--text2)] ml-auto">{open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <div
          className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4"
          style={{ columnGap: '20px', rowGap: '8px', marginTop: '8px', marginLeft: '12px', paddingLeft: '12px', borderLeft: '2px solid var(--border-hi)' }}
        >
          {members.map((c) => <ComponentRow key={c.id} c={c} t={t} />)}
        </div>
      )}
    </div>
  )
}

// #604/#606 — per-component breakdown. Reads service.components (curated subset or the
// dynamic displayAllComponents set). Ungrouped "surface" components render as individual
// rows in a 4-col grid; grouped components (group:'Models') collapse under a group header
// (matching the official status page's Endpoints/Models split).
function ComponentBreakdown({ service, t }) {
  const components = service.components ?? []
  if (components.length === 0) return null
  const surfaces = components.filter((c) => !c.group)
  const groupNames = [...new Set(components.filter((c) => c.group).map((c) => c.group))]
  const anyIssue = components.some((c) => c.status !== 'operational')
  return (
    <section className="bg-[var(--bg1)] border border-[var(--border)] rounded-lg overflow-hidden">
      <div className="border-b border-[var(--border)]" style={{ padding: '12px 16px' }}>
        <div className="mono text-[10px] text-[var(--text1)] uppercase tracking-wider flex items-center gap-1.5">
          <span className="rounded-full shrink-0" style={{ width: '5px', height: '5px', background: anyIssue ? 'var(--amber)' : 'var(--green)' }} />
          {t('svc.components.title')}
          <span className="text-[var(--text2)] font-normal normal-case tracking-normal">— {t('svc.components.sub')}</span>
        </div>
      </div>
      <div className="flex flex-col" style={{ padding: '16px', gap: '10px' }}>
        {/* surfaces: individual rows in a 4-col grid (fills the wide card) */}
        {surfaces.length > 0 && (
          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4" style={{ columnGap: '20px', rowGap: '8px' }}>
            {surfaces.map((c) => <ComponentRow key={c.id} c={c} t={t} />)}
          </div>
        )}
        {/* grouped: one collapsible header per group (Models …) */}
        {groupNames.map((g) => (
          <ComponentGroup key={g} name={g} members={components.filter((c) => c.group === g)} t={t} />
        ))}
      </div>
    </section>
  )
}

function RegionalAvailability({ service, t }) {
  try {
    const state = regionStatusOf(service)
    if (!state) return null

    const { regions, okRegions, allDown, recommendedRegion, docsUrl, ongoingCount } = state
    // recommendText interpolates the FIRST OK region's label — the recommendation
    // policy itself (array-order, same-cloud-first by SERVICE_REGIONS layout)
    // lives in regionStatus.js.
    const recommendText = (t('svc.region.recommend') || '').replace('{region}', recommendedRegion?.label ?? '')

    return (
      <section className="bg-[var(--bg1)] border border-[var(--border)] rounded-lg overflow-hidden">
        <div className="border-b border-[var(--border)]" style={{ padding: '12px 16px' }}>
          <div className="mono text-[10px] text-[var(--text1)] uppercase tracking-wider flex items-center gap-1.5">
            <span className="rounded-full shrink-0" style={{ width: '5px', height: '5px', background: ongoingCount > 0 ? 'var(--amber)' : 'var(--green)' }} />
            {t('svc.region.title')}
          </div>
        </div>
        <div style={{ padding: '16px' }}>
          <div className="flex flex-col" style={{ gap: '8px' }}>
            {regions.map((region) => {
              const isIncident = region.status === 'incident'
              const type = region.type || 'incident'
              const dotCls = isIncident ? (INCIDENT_DOT_COLOR[type] ?? 'bg-[var(--red)]') : 'bg-[var(--green)]'
              const textCls = isIncident ? (INCIDENT_TYPE_COLOR[type] ?? 'text-[var(--red)]') : 'text-[var(--green)]'
              const labelKey = isIncident ? (INCIDENT_TYPE_LABEL[type] ?? 'svc.region.incident') : 'svc.region.noIncidents'
              return (
                <div key={region.key} className="flex items-center gap-2">
                  <span className={`rounded-full shrink-0 ${dotCls}`} style={{ width: '6px', height: '6px' }} />
                  <span className="mono text-xs text-[var(--text1)]">{region.label}</span>
                  <span className={`mono text-[10px] ml-auto ${textCls}`}>{t(labelKey)}</span>
                </div>
              )
            })}
          </div>
          {/* Recommendation callout — three visual adjustments from the
              original `mt-3` / `padding: 6px 8px` / `items-center`:
              1) `marginTop: 20px` (was mt-3=12px): the callout sits on a
                 different background layer (var(--bg2)) than the region list
                 above, but only 12px of separation made the layered surfaces
                 read as a single block — the user perception was the box was
                 "touching" the last region row. 20px gives the callout its
                 own visual section.
              2) `padding: 12px 14px` (was 6px/8px): tighter values cramped
                 the vertical rhythm when the text wrapped to 3 lines on
                 narrow viewports, and made the link look hung from the top
                 edge.
              3) `items-start` (was items-center): aligns the Check API Guide
                 link to the first line of the wrapped text rather than its
                 vertical midpoint — the centered layout placed the link
                 awkwardly low on mobile.
              `gap-2` replaces `ml-2` so the gap survives any future wrap /
              RTL layout change. */}
          {!allDown && okRegions.length > 0 && ongoingCount > 0 && (
            <div className="mono text-[10px] text-[var(--blue)] flex items-start justify-between gap-2" style={{ marginTop: '20px', padding: '12px 14px', background: 'var(--bg2)', borderRadius: '4px' }}>
              <span>{recommendText}</span>
              {docsUrl && (
                <a
                  href={docsUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="font-bold underline hover:text-[var(--text1)] shrink-0"
                  onClick={() => trackEvent('region_switch_intent', { service_id: service.id, recommended_region: recommendedRegion.key, location: 'service_details' })}
                >
                  {t('svc.region.action.guide')} →
                </a>
              )}
            </div>
          )}
          {allDown && (
            <div className="mono text-[10px] text-[var(--red)]" style={{ marginTop: '20px', padding: '12px 14px', background: 'var(--bg2)', borderRadius: '4px' }}>
              {t('svc.region.allDown')}
            </div>
          )}
        </div>
      </section>
    )
  } catch (err) {
    console.error('[RegionalAvailability] render failed:', err)
    return null
  }
}


const CALENDAR_OPACITY = { operational: 0.7, major: 0.8, critical: 0.9 } // minor → default 1 (was degraded_perf)

function CalendarCell({ status, date, t }) {
  const [hovered, setHovered] = useState(false)
  // #662/#663 — show the translated label ("Minor"/"Major"/"Critical"/…), not the raw internal cell
  // key (minor/major/critical). cal.status.* is the calendar's own namespace, decoupled from the
  // 3-state badge `status.*`. Matches the legend (all four keys have ko/en labels).
  const label = t ? t(`cal.status.${status}`) : status
  const bgCls = CALENDAR_CLASS[status] ?? 'bg-[var(--bg3)]'
  const opacity = CALENDAR_OPACITY[status] ?? 1

  // Dismiss tooltip on scroll to prevent stale fixed positioning
  useEffect(() => {
    if (!hovered) return
    const dismiss = () => setHovered(false)
    window.addEventListener('scroll', dismiss, { passive: true, capture: true })
    return () => window.removeEventListener('scroll', dismiss, { capture: true })
  }, [hovered])

  return (
    <div className="relative">
      <div
        className={`${bgCls} cursor-pointer transition-opacity`}
        style={{ width: '18px', height: '18px', borderRadius: '2px', opacity: hovered ? opacity * 0.8 : opacity }}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        aria-label={`${date}: ${label}`}
      />
      {hovered && (
        <div className="fixed z-50 bg-[var(--bg4)] border border-[var(--border)] rounded px-2 py-1
                        text-[10px] mono text-[var(--text1)] whitespace-nowrap pointer-events-none"
             style={{ transform: 'translate(-50%, -100%)', marginTop: '-6px' }}
             ref={(el) => {
               if (el) {
                 const parent = el.previousElementSibling
                 if (parent) {
                   const r = parent.getBoundingClientRect()
                   el.style.left = `${r.left + r.width / 2}px`
                   el.style.top = `${r.top}px`
                 }
               }
             }}>
          {date} — {label}
        </div>
      )}
    </div>
  )
}

function BadgeCode({ serviceId, serviceName, t }) {
  const [copied, setCopied] = useState(false)
  // #805 — link the badge to the crawlable is-down page (not the SPA hash route) so embeds pass
  // backlink authority to the page that ranks for "is {service} down". Logic in src/utils/badge.js.
  const code = buildBadgeMarkdown(serviceId, serviceName)

  const handleCopy = () => {
    const done = () => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    }
    // Mirror RssLink: surface a prompt() fallback instead of a silent .catch()
    // when the clipboard write rejects (insecure context) or is unavailable.
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(code).then(done).catch(() => window.prompt(t('svc.badge.prompt'), code))
    } else {
      window.prompt(t('svc.badge.prompt'), code)
    }
  }

  return (
    <div className="flex items-center gap-2">
      <input
        type="text"
        readOnly
        value={code}
        className="mono flex-1"
        style={{
          fontSize: '10px', padding: '6px 8px',
          background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: '4px',
          color: 'var(--text1)', outline: 'none',
        }}
        onClick={(e) => e.target.select()}
      />
      <button
        onClick={handleCopy}
        className="mono shrink-0"
        style={{
          fontSize: '10px', padding: '5px 10px', borderRadius: '4px', border: 'none',
          background: copied ? 'var(--green)' : 'var(--bg3)',
          color: copied ? 'var(--bg0)' : 'var(--text1)',
          cursor: 'pointer',
        }}
      >
        {copied ? t('svc.badge.copied') : t('svc.badge.copy')}
      </button>
    </div>
  )
}

// Header RSS affordance (#432) — copies the per-service incident feed URL to the
// clipboard. Copy-to-clipboard rather than a plain link: opening a feed URL
// directly makes the browser download raw XML. prompt() fallback covers insecure
// contexts. (A matching subscribe affordance for the /is-*-down pages is tracked
// separately in #430.)
function RssLink({ feedUrl, serviceId, t }) {
  const [copied, setCopied] = useState(false)

  const handleCopy = () => {
    const done = () => {
      setCopied(true)
      trackEvent('copy_rss', { location: 'service_details', service_id: serviceId })
      setTimeout(() => setCopied(false), 2000)
    }
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(feedUrl).then(done).catch(() => window.prompt(t('svc.rss.prompt'), feedUrl))
    } else {
      window.prompt(t('svc.rss.prompt'), feedUrl)
    }
  }

  return (
    <button
      type="button"
      onClick={handleCopy}
      title={t('svc.rss.title')}
      className={`mono text-[10px] flex items-center gap-1 transition-colors ${copied ? 'text-[var(--green)]' : 'text-[var(--text2)] hover:text-[var(--text0)]'}`}
      style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer' }}
    >
      <svg width="11" height="11" viewBox="0 0 24 24" aria-hidden="true"
           style={{ fill: copied ? 'var(--green)' : 'var(--rss)' }}>
        <circle cx="6.18" cy="17.82" r="2.18" />
        <path d="M4 4.44v2.83c7.03 0 12.73 5.7 12.73 12.73h2.83C19.56 11.4 12.6 4.44 4 4.44zm0 5.66v2.83c3.9 0 7.07 3.17 7.07 7.07h2.83c0-5.47-4.43-9.9-9.9-9.9z" />
      </svg>
      {copied ? t('svc.rss.copied') : t('svc.rss')}
    </button>
  )
}

// ── Main Component ───────────────────────────────────────────

// Incident History rows shown before the "show more" toggle (#incident-history-collapse).
// Mirrors the is-down Edge page (api/is-down/html-template.ts) so both surfaces match.
const INCIDENT_HISTORY_PREVIEW = 5
// Security Alerts shown before the "show more" toggle (#785) — same convention as incidents.
const SECURITY_PREVIEW = 5

export default function ServiceDetails({ serviceId }) {
  const { t, lang } = useLang()
  const { setPage } = usePage()
  const { services: rawServices, loading, error, probe24h, latency24h, probeServiceIds, refresh, recentlyRecovered, securityAlerts, reportFeed } = usePolling()
  const services = rawServices ?? []
  const [reportOpen, setReportOpen] = useState(false)

  // useMemo must be called before any early returns (Rules of Hooks)
  // #557 — median (typical recovery, robust to many short component blips) + worst, replacing the
  // old plain mean that let one long outage be diluted away by micro-incidents (computeRecoveryStats).
  const recovery = useMemo(() => {
    const svc = services.find((s) => s.id === serviceId)
    return computeRecoveryStats(svc?.incidents, Date.now(), 7)
  }, [services, serviceId])

  // Incident History preview/expand (#incident-history-collapse): show the first
  // INCIDENT_HISTORY_PREVIEW grouped rows, reveal the rest behind a toggle. Reset when the
  // viewed service changes (the component stays mounted across in-app service navigation).
  const [historyExpanded, setHistoryExpanded] = useState(false)
  useEffect(() => { setHistoryExpanded(false) }, [serviceId])

  // Security Alerts preview/expand (#785): same first-SECURITY_PREVIEW + toggle pattern as the
  // incident history, so a service with many findings doesn't dump them all. Reset on service change.
  const [securityExpanded, setSecurityExpanded] = useState(false)
  useEffect(() => { setSecurityExpanded(false) }, [serviceId])

  if (loading && services.length === 0) return <ServiceDetailsSkeleton />
  if (!loading && services.length === 0 && error) return <EmptyState type="offline" onAction={refresh} />
  if (error)   return <EmptyState type="error" onAction={() => window.location.reload()} />

  const service = services.find((s) => s.id === serviceId)
  if (!service) {
    return (
      <div>
        <EmptyState type="error" onAction={() => setPage({ name: 'overview' })} />
      </div>
    )
  }

  const statusUrl = STATUS_URL[service.id]
  // #717 — one anchor per upstream status source. Multi-source services (e.g. Gemini) use
  // STATUS_SOURCES; everyone else renders the single STATUS_URL with the generic label.
  const statusSources = STATUS_SOURCES[service.id] ?? (statusUrl ? [{ url: statusUrl, labelKey: 'svc.status.link' }] : [])
  // Per-service incident RSS feed (#432) — null for estimate-only services
  // (bedrock / azureopenai) that have no /is-*-down page or feed.
  const feedUrl = feedUrlOf(service.id)
  const cutoff7d = Date.now() - 7 * 86_400_000
  const recentIncidents = (service.incidents ?? []).filter(
    (inc) => inc.status !== 'resolved' || new Date(inc.startedAt).getTime() >= cutoff7d
  )
  // #581 — an unresolved incident has no recovery time yet (computeRecoveryStats counts only
  // resolved ones), so the Recovery card's value is '—'. Distinguish that from "no incidents":
  // when an incident is ongoing, the sub must say so, not falsely claim "No incidents in 7 days"
  // (which contradicts the Incident History showing the active incident right below).
  const hasOngoingIncident = (service.incidents ?? []).some((inc) => inc.status !== 'resolved')
  // groupIncidents re-sorts purely by date; compareGroupedRows lifts ongoing/
  // monitoring rows back above newer resolved ones. See incidentSort.js.
  const groupedIncidents = groupIncidents(recentIncidents).slice().sort(compareGroupedRows)
  const incidentCount = recentIncidents.length
  // Show the first INCIDENT_HISTORY_PREVIEW rows by default; the rest reveal on toggle.
  const visibleIncidents = historyExpanded ? groupedIncidents : groupedIncidents.slice(0, INCIDENT_HISTORY_PREVIEW)
  const hiddenIncidentCount = groupedIncidents.length - visibleIncidents.length
  // #591 — estimate-no-data OR stale-source (frozen feed, e.g. DeepSeek → Flashduty): blank the
  // uptime / incidents / MTTR / score cards + the status calendar (showing a frozen 30-day window as
  // current would mislead). Latency stays — it's probe-measured + current.
  const isUnreliableData = isUnreliableUptime(service)
  // #713 — distinguish "no official uptime source" (honest: "No official uptime — incident-tracked")
  // from the frozen-stale case ("Not provided"). No invented uptime % for these services.
  const noOfficialUptimeFlag = noOfficialUptime(service)
  // #653 — incident displays (count card, MTTR, Incident History) reflect the LIVE incident list and
  // should blank ONLY for a stale/frozen feed — NOT for a missing official uptime. A no-official-uptime
  // service (bedrock/azureopenai) with a live informational incident has no UPTIME % (gated by
  // isUnreliableData) but its incidents are real and must still show (mirrors the status calendar at
  // :961, which already gates on incidentSourceStale only). isUnreliableData stays on the UPTIME display
  // only; the Score card gates on its own validity (#713 — the worker already nulls the score for a
  // no-uptime+no-probe service, while a probed no-uptime service keeps a real, rankable score).
  const incidentsBlanked = !!service.incidentSourceStale
  const calendarDays = service.calendarDays ?? 14

  const calendarData = buildCalendarFromIncidents(service.incidents, service.dailyImpact, calendarDays, service.status)

  return (
    <div className="flex flex-col" style={{ gap: '20px' }}>

      {/* ── Section Title + Back Button ── */}
      <div className="flex items-center justify-between">
        <h2 className="mono text-[10px] text-[var(--text2)] uppercase flex items-center gap-2" style={{ letterSpacing: '0.1em' }}>
          <span className="text-[var(--green)] font-semibold">//</span>
          {t('nav.services')} / {service.name}
        </h2>
        <button
          onClick={() => setPage({ name: 'overview' })}
          className="btn-topbar"
          style={{ fontSize: '11px', padding: '4px 10px' }}
        >
          ← {t('nav.overview')}
        </button>
      </div>

      {/* ── Header Card ── */}
      <div className="bg-[var(--bg1)] border border-[var(--border)] rounded-lg flex justify-between items-start"
           style={{ padding: '18px 20px' }}>
        <div>
          <h1 className="text-xl font-medium text-[var(--text0)]" style={{ marginBottom: '3px' }}>{service.name}</h1>
          <div className="mono text-[11px] text-[var(--text2)]" style={{ marginBottom: '10px' }}>{service.provider}</div>
          <div className="flex items-center" style={{ gap: '14px' }}>
            {statusSources.map(({ url, labelKey }) => (
              <a
                key={url}
                href={url}
                target="_blank"
                rel="noopener noreferrer"
                className="mono text-[10px] text-[var(--blue)] hover:underline flex items-center gap-1"
              >
                ↗ {t(labelKey)}
              </a>
            ))}
            {feedUrl && <RssLink feedUrl={feedUrl} serviceId={service.id} t={t} />}
          </div>
        </div>
        <div className="flex items-center gap-1.5">
          {!!recentlyRecovered[service.id] && <span className="mono text-[9px] rounded" style={{ color: 'var(--blue)', background: 'var(--blue-dim)', padding: '3px 8px' }}>{t('overview.recovered')}</span>}
          {/* #575 — report entry (always available; input never gated). Opens the modal preset to this service. */}
          <button
            type="button"
            onClick={() => setReportOpen(true)}
            className="mono text-[9px] uppercase rounded border border-[var(--border)] text-[var(--text2)] hover:text-[var(--text0)]"
            style={{ padding: '3px 8px', letterSpacing: '0.04em' }}
          >
            ⚠ {t('report.button')}
          </button>
          <StatusPill status={service.status} partialCount={service.partialCount} sourceDead={service.sourceDead && !service.probeConfirmed} />
        </div>
      </div>
      <ReportModal isOpen={reportOpen} onClose={() => setReportOpen(false)} services={services} presetServiceId={service.id} />

      {/* #689 — status source inactive (status page 4xx/deactivated): explains the blanked uptime/
          incidents. Two cases: probeConfirmed (a probed service still reachable via direct probe →
          operational badge, probe-backed) vs no probe (e.g. Character.AI → neutral "Unknown" badge). */}
      {service.sourceDead && (
        <div className="rounded-lg border" style={{ borderColor: 'var(--amber)', background: 'var(--bg2)', padding: '12px 16px' }}>
          <div className="text-[13px] font-medium" style={{ color: 'var(--amber)' }}>⚠ {t('svc.sourceDead.title')}</div>
          <div className="mono text-[11px] text-[var(--text1)]" style={{ marginTop: '5px', lineHeight: 1.5 }}>{t(service.probeConfirmed ? 'svc.sourceDead.bodyProbe' : 'svc.sourceDead.body')}</div>
        </div>
      )}

      {/* ── Metric Cards ── */}
      <div className="grid grid-cols-2 md:grid-cols-4" style={{ gap: '10px' }}>
        <MetricCard
          label={probeServiceIds.includes(service.id) ? t('svc.latency') : t('svc.latency.statusPage')}
          value={service.latency != null ? `${service.latency} ms` : '—'}
          sub={probeServiceIds.includes(service.id)
            ? (service.latency != null ? t('svc.latency.sub') : t('uptime.collecting'))
            : (service.latency != null ? t('svc.latency.statusPage.sub') : t('uptime.unavailable'))}
          colorClass={probeServiceIds.includes(service.id) ? 'text-[var(--blue)]' : 'text-[var(--text2)]'}
        />
        <MetricCard
          label={isUnreliableData
            ? t('svc.uptime30d')
            : t({ official: 'uptime.label.official', platform_avg: 'uptime.label.platform_avg' }[service.uptimeSource] ?? 'svc.uptime30d')}
          value={isUnreliableData
            ? '—'
            : service.uptime30d != null ? `${service.uptime30d.toFixed(2)}%` : '—'}
          sub={isUnreliableData
            ? t(noOfficialUptimeFlag ? 'uptime.noOfficial' : 'uptime.unavailable')
            : t({ official: 'uptime.sub.official', platform_avg: 'uptime.sub.platform_avg' }[service.uptimeSource] ?? 'uptime.unavailable')}
          colorClass="text-[var(--green)]"
        />
        <MetricCard
          label={t('svc.incidents')}
          value={incidentsBlanked ? '—' : incidentCount}
          sub={incidentsBlanked ? t('uptime.unavailable') : t('svc.incidents.sub')}
          colorClass={incidentsBlanked ? 'text-[var(--text2)]' : incidentCount > 0 ? 'text-[var(--amber)]' : 'text-[var(--text1)]'}
        />
        <MetricCard
          label={t('svc.mttr')}
          value={incidentsBlanked ? '—' : (recovery ? formatRecoveryMin(recovery.medianMin) : '—')}
          // #557 — headline is the median (typical) recovery; when a longer outage exists in the
          // window, surface it as "worst Xh Ym" so a 29h outage is never hidden by short blips.
          sub={incidentsBlanked ? t('uptime.unavailable')
            : !recovery ? (hasOngoingIncident ? t('svc.mttr.ongoing') : t('svc.mttr.none'))
            : recovery.maxMin > recovery.medianMin ? t('svc.recovery.worst').replace('{d}', formatRecoveryMin(recovery.maxMin))
            : t('svc.incidents.sub')}
          colorClass={incidentsBlanked ? 'text-[var(--text2)]' : recovery ? 'text-[var(--amber)]' : 'text-[var(--text2)]'}
        />
      </div>

      {/* ── AIWatch Score Breakdown ── */}
      {service.aiwatchScore != null && !incidentsBlanked && (
        <section className="bg-[var(--bg1)] border border-[var(--border)] rounded-lg overflow-hidden">
          <div className="flex items-center justify-between gap-3 border-b border-[var(--border)]" style={{ padding: '12px 16px' }}>
            <div className="mono text-[10px] text-[var(--text1)] uppercase tracking-wider flex items-center flex-wrap gap-1.5 min-w-0">
              <span className="rounded-full shrink-0" style={{ width: '5px', height: '5px', background: 'var(--teal)' }} />
              {t('score.label')}
              <span className="text-[var(--text2)] font-normal">— 30{t('settings.period.suffix')}</span>
              {/* #802 — a recently-added service (<30d coverage) shows its Score here but is held out of
                  the Reliability Ranking until a full window accrues; note that explicitly. */}
              {service.coverageDays != null && service.coverageDays < 30 && (
                <span className="text-[var(--amber)] font-normal normal-case tracking-normal">· {t('score.coverage.insufficient')}</span>
              )}
            </div>
            <span className={`mono text-[18px] font-semibold shrink-0 ${SCORE_TEXT_CLASS[service.scoreGrade] ?? 'text-[var(--text2)]'}`}>
              {service.aiwatchScore}
            </span>
          </div>
          <div style={{ padding: '16px' }}>
            <div className="flex flex-col gap-3">
              {service.scoreBreakdown?.uptime != null ? (
                <div className="flex items-center gap-3">
                  <span className="w-16 shrink-0 mono text-[10px] text-[var(--text2)]">{t('score.uptime')}</span>
                  <div className="flex-1 bg-[var(--bg3)] rounded-full" style={{ height: '6px' }}>
                    <div className="bg-[var(--teal)] rounded-full" style={{ height: '6px', width: `${(service.scoreBreakdown.uptime / 40) * 100}%` }} />
                  </div>
                  <span className="w-10 shrink-0 text-right mono text-[10px] text-[var(--text1)]">{service.scoreBreakdown.uptime}/40</span>
                </div>
              ) : (
                <div className="flex items-center gap-3">
                  <span className="w-16 shrink-0 mono text-[10px] text-[var(--text2)]">{t('score.uptime')}</span>
                  <span className="mono text-[10px] text-[var(--text2)]">{t('uptime.unavailable')}</span>
                </div>
              )}
              {[
                { label: t('score.incidents'), value: service.scoreBreakdown?.incidents, max: 25 },
                { label: t('score.recovery'), value: service.scoreBreakdown?.recovery, max: 15 },
              ].map(({ label, value, max }) => (
                <div key={label} className="flex items-center gap-3">
                  <span className="w-16 shrink-0 mono text-[10px] text-[var(--text2)]">{label}</span>
                  <div className="flex-1 bg-[var(--bg3)] rounded-full" style={{ height: '6px' }}>
                    <div className="bg-[var(--teal)] rounded-full" style={{ height: '6px', width: `${((value ?? 0) / max) * 100}%` }} />
                  </div>
                  <span className="w-10 shrink-0 text-right mono text-[10px] text-[var(--text1)]">{value != null ? value : '—'}/{max}</span>
                </div>
              ))}
              {service.scoreBreakdown?.responsivenessStatus === 'available' && service.scoreBreakdown?.responsiveness != null && (
                <div className="flex items-center gap-3">
                  <span className="w-16 shrink-0 mono text-[10px] text-[var(--text2)]">{t('score.responsiveness')}</span>
                  <div className="flex-1 bg-[var(--bg3)] rounded-full" style={{ height: '6px' }}>
                    <div className="bg-[var(--purple)] rounded-full" style={{ height: '6px', width: `${(service.scoreBreakdown.responsiveness / 20) * 100}%` }} />
                  </div>
                  <span className="w-10 shrink-0 text-right mono text-[10px] text-[var(--text1)]">{service.scoreBreakdown.responsiveness}/20</span>
                </div>
              )}
              {/* 'insufficient' has actionable info ("data accumulating <7d"); 'unavailable' is a transient
                  KV race window of seconds — surfacing it as user-visible text would be alarmist with no recourse,
                  so we collapse it to the 'unsupported' (hidden row) branch. */}
              {service.scoreBreakdown?.responsivenessStatus === 'insufficient' && (
                <div className="flex items-center gap-3">
                  <span className="w-16 shrink-0 mono text-[10px] text-[var(--text2)]">{t('score.responsiveness')}</span>
                  <span className="mono text-[10px] text-[var(--text2)]">{t('score.responsiveness.insufficient')}</span>
                </div>
              )}
            </div>
            {service.scoreConfidence !== 'high' && (
              <div className="mono text-[9px] text-[var(--text2)]" style={{ marginTop: '10px' }}>
                * {t('score.no_uptime')}
              </div>
            )}
            {/* #681 — contextual link to the public methodology page (#673). Same-tab internal nav
                with a "→" affordance — NOT the ↗+new-tab used for the EXTERNAL Official Status link
                above (methodology is our own page, so a new tab would be the wrong convention). */}
            <div style={{ marginTop: '12px' }}>
              <a
                href="/methodology#score"
                onClick={() => trackEvent('click_methodology', { location: 'service_details', source: 'score_breakdown' })}
                className="mono text-[10px] text-[var(--blue)] hover:underline cursor-pointer"
              >
                {t('ranking.aboutScore')} →
              </a>
            </div>
          </div>
        </section>
      )}

      {/* ── 24h Latency Trend — shows chart when hourly KV data exists ── */}
      {service.category === 'api' && probeServiceIds.includes(service.id) && <ServiceLatencyTrend service={service} t={t} hourlyData={probe24h.length > 0 ? filterLast24h(probe24h) : latency24h} />}

      {/* ── Regional Availability (only for services with defined regions) ── */}
      {SERVICE_REGIONS[service.id] && <RegionalAvailability service={service} t={t} />}

      {/* ── Per-component breakdown (#604) — grouped with the Region card (same
          per-dimension status pattern) in the drill-down zone, right before the
          incident history block ── */}
      <ComponentBreakdown service={service} t={t} />

      {/* ── Bottom: Incident History + Calendar (2-col on desktop) ── */}
      <div className="grid grid-cols-1 lg:grid-cols-2" style={{ gap: '10px' }}>

        {/* Incident History */}
        <section className="bg-[var(--bg1)] border border-[var(--border)] rounded-lg overflow-hidden">
          <div className="flex items-center justify-between border-b border-[var(--border)]" style={{ padding: '12px 16px' }}>
            <div className="mono text-[10px] text-[var(--text1)] uppercase tracking-wider flex items-center gap-1.5">
              <span className="rounded-full shrink-0" style={{ width: '5px', height: '5px', background: 'var(--red)' }} />
              {t('svc.incidents.history')}
            </div>
            <span className="mono text-[10px] text-[var(--text2)]">{t('incidents.period.7d')}</span>
          </div>
          <div style={{ padding: '16px' }}>
            {incidentsBlanked || NO_INCIDENT_SUPPORT.has(service.id) ? (
              <div className="flex items-center gap-2 py-4">
                <span className="text-[var(--text2)] text-sm" aria-hidden="true">—</span>
                <span className="text-xs text-[var(--text2)]">{t('uptime.unavailable')}</span>
              </div>
            ) : incidentCount === 0 ? (
              <div className="flex items-center gap-2 py-4">
                <span className="text-[var(--green)] text-sm" aria-hidden="true">✓</span>
                <span className="text-xs text-[var(--text2)]">{t('svc.no.incidents')}</span>
              </div>
            ) : (
              <div className="flex flex-col" style={{ gap: '8px' }}>
                {visibleIncidents.map((row) => row.kind === 'group' ? (
                  <IncidentGroupRow key={`group:${row.dayKey}:${row.normalizedTitle}`} group={row} t={t} lang={lang} />
                ) : (
                  <IncidentRow key={row.incident.id} incident={row.incident} isRecentlyRecovered={!!(recentlyRecovered[service.id] ?? []).includes(row.incident.id)} t={t} lang={lang} />
                ))}
                {(hiddenIncidentCount > 0 || historyExpanded) && groupedIncidents.length > INCIDENT_HISTORY_PREVIEW && (
                  <button
                    type="button"
                    onClick={() => setHistoryExpanded((v) => !v)}
                    aria-expanded={historyExpanded}
                    className="mono text-[10px] text-[var(--text2)] hover:text-[var(--text1)] uppercase tracking-wider flex items-center gap-1.5 self-start"
                    style={{ padding: '6px 2px' }}
                  >
                    <span aria-hidden="true">{historyExpanded ? '▴' : '▾'}</span>
                    {historyExpanded
                      ? t('svc.incidents.showLess')
                      : t('svc.incidents.showMore').replace('{n}', String(hiddenIncidentCount))}
                  </button>
                )}
              </div>
            )}
          </div>
        </section>

        {/* Status Calendar — hidden when calendarDays is 0 (no reliable data) or the source is STALE
            (#591 — a frozen incident feed paints a 30-day all-green calendar, contradicting the
            blanked cards above). Estimate-only services keep the calendar (existing behaviour — their
            window isn't frozen, just lacks a published uptime %). */}
        {calendarDays > 0 && !service.incidentSourceStale && <section className="bg-[var(--bg1)] border border-[var(--border)] rounded-lg overflow-hidden">
          <div className="flex items-center justify-between border-b border-[var(--border)]" style={{ padding: '12px 16px' }}>
            <div className="mono text-[10px] text-[var(--text1)] uppercase tracking-wider flex items-center gap-1.5">
              <span className="rounded-full shrink-0" style={{ width: '5px', height: '5px', background: 'var(--green)' }} />
              {t('svc.cal.legend')}
            </div>
            <div className="flex gap-3">
              {['operational', 'minor', 'major', 'critical'].map((s) => (
                <div key={s} className="flex items-center gap-1">
                  <span className={`rounded-sm ${CALENDAR_CLASS[s]}`} style={{ width: '8px', height: '8px' }} />
                  <span className="text-[9px] mono text-[var(--text2)]">{t(`cal.status.${s}`)}</span>
                </div>
              ))}
            </div>
          </div>
          <div style={{ padding: '16px' }}>
            <div className="flex flex-wrap" style={{ gap: '2px' }}>
              {calendarData.map((status, i) => (
                <CalendarCell key={i} status={status} date={calendarDate(i, lang, calendarDays)} t={t} />
              ))}
            </div>
            <div className="flex justify-between mono text-[9px] text-[var(--text2)]" style={{ marginTop: '6px' }}>
              <span>{calendarDays}{t('settings.period.suffix')} {t('svc.cal.ago.suffix')}</span>
              <span>{t('svc.cal.today')}</span>
            </div>
          </div>
        </section>}

      {/* ── #575 — gated "Recent user reports" for this service. reportFeed only carries this
            service when the worker confirmed an independent signal corroborates (so it never
            contradicts an operational badge). Absent otherwise → section not rendered. ── */}
      {(reportFeed?.[service.id]?.length ?? 0) > 0 && (
        <section className="bg-[var(--bg1)] border border-[var(--border)] rounded-lg overflow-hidden">
          <div className="flex items-center justify-between border-b border-[var(--border)]" style={{ padding: '12px 16px' }}>
            <div className="mono text-[10px] text-[var(--text1)] uppercase tracking-wider flex items-center gap-1.5">
              <span className="rounded-full shrink-0" style={{ width: '5px', height: '5px', background: 'var(--purple)' }} />
              {t('report.feed.title')}
            </div>
            <span className="mono text-[10px] text-[var(--text2)]">{t('report.feed.sub')}</span>
          </div>
          <div style={{ padding: '16px' }}>
            <RecentUserReports items={(reportFeed[service.id] ?? []).map((e) => ({ cat: e.cat, desc: e.desc, ts: e.ts }))} />
          </div>
        </section>
      )}

      {/* ── Security Alerts (service-specific) ── */}
      {(() => {
        if (!securityAlerts?.length) return null
        const nameLC = service.name.toLowerCase()
        const providerLC = service.provider?.toLowerCase() ?? ''
        // Map OSV service field → specific AIWatch service ID (SDK alerts are API-specific)
        // Keep in sync with OSV_PACKAGES in worker/src/security-monitor.ts
        const OSV_SERVICE_MAP = {
          'OpenAI': 'openai', 'Anthropic (Claude)': 'claude', 'Google (Gemini)': 'gemini',
          'Cohere': 'cohere', 'Mistral': 'mistral', 'Hugging Face': 'huggingface',
          'Together': 'together', 'Groq': 'groq', 'Replicate': 'replicate',
          'AssemblyAI': 'assemblyai', 'Deepgram': 'deepgram',
          'LangChain': 'langsmith', // #561 — langchain ecosystem CVEs now have a detail-page home
        }
        const filtered = securityAlerts.filter(a => {
          // OSV: match by mapped service ID (e.g., "Anthropic (Claude)" → only "claude", not "claudeai")
          if (a.service) return OSV_SERVICE_MAP[a.service] === service.id
          // HN (#785): match by service NAME or PROVIDER in the title — consistent with the Overview
          // banner's tag derivation (Overview.jsx). Provider-scoped on purpose: an HN news item naming
          // only the provider (e.g. "OpenAI agent actions" → ChatGPT/Codex/OpenAI all share provider
          // "OpenAI") was tagged in the banner but had no detail-page home under name-only matching.
          const titleLC = a.title?.toLowerCase() ?? ''
          return titleLC.includes(nameLC) || (providerLC && titleLC.includes(providerLC))
        })
        if (filtered.length === 0) return null
        // #785 — first SECURITY_PREVIEW, rest behind a toggle (same as incident history).
        const visibleAlerts = securityExpanded ? filtered : filtered.slice(0, SECURITY_PREVIEW)
        const hiddenAlertCount = filtered.length - visibleAlerts.length
        return (
          <section className="bg-[var(--bg1)] border border-[var(--border)] rounded-lg overflow-hidden">
            <div className="border-b border-[var(--border)]" style={{ padding: '12px 16px' }}>
              <div className="mono text-[10px] text-[var(--text1)] uppercase tracking-wider flex items-center gap-1.5">
                <span className="rounded-full shrink-0" style={{ width: '5px', height: '5px', background: 'var(--purple)' }} />
                {t('svc.security')}
              </div>
            </div>
            <div style={{ padding: '16px' }} className="flex flex-col gap-2">
              {/* #326: EPSS-based prefix. Operators triage "🔥 actively exploited"
                 before anything else; ≥EPSS_ELEVATED is "elevated, prioritize this week".
                 Below EPSS_ELEVATED we skip the prefix to avoid crowding low-signal advisories.
                 Thresholds must stay in sync with EPSS_ACTIVE / EPSS_ELEVATED in
                 worker/src/security-monitor.ts. */}
              {visibleAlerts.map((a, i) => {
                const safeUrl = a.url?.startsWith('https://') ? a.url : '#'
                const epss = a.epssPercentile
                let epssPrefix = null
                if (typeof epss === 'number') {
                  if (epss >= 0.8) epssPrefix = { tag: '🔥', color: 'var(--red)' }
                  else if (epss >= 0.5) epssPrefix = { tag: '⚠️', color: 'var(--amber)' }
                }
                return (
                  <a key={i} href={safeUrl} target="_blank" rel="noopener noreferrer"
                    className="flex items-start gap-2 text-[12px] text-[var(--text1)] hover:text-[var(--purple)]"
                  >
                    <span className="shrink-0">{a.severity === 'critical' ? '🔴' : a.severity === 'high' ? '🟠' : '🟡'}</span>
                    {epssPrefix && (
                      <span className="shrink-0 mono text-[10px]" style={{ color: epssPrefix.color }}
                        title={`EPSS ${Math.round(epss * 100)}th percentile — ${epss >= 0.8 ? 'actively exploited' : 'elevated exploit risk'}`}
                      >{epssPrefix.tag}</span>
                    )}
                    <span className="truncate">{a.title}</span>
                  </a>
                )
              })}
              {(hiddenAlertCount > 0 || securityExpanded) && filtered.length > SECURITY_PREVIEW && (
                <button
                  type="button"
                  onClick={() => setSecurityExpanded((v) => !v)}
                  aria-expanded={securityExpanded}
                  className="mono text-[10px] text-[var(--text2)] hover:text-[var(--text1)] uppercase tracking-wider flex items-center gap-1.5 self-start"
                  style={{ padding: '6px 2px' }}
                >
                  <span aria-hidden="true">{securityExpanded ? '▴' : '▾'}</span>
                  {securityExpanded
                    ? t('svc.incidents.showLess')
                    : t('svc.incidents.showMore').replace('{n}', String(hiddenAlertCount))}
                </button>
              )}
            </div>
          </section>
        )
      })()}

      {/* ── Badge Embed ── */}
      <section className="bg-[var(--bg1)] border border-[var(--border)] rounded-lg overflow-hidden">
        <div className="border-b border-[var(--border)]" style={{ padding: '12px 16px' }}>
          <div className="mono text-[10px] text-[var(--text1)] uppercase tracking-wider flex items-center gap-1.5">
            <span className="rounded-full shrink-0" style={{ width: '5px', height: '5px', background: 'var(--teal)' }} />
            {t('svc.badge')}
          </div>
        </div>
        <div style={{ padding: '16px' }}>
          <div className="flex items-center gap-3" style={{ marginBottom: '12px' }}>
            <img src={`${(import.meta.env.VITE_API_URL || 'http://localhost:8788').replace('/api/status', '')}/badge/${service.id}`} alt={`${service.name} status`} height="20" />
            {service.uptime30d != null && !isUnreliableData && <img src={`${(import.meta.env.VITE_API_URL || 'http://localhost:8788').replace('/api/status', '')}/badge/${service.id}?uptime=true`} alt={`${service.name} uptime`} height="20" />}
          </div>
          <BadgeCode serviceId={service.id} serviceName={service.name} t={t} />
        </div>
      </section>

      </div>

    </div>
  )
}
