// Service Details — per-service monitoring page
// Receives serviceId prop from App.jsx (page.serviceId).
// Shows header, 4 metric cards, 24h latency chart, incident history, 30-day status calendar.
// Chart.js registration is idempotent — safe to call even if Latency.jsx registered first.

import { useMemo, useState } from 'react'
import {
  Chart as ChartJS,
  CategoryScale, LinearScale, PointElement, LineElement,
  Tooltip, Legend, Filler,
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

ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, Tooltip, Legend, Filler)

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
  gemini:      'https://status.cloud.google.com/',
  mistral:     'https://status.mistral.ai',
  cohere:      'https://status.cohere.ai',
  groq:        'https://status.groq.com',
  together:    'https://status.together.ai',
  perplexity:  'https://status.perplexity.ai',
  huggingface: 'https://status.huggingface.co',
  replicate:   'https://www.replicatestatus.com',
  elevenlabs:  'https://status.elevenlabs.io',
  xai:         'https://status.x.ai',
  deepseek:    'https://status.deepseek.com',
  claudeai:    'https://status.anthropic.com',
  chatgpt:     'https://status.openai.com',
  claudecode:  'https://status.anthropic.com',
  copilot:     'https://githubstatus.com',
  cursor:      'https://status.cursor.com',
  windsurf:    'https://status.codeium.com',
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
// 24 hour labels ending at current hour (matching Latency.jsx)
function hourLabels() {
  const currentHour = new Date().getHours()
  return Array.from({ length: 24 }, (_, i) => {
    const hour = (currentHour - 23 + i + 24) % 24
    return `${String(hour).padStart(2, '0')}:00`
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

// theme is used as key to force Chart.js re-mount on theme switch so cssVar() is re-read
function LatencyChart({ service, theme, t }) {
  const dataset = useMemo(
    () => ({
      label: service.name,
      data: gen24h(service.latency ?? 200),
      borderColor: service.status === 'degraded' ? cssVar('--amber')
        : service.status === 'down' ? cssVar('--red')
        : cssVar('--green'),
      backgroundColor: service.status === 'degraded' ? cssVar('--amber') + '20'
        : service.status === 'down' ? cssVar('--red') + '20'
        : cssVar('--green') + '20',
      fill: true,
      borderWidth: 1.5,
      pointRadius: 0,
      tension: 0.4,
    }),
    [service, theme]
  )

  const options = useMemo(
    () => ({
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      scales: {
        x: {
          grid:  { color: cssVar('--border') },
          ticks: {
            color: cssVar('--text2'),
            font: { family: 'IBM Plex Mono', size: 10 },
            callback: function(val, index, ticks) {
              const fromEnd = ticks.length - 1 - index
              if (fromEnd % 3 === 0) return this.getLabelForValue(val)
              return null
            },
          },
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
    <div className="bg-[var(--bg1)] border border-[var(--border)] rounded-lg overflow-hidden">
      <div className="flex items-center justify-between border-b border-[var(--border)]" style={{ padding: '12px 16px' }}>
        <div className="mono text-[10px] text-[var(--text1)] uppercase tracking-wider flex items-center gap-1.5">
          <span className="rounded-full shrink-0" style={{ width: '5px', height: '5px', background: 'var(--blue)' }} />
          {t('latency.trend')}
        </div>
        <span className="mono text-[9px] text-[var(--text2)]">{t('latency.dummy')}</span>
      </div>
      <div style={{ padding: '16px' }}>
        <div className="h-[200px]">
          <Line key={theme} data={{ labels, datasets: [dataset] }} options={options} />
        </div>
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

const CALENDAR_OPACITY = { operational: 0.7, degraded: 0.8, down: 0.9 }

function CalendarCell({ status, date }) {
  const [hovered, setHovered] = useState(false)
  const bgCls = CALENDAR_CLASS[status] ?? 'bg-[var(--bg3)]'
  const opacity = CALENDAR_OPACITY[status] ?? 1
  return (
    <div className="relative">
      <div
        className={`${bgCls} cursor-pointer transition-opacity`}
        style={{ width: '18px', height: '18px', borderRadius: '2px', opacity: hovered ? opacity * 0.8 : opacity }}
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

  if (loading) return <SkeletonUI />
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
  const incidentCount = service.incidents?.length ?? 0

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
          {statusUrl && (
            <a
              href={statusUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="mono text-[10px] text-[var(--blue)] hover:underline flex items-center gap-1"
            >
              ↗ {t('svc.status.link')}
            </a>
          )}
        </div>
        <StatusPill status={service.status} />
      </div>

      {/* ── Metric Cards ── */}
      <div className="grid grid-cols-2 md:grid-cols-4" style={{ gap: '10px' }}>
        <MetricCard
          label={t('svc.latency')}
          value={service.latency != null ? `${service.latency} ms` : '—'}
          sub={t('svc.latency.sub')}
          colorClass="text-[var(--blue)]"
        />
        <MetricCard
          label={t('svc.uptime30d')}
          value={`${(service.uptime30d ?? 0).toFixed(2)}%`}
          sub={t('svc.uptime.sub')}
          colorClass="text-[var(--green)]"
        />
        <MetricCard
          label={t('svc.incidents')}
          value={incidentCount}
          sub={t('svc.incidents.sub')}
          colorClass={incidentCount > 0 ? 'text-[var(--amber)]' : 'text-[var(--text1)]'}
        />
        <MetricCard
          label={t('svc.mttr')}
          value="—"
          sub={t('svc.mttr.sub')}
          colorClass="text-[var(--text2)]"
        />
      </div>

      {/* ── 24h Latency Chart ── */}
      <LatencyChart service={service} theme={theme} t={t} />

      {/* ── Bottom: Incident History + Calendar (2-col on desktop) ── */}
      <div className="grid grid-cols-1 lg:grid-cols-2" style={{ gap: '10px' }}>

        {/* Incident History */}
        <section className="bg-[var(--bg1)] border border-[var(--border)] rounded-lg overflow-hidden">
          <div className="flex items-center border-b border-[var(--border)]" style={{ padding: '12px 16px' }}>
            <div className="mono text-[10px] text-[var(--text1)] uppercase tracking-wider flex items-center gap-1.5">
              <span className="rounded-full shrink-0" style={{ width: '5px', height: '5px', background: 'var(--red)' }} />
              {t('svc.incidents.history')}
            </div>
          </div>
          <div style={{ padding: '16px' }}>
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
          </div>
        </section>

        {/* 30-Day Status Calendar */}
        <section className="bg-[var(--bg1)] border border-[var(--border)] rounded-lg overflow-hidden">
          <div className="flex items-center justify-between border-b border-[var(--border)]" style={{ padding: '12px 16px' }}>
            <div className="mono text-[10px] text-[var(--text1)] uppercase tracking-wider flex items-center gap-1.5">
              <span className="rounded-full shrink-0" style={{ width: '5px', height: '5px', background: 'var(--green)' }} />
              {t('svc.cal.legend')}
            </div>
            <div className="flex gap-3">
              {['operational', 'degraded', 'down'].map((s) => (
                <div key={s} className="flex items-center gap-1">
                  <span className={`rounded-sm ${CALENDAR_CLASS[s]}`} style={{ width: '8px', height: '8px' }} />
                  <span className="text-[9px] mono text-[var(--text2)]">{t(`status.${s}`)}</span>
                </div>
              ))}
            </div>
          </div>
          <div style={{ padding: '16px' }}>
            <div className="flex" style={{ gap: '2px' }}>
              {(service.history30d ?? []).map((status, i) => (
                <CalendarCell key={i} status={status} date={calendarDate(i, lang)} />
              ))}
            </div>
            <div className="flex justify-between mono text-[9px] text-[var(--text2)]" style={{ marginTop: '6px' }}>
              <span>{t('svc.cal.ago')}</span>
              <span>{t('svc.cal.today')}</span>
            </div>
          </div>
        </section>

      </div>

    </div>
  )
}
