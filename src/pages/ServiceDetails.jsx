// Service Details — per-service monitoring page
// Receives serviceId prop from App.jsx (page.serviceId).
// Shows header, 4 metric cards, incident history, 30-day status calendar.

import { useEffect, useMemo, useRef, useState } from 'react'
import { useLang } from '../hooks/useLang'
import { usePage } from '../utils/pageContext'
import { usePolling } from '../hooks/usePolling'
import { formatDate } from '../utils/time'
import { buildCalendarFromIncidents } from '../utils/calendar'
import { Chart, LineController, LineElement, PointElement, LinearScale, CategoryScale, Filler, Tooltip } from 'chart.js'
import { SCORE_TEXT_CLASS } from '../utils/constants'
import { ServiceDetailsSkeleton } from '../components/SkeletonUI'
import EmptyState from '../components/EmptyState'
import StatusPill from '../components/StatusPill'

Chart.register(LineController, LineElement, PointElement, LinearScale, CategoryScale, Filler, Tooltip)

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
  elevenlabs:  '#6be5e2',
  xai:         '#e0e0e0',
  deepseek:    '#ff6b6b',
}

// Official status page URLs for each monitored service
const STATUS_URL = {
  claude:      'https://status.claude.com',
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
  openrouter:  'https://status.openrouter.ai',
  claudeai:    'https://status.claude.com',
  chatgpt:     'https://status.openai.com',
  claudecode:  'https://status.claude.com',
  copilot:     'https://githubstatus.com',
  cursor:      'https://status.cursor.com',
  windsurf:    'https://status.windsurf.com',
}

// Services that cannot provide incident data (no API, bot-protected, etc.)
const NO_INCIDENT_SUPPORT = new Set([])

// 30-day calendar status → Tailwind color class
const CALENDAR_CLASS = {
  operational:    'bg-[var(--green)]',
  degraded_perf:  'bg-[var(--yellow)]',
  degraded:       'bg-[var(--amber)]',
  down:           'bg-[var(--red)]',
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
    if (chartRef.current) chartRef.current.destroy()

    const labels = hourlyData.map((s) => {
      const d = new Date(s.t)
      return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
    })
    const values = hourlyData.map((s) => s.data[service.id] ?? null)
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

    return () => { if (chartRef.current) { chartRef.current.destroy(); chartRef.current = null } }
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

function IncidentRow({ incident, detectedAt, t, lang }) {
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

  // Detection Lead: per-incident calculation
  const lead = (() => {
    if (!detectedAt || incident.status === 'resolved') return null
    const detected = new Date(detectedAt).getTime()
    const started = new Date(incident.startedAt).getTime()
    const diffMs = started - detected
    if (diffMs <= 0) return null
    const mins = Math.round(diffMs / 60_000)
    if (mins < 1) return null
    const label = mins >= 60 ? `${Math.floor(mins / 60)}h ${mins % 60}m` : `${mins}m`
    const timeOpts = { hour: '2-digit', minute: '2-digit', hour12: false }
    const detectedTime = new Date(detectedAt).toLocaleTimeString(lang === 'ko' ? 'ko-KR' : 'en-US', timeOpts)
    const officialTime = new Date(incident.startedAt).toLocaleTimeString(lang === 'ko' ? 'ko-KR' : 'en-US', timeOpts)
    return { label, detectedTime, officialTime }
  })()

  return (
    <div className="flex items-start gap-[10px]">
      <span className={`shrink-0 mt-0.5 text-[10px] mono ${dotCls}`} aria-hidden="true">●</span>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <p className="text-xs text-[var(--text1)] truncate">{incident.title}</p>
          {lead && (
            <span
              className="shrink-0 mono text-[9px] text-[var(--green)] bg-[var(--status-bg-green)] rounded cursor-default"
              style={{ padding: '1px 5px' }}
              title={lang === 'ko'
                ? `AIWatch 감지: ${lead.detectedTime} / 공식 발표: ${lead.officialTime}`
                : `AIWatch detected: ${lead.detectedTime} / Official report: ${lead.officialTime}`}
            >
              <span style={{ fontWeight: 600 }}>{lead.label}</span> lead
            </span>
          )}
        </div>
        <p className="text-[10px] text-[var(--text2)] mono mt-0.5">
          {formatDate(incident.startedAt, lang)}
          {incident.duration ? ` · ${incident.duration}` : ''}
        </p>
      </div>
      <span className={`shrink-0 text-[10px] mono ${dotCls}`}>
        {t(`incidents.status.${displayStatus}`)}
      </span>
    </div>
  )
}

const CALENDAR_OPACITY = { operational: 0.7, degraded: 0.8, down: 0.9 }

function CalendarCell({ status, date }) {
  const [hovered, setHovered] = useState(false)
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
        aria-label={`${date}: ${status}`}
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
          {date} — {status}
        </div>
      )}
    </div>
  )
}

function BadgeCode({ serviceId, serviceName, t }) {
  const [copied, setCopied] = useState(false)
  const baseUrl = 'https://aiwatch-worker.p2c2kbf.workers.dev'
  const code = `[![${serviceName}](${baseUrl}/badge/${serviceId})](https://ai-watch.dev/#${serviceId})`

  const handleCopy = () => {
    navigator.clipboard.writeText(code).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    }).catch(() => {})
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

// ── Main Component ───────────────────────────────────────────

export default function ServiceDetails({ serviceId }) {
  const { t, lang } = useLang()
  const { setPage } = usePage()
  const { services: rawServices, loading, error, latency24h, refresh } = usePolling()
  const services = rawServices ?? []

  // useMemo must be called before any early returns (Rules of Hooks)
  const mttr = useMemo(() => {
    const svc = services.find((s) => s.id === serviceId)
    const cutoff = Date.now() - 7 * 86_400_000
    const resolved = (svc?.incidents ?? []).filter((i) => i.status === 'resolved' && i.duration && i.duration !== '0m' && new Date(i.startedAt).getTime() >= cutoff)
    if (resolved.length === 0) return null
    const totalMinutes = resolved.reduce((sum, i) => {
      const m = i.duration.match(/(?:(\d+)h\s*)?(\d+)m/)
      return sum + (m ? (parseInt(m[1] || '0') * 60 + parseInt(m[2])) : 0)
    }, 0)
    if (totalMinutes === 0) return null
    const avg = Math.round(totalMinutes / resolved.length)
    return avg >= 60 ? `${Math.floor(avg / 60)}h ${avg % 60}m` : `${avg}m`
  }, [services, serviceId])

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
  const cutoff7d = Date.now() - 7 * 86_400_000
  const recentIncidents = (service.incidents ?? []).filter(
    (inc) => inc.status !== 'resolved' || new Date(inc.startedAt).getTime() >= cutoff7d
  )
  const incidentCount = recentIncidents.length
  const calendarDays = service.calendarDays ?? 14

  const calendarData = buildCalendarFromIncidents(service.incidents, service.dailyImpact, calendarDays)

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
          sub={service.latency != null ? t('svc.latency.sub') : t('uptime.collecting')}
          colorClass="text-[var(--blue)]"
        />
        <MetricCard
          label={t({ official: 'uptime.label.official', platform_avg: 'uptime.label.platform_avg', estimate: 'uptime.label.estimate' }[service.uptimeSource] ?? 'svc.uptime30d')}
          value={service.uptime30d != null ? `${service.uptime30d.toFixed(2)}%` : '—'}
          sub={t({ official: 'uptime.sub.official', platform_avg: 'uptime.sub.platform_avg', estimate: 'uptime.sub.estimate' }[service.uptimeSource] ?? 'uptime.unavailable')}
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
          value={mttr ?? '—'}
          sub={mttr ? t('svc.incidents.sub') : t('svc.mttr.none')}
          colorClass={mttr ? 'text-[var(--amber)]' : 'text-[var(--text2)]'}
        />
      </div>

      {/* ── AIWatch Score Breakdown ── */}
      {service.aiwatchScore != null && (
        <section className="bg-[var(--bg1)] border border-[var(--border)] rounded-lg overflow-hidden">
          <div className="flex items-center justify-between border-b border-[var(--border)]" style={{ padding: '12px 16px' }}>
            <div className="mono text-[10px] text-[var(--text1)] uppercase tracking-wider flex items-center gap-1.5">
              <span className="rounded-full shrink-0" style={{ width: '5px', height: '5px', background: 'var(--teal)' }} />
              {t('score.label')}
              <span className="text-[var(--text2)] font-normal">— 30{t('settings.period.suffix')}</span>
            </div>
            <span className={`mono text-[18px] font-semibold ${SCORE_TEXT_CLASS[service.scoreGrade] ?? 'text-[var(--text2)]'}`}>
              {service.aiwatchScore}
            </span>
          </div>
          <div style={{ padding: '16px' }}>
            <div className="flex flex-col gap-3">
              {service.scoreBreakdown?.uptime != null ? (
                <div className="flex items-center gap-3">
                  <span className="w-16 shrink-0 mono text-[10px] text-[var(--text2)]">{t('score.uptime')}</span>
                  <div className="flex-1 bg-[var(--bg3)] rounded-full" style={{ height: '6px' }}>
                    <div className="bg-[var(--teal)] rounded-full" style={{ height: '6px', width: `${(service.scoreBreakdown.uptime / 50) * 100}%` }} />
                  </div>
                  <span className="w-10 shrink-0 text-right mono text-[10px] text-[var(--text1)]">{service.scoreBreakdown.uptime}/50</span>
                </div>
              ) : (
                <div className="flex items-center gap-3">
                  <span className="w-16 shrink-0 mono text-[10px] text-[var(--text2)]">{t('score.uptime')}</span>
                  <span className="mono text-[10px] text-[var(--text2)]">{t('uptime.unavailable')}</span>
                </div>
              )}
              {[
                { label: t('score.incidents'), value: service.scoreBreakdown?.incidents, max: 30 },
                { label: t('score.recovery'), value: service.scoreBreakdown?.recovery, max: 20 },
              ].map(({ label, value, max }) => (
                <div key={label} className="flex items-center gap-3">
                  <span className="w-16 shrink-0 mono text-[10px] text-[var(--text2)]">{label}</span>
                  <div className="flex-1 bg-[var(--bg3)] rounded-full" style={{ height: '6px' }}>
                    <div className="bg-[var(--teal)] rounded-full" style={{ height: '6px', width: `${((value ?? 0) / max) * 100}%` }} />
                  </div>
                  <span className="w-10 shrink-0 text-right mono text-[10px] text-[var(--text1)]">{value != null ? value : '—'}/{max}</span>
                </div>
              ))}
            </div>
            {service.scoreConfidence !== 'high' && (
              <div className="mono text-[9px] text-[var(--text2)]" style={{ marginTop: '10px' }}>
                * {t('score.no_uptime')}
              </div>
            )}
          </div>
        </section>
      )}

      {/* ── 24h Latency Trend — shows chart when hourly KV data exists ── */}
      {service.category === 'api' && <ServiceLatencyTrend service={service} t={t} hourlyData={latency24h} />}

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
            {NO_INCIDENT_SUPPORT.has(service.id) ? (
              <div className="flex items-center gap-2 py-4">
                <span className="text-[var(--text2)] text-sm" aria-hidden="true">—</span>
                <span className="text-xs text-[var(--text2)]">{t('svc.incidents.unsupported')}</span>
              </div>
            ) : incidentCount === 0 ? (
              <div className="flex items-center gap-2 py-4">
                <span className="text-[var(--green)] text-sm" aria-hidden="true">✓</span>
                <span className="text-xs text-[var(--text2)]">{t('svc.no.incidents')}</span>
              </div>
            ) : (
              <div className="flex flex-col" style={{ gap: '8px' }}>
                {recentIncidents.map((inc) => (
                  <IncidentRow key={inc.id} incident={inc} detectedAt={service.detectedAt} t={t} lang={lang} />
                ))}
              </div>
            )}
          </div>
        </section>

        {/* Status Calendar — hidden when calendarDays is 0 (no reliable data) */}
        {calendarDays > 0 && <section className="bg-[var(--bg1)] border border-[var(--border)] rounded-lg overflow-hidden">
          <div className="flex items-center justify-between border-b border-[var(--border)]" style={{ padding: '12px 16px' }}>
            <div className="mono text-[10px] text-[var(--text1)] uppercase tracking-wider flex items-center gap-1.5">
              <span className="rounded-full shrink-0" style={{ width: '5px', height: '5px', background: 'var(--green)' }} />
              {t('svc.cal.legend')}
            </div>
            <div className="flex gap-3">
              {['operational', 'degraded_perf', 'degraded', 'down'].map((s) => (
                <div key={s} className="flex items-center gap-1">
                  <span className={`rounded-sm ${CALENDAR_CLASS[s]}`} style={{ width: '8px', height: '8px' }} />
                  <span className="text-[9px] mono text-[var(--text2)]">{t(`status.${s}`)}</span>
                </div>
              ))}
            </div>
          </div>
          <div style={{ padding: '16px' }}>
            <div className="flex flex-wrap" style={{ gap: '2px' }}>
              {calendarData.map((status, i) => (
                <CalendarCell key={i} status={status} date={calendarDate(i, lang, calendarDays)} />
              ))}
            </div>
            <div className="flex justify-between mono text-[9px] text-[var(--text2)]" style={{ marginTop: '6px' }}>
              <span>{calendarDays}{t('settings.period.suffix')} {t('svc.cal.ago.suffix')}</span>
              <span>{t('svc.cal.today')}</span>
            </div>
          </div>
        </section>}

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
            {service.uptime30d != null && <img src={`${(import.meta.env.VITE_API_URL || 'http://localhost:8788').replace('/api/status', '')}/badge/${service.id}?uptime=true`} alt={`${service.name} uptime`} height="20" />}
          </div>
          <BadgeCode serviceId={service.id} serviceName={service.name} t={t} />
        </div>
      </section>

      </div>

    </div>
  )
}
