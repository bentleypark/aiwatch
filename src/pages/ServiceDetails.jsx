// Service Details — per-service monitoring page
// Receives serviceId prop from App.jsx (page.serviceId).
// Shows header, 4 metric cards, 24h latency chart, incident history, 30-day status calendar.
// Chart.js registration is idempotent — safe to call even if Latency.jsx registered first.

import { useMemo, useState } from 'react'
import {
  Chart as ChartJS,
  CategoryScale, LinearScale, PointElement, LineElement,
  Tooltip, Legend,
} from 'chart.js'
import { Line } from 'react-chartjs-2'
import { useLang } from '../hooks/useLang'
import { useTheme } from '../hooks/useTheme'
import { usePage } from '../utils/pageContext'
import { usePolling } from '../hooks/usePolling'
import { formatDate } from '../utils/time'
import SkeletonUI from '../components/SkeletonUI'
import EmptyState from '../components/EmptyState'
import StatusPill from '../components/StatusPill'

ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, Tooltip, Legend)

// ── Constants ────────────────────────────────────────────────

// Read a CSS custom property value from :root at render time (not module eval).
// Only call inside useMemo blocks that are gated on theme to avoid stale values.
const cssVar = (name) =>
  getComputedStyle(document.documentElement).getPropertyValue(name).trim()

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
  elevenlabs:  '#6be5e2',
  xai:         '#e0e0e0',
  deepseek:    '#ff6b6b',
}

// Official status page URLs for each monitored service
const STATUS_URL = {
  claude:      'https://status.anthropic.com',
  openai:      'https://status.openai.com',
  gemini:      'https://cloud.google.com/support/docs/dashboard',
  mistral:     'https://status.mistral.ai',
  cohere:      'https://status.cohere.ai',
  groq:        'https://status.groq.com',
  together:    'https://status.together.ai',
  perplexity:  'https://status.perplexity.ai',
  huggingface: 'https://status.huggingface.co',
  replicate:   'https://replicate-status.com',
  elevenlabs:  'https://status.elevenlabs.io',
  xai:         'https://status.x.ai',
  deepseek:    'https://status.deepseek.com',
}

// 30-day calendar status → Tailwind color class
const CALENDAR_CLASS = {
  operational: 'bg-[var(--green)]',
  degraded:    'bg-[var(--amber)]',
  down:        'bg-[var(--red)]',
}

// Generates 24 synthetic hourly data points — mirrors gen24h in Latency.jsx.
// Replace with real time-series data in Issue #15.
function gen24h(baseLatency) {
  return Array.from({ length: 24 }, (_, i) => {
    const variation = (Math.sin(i * 0.7) * 0.15 + Math.cos(i * 1.3) * 0.10) * baseLatency
    return Math.max(10, Math.round(baseLatency + variation))
  })
}

// Generate last-24-hours labels (HH:00) relative to current time
function hourLabels() {
  const now = new Date()
  return Array.from({ length: 24 }, (_, i) => {
    const h = new Date(now - (23 - i) * 3_600_000)
    return `${String(h.getHours()).padStart(2, '0')}:00`
  })
}

// Compute calendar date label for history30d index i (0 = 29 days ago, 29 = today)
function calendarDate(i, lang) {
  const d = new Date(Date.now() - (29 - i) * 86_400_000)
  return new Intl.DateTimeFormat(lang === 'ko' ? 'ko-KR' : 'en-US', {
    month: 'short',
    day: 'numeric',
  }).format(d)
}

// ── Sub-components ───────────────────────────────────────────

function MetricCard({ label, value, sub, colorClass }) {
  return (
    <div className="bg-[var(--bg1)] border border-[var(--border)] rounded-lg p-4 flex flex-col gap-1">
      <span className="text-xs text-[var(--text2)] uppercase tracking-wider">{label}</span>
      <span className={`text-2xl mono font-semibold ${colorClass}`}>{value}</span>
      {sub && <span className="text-xs text-[var(--text2)]">{sub}</span>}
    </div>
  )
}

// theme is used as key to force Chart.js re-mount on theme switch so cssVar() is re-read
function LatencyChart({ service, theme, t }) {
  const dataset = useMemo(
    () => ({
      label: service.name,
      data: gen24h(service.latency),
      borderColor: SERVICE_COLOR[service.id] ?? '#8b949e',
      backgroundColor: 'transparent',
      borderWidth: 1.5,
      pointRadius: 0,
      tension: 0.4,
    }),
    [service]
  )

  const options = useMemo(
    () => ({
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      scales: {
        x: {
          grid:  { color: cssVar('--border') },
          ticks: { color: cssVar('--text2'), font: { family: 'IBM Plex Mono', size: 10 }, maxTicksLimit: 8 },
        },
        y: {
          grid:  { color: cssVar('--border') },
          ticks: {
            color: cssVar('--text2'),
            font: { family: 'IBM Plex Mono', size: 10 },
            callback: (v) => `${v}ms`,
          },
        },
      },
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: (ctx) => `${ctx.parsed.y} ms` } },
      },
    }),
    [theme] // re-read CSS vars when theme switches
  )

  // Keyed on service so labels re-sync when polling brings a new data snapshot
  const labels = useMemo(hourLabels, [service])

  return (
    <div className="bg-[var(--bg1)] border border-[var(--border)] rounded-lg p-4">
      <h2 className="text-xs mono text-[var(--text2)] uppercase tracking-wider mb-1">
        {t('latency.trend')}
      </h2>
      <p className="text-[10px] text-[var(--amber)] mono mb-4">{t('latency.dummy')}</p>
      <div className="h-[200px]">
        <Line key={theme} data={{ labels, datasets: [dataset] }} options={options} />
      </div>
    </div>
  )
}

function IncidentRow({ incident, t, lang }) {
  const STATUS_CLS = {
    ongoing:    'text-[var(--red)]',
    monitoring: 'text-[var(--amber)]',
    resolved:   'text-[var(--text2)]',
  }
  const dotCls = STATUS_CLS[incident.status] ?? STATUS_CLS.resolved
  return (
    <div className="flex items-start gap-3 py-2 border-b border-[var(--border)] last:border-0">
      <span className={`shrink-0 mt-0.5 text-[10px] mono ${dotCls}`} aria-hidden="true">●</span>
      <div className="flex-1 min-w-0">
        <p className="text-xs text-[var(--text1)] truncate">{incident.title}</p>
        <p className="text-[10px] text-[var(--text2)] mono mt-0.5">
          {formatDate(incident.startedAt, lang)}
          {incident.duration ? ` · ${incident.duration}` : ''}
        </p>
      </div>
      <span className={`shrink-0 text-[10px] mono ${dotCls}`}>
        {t(`incidents.status.${incident.status}`)}
      </span>
    </div>
  )
}

function CalendarCell({ status, date }) {
  const [hovered, setHovered] = useState(false)
  const bgCls = CALENDAR_CLASS[status] ?? 'bg-[var(--bg3)]'
  return (
    <div className="relative">
      <div
        className={`w-4 h-4 rounded-sm ${bgCls} cursor-default`}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        aria-label={`${date}: ${status}`}
      />
      {hovered && (
        <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-1.5 z-10
                        bg-[var(--bg4)] border border-[var(--border)] rounded px-2 py-1
                        text-[10px] mono text-[var(--text1)] whitespace-nowrap pointer-events-none">
          {date} — {status}
        </div>
      )}
    </div>
  )
}

// ── Main Component ───────────────────────────────────────────

export default function ServiceDetails({ serviceId }) {
  const { t, lang } = useLang()
  const { theme } = useTheme()
  const { setPage } = usePage()
  const { services: rawServices, loading, error } = usePolling()
  const services = rawServices ?? []

  if (loading) return <div className="p-4 md:p-6"><SkeletonUI /></div>
  if (error)   return <div className="p-4 md:p-6"><EmptyState type="error" onAction={() => window.location.reload()} /></div>

  const service = services.find((s) => s.id === serviceId)
  if (!service) {
    return (
      <div className="p-4 md:p-6">
        <EmptyState type="error" onAction={() => setPage({ name: 'overview' })} />
      </div>
    )
  }

  const statusUrl = STATUS_URL[service.id]
  const incidentCount = service.incidents?.length ?? 0

  return (
    <div className="p-4 md:p-6 space-y-6">

      {/* ── Header ── */}
      <div className="flex flex-col gap-3">
        <button
          onClick={() => setPage({ name: 'overview' })}
          className="self-start text-xs mono text-[var(--text2)] hover:text-[var(--text1)] transition-colors"
        >
          ← {t('nav.overview')}
        </button>
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-3">
            <h1 className="text-lg font-semibold text-[var(--text0)]">{service.name}</h1>
            <StatusPill status={service.status} />
          </div>
          {statusUrl && (
            <a
              href={statusUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs mono text-[var(--blue)] hover:underline"
            >
              {t('svc.status.link')} ↗
            </a>
          )}
        </div>
      </div>

      {/* ── Metric Cards ── */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <MetricCard
          label={t('svc.latency')}
          value={`${service.latency} ms`}
          colorClass="text-[var(--blue)]"
        />
        <MetricCard
          label={t('svc.uptime30d')}
          value={`${(service.uptime30d ?? 0).toFixed(2)}%`}
          colorClass="text-[var(--green)]"
        />
        <MetricCard
          label={t('svc.incidents')}
          value={incidentCount}
          colorClass={incidentCount > 0 ? 'text-[var(--amber)]' : 'text-[var(--text1)]'}
        />
        <MetricCard
          label={t('svc.mttr')}
          value={t('svc.mttr.collecting')}
          colorClass="text-[var(--text2)]"
        />
      </div>

      {/* ── 24h Latency Chart ── */}
      <LatencyChart service={service} theme={theme} t={t} />

      {/* ── Incident History ── */}
      <section className="bg-[var(--bg1)] border border-[var(--border)] rounded-lg p-4">
        <h2 className="text-xs mono text-[var(--text2)] uppercase tracking-wider mb-3">
          {t('svc.incidents')}
        </h2>
        {incidentCount === 0 ? (
          <div className="flex items-center gap-2 py-4">
            <span className="text-[var(--green)] text-sm" aria-hidden="true">✓</span>
            <span className="text-xs text-[var(--text2)]">{t('svc.no.incidents')}</span>
          </div>
        ) : (
          <div>
            {(service.incidents ?? []).map((inc) => (
              <IncidentRow key={inc.id} incident={inc} t={t} lang={lang} />
            ))}
          </div>
        )}
      </section>

      {/* ── 30-Day Status Calendar ── */}
      <section className="bg-[var(--bg1)] border border-[var(--border)] rounded-lg p-4">
        <h2 className="text-xs mono text-[var(--text2)] uppercase tracking-wider mb-4">
          {t('svc.cal.legend')}
        </h2>
        <div className="flex flex-wrap gap-1.5">
          {(service.history30d ?? []).map((status, i) => (
            <CalendarCell
              key={i}
              status={status}
              date={calendarDate(i, lang)}
            />
          ))}
        </div>
        {/* Legend */}
        <div className="flex gap-4 mt-3">
          {['operational', 'degraded', 'down'].map((s) => (
            <div key={s} className="flex items-center gap-1.5">
              <div className={`w-3 h-3 rounded-sm ${CALENDAR_CLASS[s]}`} aria-hidden="true" />
              <span className="text-[10px] mono text-[var(--text2)]">{t(`status.${s}`)}</span>
            </div>
          ))}
        </div>
      </section>

    </div>
  )
}
