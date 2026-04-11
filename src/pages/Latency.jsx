// Latency — response time analysis page
// Shows fastest/average/slowest summary, ranked latency list, and current latency snapshot.

import { useEffect, useMemo, useRef } from 'react'
import { useLang } from '../hooks/useLang'
import { usePolling } from '../hooks/usePolling'
import { LatencySkeleton } from '../components/SkeletonUI'
import EmptyState from '../components/EmptyState'
import { ensureChart } from '../utils/chartLoader'
import { filterLast24h } from '../utils/time'

// ── Constants ────────────────────────────────────────────────

// Latency thresholds for bar color coding
const FAST_MS   = 500  // ≤ 500ms → green
const NORMAL_MS = 800  // 501–800ms → amber  /  > 800ms → red

// Per-service chart line colors (visualization palette — not design tokens).
// Canvas-based charts cannot use CSS custom properties directly.
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
  openrouter:  '#ffa657',
  stability:   '#c9d1d9',
  assemblyai:  '#79dfc1',
  deepgram:    '#a5b4fc',
}

// ── Helpers ──────────────────────────────────────────────────

function latencyColorClass(ms) {
  if (ms <= FAST_MS)   return 'bg-[var(--green)]'
  if (ms <= NORMAL_MS) return 'bg-[var(--amber)]'
  return 'bg-[var(--red)]'
}

function latencyTextClass(ms) {
  if (ms <= FAST_MS)   return 'text-[var(--green)]'
  if (ms <= NORMAL_MS) return 'text-[var(--amber)]'
  return 'text-[var(--red)]'
}

// ── 24h Trend Section (ready for chart integration) ──────────

function LatencyTrendSection({ services, t, hourlyData }) {
  const canvasRef = useRef(null)
  const chartRef = useRef(null)
  const hasData = hourlyData && hourlyData.length > 0

  useEffect(() => {
    if (!canvasRef.current || !hasData) return
    let cancelled = false
    ensureChart().then((Chart) => {
      if (cancelled || !canvasRef.current) return
      if (chartRef.current) chartRef.current.destroy()

    // Detect data format: probe snapshots have { status, rtt } objects, latency snapshots have plain numbers
    const isProbeData = hourlyData.length > 0 && typeof Object.values(hourlyData[0].data ?? {})[0] === 'object'
    // For probe data, show only services present in probe snapshots
    const probeServiceIds = isProbeData ? Object.keys(hourlyData[hourlyData.length - 1]?.data ?? {}) : null
    const isMobile = window.innerWidth < 768

    // Downsample 5-min probe data → 30-min slot averages (:00–:29, :30–:59)
    const needsDownsample = isProbeData && hourlyData.length > 60
    let chartData = hourlyData
    if (needsDownsample) {
      const slotMap = new Map()
      for (const s of hourlyData) {
        const d = new Date(s.t)
        const h = d.getHours()
        const half = d.getMinutes() < 30 ? 0 : 30
        const key = `${h}:${half}`
        if (!slotMap.has(key)) slotMap.set(key, { points: [], h, half })
        slotMap.get(key).points.push(s)
      }
      chartData = [...slotMap.values()].map(({ points, h, half }) => {
        const mid = points[Math.floor(points.length / 2)]
        const merged = {}
        const svcIds = new Set(points.flatMap((s) => Object.keys(s.data ?? {})))
        for (const id of svcIds) {
          const vals = points.map((s) => {
            const v = s.data?.[id]
            return v && typeof v === 'object' ? (v.rtt > 0 ? v.rtt : null) : v
          }).filter((v) => v != null)
          if (vals.length > 0) merged[id] = { rtt: Math.round(vals.reduce((a, b) => a + b, 0) / vals.length), status: 'ok' }
        }
        const hh = String(h).padStart(2, '0')
        const endHalf = half === 0 ? '30' : '00'
        const endH = half === 0 ? hh : String((h + 1) % 24).padStart(2, '0')
        return { t: mid.t, data: merged, _rangeLabel: `${hh}:${String(half).padStart(2, '0')}–${endH}:${endHalf}` }
      })
    }

    const labels = chartData.map((s) => {
      const d = new Date(s.t)
      return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
    })
    const rangeLabels = needsDownsample ? chartData.map((s) => s._rangeLabel) : null

    let apiServices = probeServiceIds
      ? services.filter((s) => probeServiceIds.includes(s.id))
      : services.filter((s) => s.category === 'api' && s.latency != null)
    if (isMobile) apiServices = [...apiServices].sort((a, b) => (b.aiwatchScore ?? 0) - (a.aiwatchScore ?? 0)).slice(0, 8)
    const styles = getComputedStyle(document.documentElement)
    const textMuted = styles.getPropertyValue('--text2').trim() || '#6b7280'
    const borderClr = styles.getPropertyValue('--border').trim() || 'rgba(107,114,128,0.1)'

    const datasets = apiServices.map((svc) => ({
      label: svc.name,
      data: chartData.map((s) => {
        const val = s.data[svc.id]
        if (val == null) return null
        if (typeof val === 'object') return val.rtt > 0 ? val.rtt : null
        return val
      }),
      borderColor: SERVICE_COLOR[svc.id] ?? '#8b949e',
      borderWidth: isMobile ? 1 : 1.5,
      pointRadius: isMobile ? 0 : 1.5,
      pointHoverRadius: 3,
      tension: 0.3,
      fill: false,
      spanGaps: true,
    }))

    chartRef.current = new Chart(canvasRef.current, {
      type: 'line',
      data: { labels, datasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: {
            display: !isMobile,
            position: 'bottom',
            labels: { font: { size: 9, family: 'var(--font-mono)' }, color: textMuted, boxWidth: 8, padding: 8 },
          },
          tooltip: {
            filter: (item) => item.parsed.y != null,
            itemSort: (a, b) => b.parsed.y - a.parsed.y,
            callbacks: {
              title: (items) => {
                if (!items.length) return ''
                const i = items[0].dataIndex
                return rangeLabels ? `${rangeLabels[i]} avg` : labels[i]
              },
              label: (ctx) => `${ctx.dataset.label}: ${ctx.parsed.y}ms`,
            },
          },
        },
        scales: {
          x: {
            ticks: { font: { size: 9, family: 'var(--font-mono)' }, color: textMuted, maxTicksLimit: isMobile ? 6 : 12, callback: (_, i) => { const l = labels[i]; return l ? l.slice(0, 3) + '00' : '' } },
            grid: { display: false },
          },
          y: {
            ticks: { font: { size: 9, family: 'var(--font-mono)' }, color: textMuted, callback: (v) => `${v}ms` },
            grid: { color: borderClr },
          },
        },
      },
    })

    }) // ensureChart
    return () => { cancelled = true; if (chartRef.current) { chartRef.current.destroy(); chartRef.current = null } }
  }, [hasData, hourlyData])

  return (
    <section className="bg-[var(--bg1)] border border-[var(--border)] rounded-lg overflow-hidden">
      <div className="border-b border-[var(--border)] flex items-center justify-between" style={{ padding: '12px 16px' }}>
        <div className="mono text-[10px] text-[var(--text1)] uppercase tracking-wider flex items-center gap-1.5">
          <span className="rounded-full shrink-0" style={{ width: '5px', height: '5px', background: 'var(--blue)' }} />
          {t('latency.trend')}
        </div>
        <span className="md:hidden mono text-[9px] text-[var(--text2)]">{t('latency.top8')}</span>
      </div>
      {hasData ? (
        <div className="p-2 md:p-4">
          <div className="h-[240px] md:h-[320px]">
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

// ── Sub-components ───────────────────────────────────────────

const STAT_TOP_COLOR = {
  'text-[var(--green)]': 'var(--green)',
  'text-[var(--blue)]':  'var(--blue)',
  'text-[var(--red)]':   'var(--red)',
}

function SummaryCard({ label, value, sub, colorClass }) {
  const topColor = STAT_TOP_COLOR[colorClass] ?? 'var(--border)'
  return (
    <div className="relative bg-[var(--bg1)] border border-[var(--border)] rounded-lg overflow-hidden"
         style={{ padding: '14px 16px' }}>
      <span className="absolute top-0 left-0 right-0 h-px" style={{ background: topColor }} />
      <div className="mono text-[9px] text-[var(--text2)] uppercase" style={{ letterSpacing: '0.1em', marginBottom: '6px' }}>{label}</div>
      <div className={`mono text-[26px] font-semibold leading-none ${colorClass}`} style={{ marginBottom: '4px' }}>
        {value}<span style={{ fontSize: '14px' }}>ms</span>
      </div>
      {sub && <div className="mono text-[10px] text-[var(--text2)]">{sub}</div>}
    </div>
  )
}

function RankingBar({ service, maxLatency, rank }) {
  const widthPct = maxLatency > 0 ? Math.round((service.latency / maxLatency) * 100) : 0
  return (
    <div className="flex items-center gap-1.5 md:gap-3 min-w-0">
      <span className="w-4 shrink-0 text-right text-[10px] mono text-[var(--text2)]">{rank}</span>
      <span className="w-[72px] md:w-28 shrink-0 truncate text-xs text-[var(--text1)]">{service.name}</span>
      <div className="flex-1 min-w-0 bg-[var(--bg3)] rounded-full h-2 overflow-hidden">
        <div
          className={`h-2 rounded-full ${latencyColorClass(service.latency)}`}
          style={{ width: `${widthPct}%` }}
        />
      </div>
      <span className={`w-[52px] md:w-16 shrink-0 text-right text-[10px] md:text-xs mono font-medium ${latencyTextClass(service.latency)}`}>
        {service.latency} ms
      </span>
    </div>
  )
}

// ── Main Component ───────────────────────────────────────────

export default function Latency() {
  const { t } = useLang()
  const { services: rawServices, loading, error, probe24h, latency24h, probeServiceIds, refresh } = usePolling()

  // Defensive default — handles transient undefined state
  const services = rawServices ?? []

  if (loading && services.length === 0) return <LatencySkeleton />
  if (!loading && services.length === 0 && error) return <EmptyState type="offline" onAction={refresh} />
  if (error)   return <EmptyState type="error" onAction={() => window.location.reload()} />

  // Split services: probe RTT (ranked) vs status page only (separate section)
  // When no probe data (mock/dev mode), show all services in ranked list
  const hasProbeData = probeServiceIds.length > 0
  const withLatency = services.filter((s) => s.latency != null)
  const probeServices = hasProbeData ? withLatency.filter((s) => probeServiceIds.includes(s.id)) : withLatency
  const statusPageOnly = hasProbeData ? withLatency.filter((s) => !probeServiceIds.includes(s.id)) : []
  const sorted = [...probeServices].sort((a, b) => a.latency - b.latency)
  const fastest = sorted[0]
  const slowest = sorted[sorted.length - 1]
  const avg = probeServices.length
    ? Math.round(probeServices.reduce((s, v) => s + v.latency, 0) / probeServices.length)
    : 0
  const maxLatency = slowest?.latency ?? 1

  return (
    <div className="flex flex-col" style={{ gap: '20px' }}>

      {/* ── Section Header ── */}
      <div className="flex items-center justify-between">
        <h2 className="mono text-[10px] text-[var(--text2)] uppercase flex items-center gap-2" style={{ letterSpacing: '0.1em' }}>
          <span className="text-[var(--green)] font-semibold">//</span>
          {t('nav.latency')}
        </h2>
        <span className="mono text-[10px] text-[var(--text2)]">{t('overview.panel.latency.sub')}</span>
      </div>

      {/* ── Disclaimer ── */}
      <p className="text-[11px] text-[var(--text2)]" style={{ marginTop: '-12px' }}>{t('latency.disclaimer')}</p>

      {/* ── Summary Cards ── */}
      <div className="grid grid-cols-1 md:grid-cols-3" style={{ gap: '10px' }}>
        <SummaryCard label={t('latency.fastest')} value={fastest?.latency ?? '—'} sub={fastest?.name ?? ''} colorClass="text-[var(--green)]" />
        <SummaryCard label={t('latency.average')} value={avg}                      sub={`${probeServices.length} ${t('latency.avg.services')}`}  colorClass="text-[var(--blue)]" />
        <SummaryCard label={t('latency.slowest')} value={slowest?.latency ?? '—'} sub={slowest?.name ?? ''} colorClass="text-[var(--red)]" />
      </div>

      {/* ── Ranking Bar Chart ── */}
      <section className="bg-[var(--bg1)] border border-[var(--border)] rounded-lg overflow-hidden">
        <div className="flex items-center justify-between border-b border-[var(--border)]" style={{ padding: '12px 16px' }}>
          <div className="mono text-[10px] text-[var(--text1)] uppercase tracking-wider flex items-center gap-1.5">
            <span className="rounded-full shrink-0" style={{ width: '5px', height: '5px', background: 'var(--teal)' }} />
            {t('latency.rankings')}
          </div>
        </div>
        <div style={{ padding: '16px' }}>
        {services.length === 0 ? (
          <EmptyState type="neutral" />
        ) : (
          <div className="flex flex-col gap-3">
            {sorted.map((svc, i) => (
              <RankingBar key={svc.id} service={svc} maxLatency={maxLatency} rank={i + 1} />
            ))}
            {statusPageOnly.length > 0 && (
              <>
                <div className="mono text-[9px] text-[var(--text2)] uppercase" style={{ marginTop: '8px', letterSpacing: '0.08em' }}>
                  {t('svc.latency.statusPage')}
                </div>
                {[...statusPageOnly].sort((a, b) => a.latency - b.latency).map((svc) => (
                  <RankingBar key={svc.id} service={svc} maxLatency={maxLatency} rank="—" />
                ))}
              </>
            )}
            <p className="text-[10px] text-[var(--text2)] mono" style={{ marginTop: '12px' }}>
              {t('latency.excludeNote')}
            </p>
          </div>
        )}
        </div>
      </section>

      {/* ── 24h Trend — shows badges + chart when hourly KV data exists ── */}
      <LatencyTrendSection services={sorted} t={t} hourlyData={probe24h.length > 0 ? filterLast24h(probe24h) : latency24h} />

    </div>
  )
}
