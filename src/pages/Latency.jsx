// Latency — response time analysis page
// Shows fastest/average/slowest summary, ranked latency list (proportional bars in HTML/CSS), and 24h trend line chart.
// Chart.js uses hex colors for service lines (visualization palette — not design tokens).

import { useMemo } from 'react'
import {
  Chart as ChartJS,
  CategoryScale, LinearScale, PointElement, LineElement,
  Tooltip, Legend, Filler,
} from 'chart.js'
import { Line } from 'react-chartjs-2'
import { useLang } from '../hooks/useLang'
import { useTheme } from '../hooks/useTheme'
import { usePolling } from '../hooks/usePolling'
import SkeletonUI from '../components/SkeletonUI'
import EmptyState from '../components/EmptyState'

ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, Tooltip, Legend, Filler)

// ── Constants ────────────────────────────────────────────────

// Read a CSS custom property value from :root at render time (not module eval).
// Note: calls inside useMemo blocks are only re-evaluated when that memo's dependencies change.
// All cssVar() reads in the options memo are intentionally gated on theme — do not add reads for
// variables that change independently of theme (they would become stale).
const cssVar = (name) =>
  getComputedStyle(document.documentElement).getPropertyValue(name).trim()

// Latency thresholds for bar color coding
const FAST_MS   = 200  // ≤ 200ms → green
const NORMAL_MS = 500  // 201–500ms → amber  /  > 500ms → red

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

// Generate 24 synthetic hourly data points with sinusoidal variation around baseLatency.
// Output is deterministic for a given baseLatency (no Math.random).
// Note: these are dummy values paired with time-relative x-axis labels (see hourLabels).
// Replace with real 24h time-series from usePolling() once available (Issue #15).
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

// ── Sub-components ───────────────────────────────────────────

function SummaryCard({ label, value, name, colorClass }) {
  return (
    <div className="bg-[var(--bg1)] border border-[var(--border)] rounded-lg p-4 flex flex-col gap-1">
      <span className="text-xs text-[var(--text2)] uppercase tracking-wider">{label}</span>
      <span className={`text-2xl mono font-semibold ${colorClass}`}>{value} ms</span>
      <span className="text-xs text-[var(--text1)] truncate">{name}</span>
    </div>
  )
}

function RankingBar({ service, maxLatency, rank }) {
  const widthPct = maxLatency > 0 ? Math.round((service.latency / maxLatency) * 100) : 0
  return (
    <div className="flex items-center gap-3">
      <span className="w-4 shrink-0 text-right text-[10px] mono text-[var(--text2)]">{rank}</span>
      <span className="w-28 shrink-0 truncate text-xs text-[var(--text1)]">{service.name}</span>
      <div className="flex-1 bg-[var(--bg3)] rounded-full h-2">
        <div
          className={`h-2 rounded-full ${latencyColorClass(service.latency)}`}
          style={{ width: `${widthPct}%` }}
        />
      </div>
      <span className={`w-16 shrink-0 text-right text-xs mono font-medium ${latencyTextClass(service.latency)}`}>
        {service.latency} ms
      </span>
    </div>
  )
}

// theme prop is used as key on <Line> to force re-mount on theme switch,
// ensuring cssVar() values in options are re-read after CSS vars change.
function TrendChart({ services, theme, t }) {
  // Memoized per service — gen24h is deterministic so re-computation only on services change
  const datasets = useMemo(
    () =>
      services.map((svc) => ({
        label: svc.name,
        data: gen24h(svc.latency),
        borderColor: SERVICE_COLOR[svc.id] ?? '#8b949e',
        backgroundColor: 'transparent',
        borderWidth: 1.5,
        pointRadius: 0,
        tension: 0.4,
      })),
    [services]
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
        legend: {
          labels: {
            color: cssVar('--text1'),
            font: { family: 'IBM Plex Mono', size: 10 },
            boxWidth: 10,
            padding: 12,
          },
        },
        tooltip: {
          callbacks: { label: (ctx) => `${ctx.dataset.label}: ${ctx.parsed.y} ms` },
        },
      },
    }),
    [theme] // re-read CSS vars when theme switches
  )

  // Hour labels are computed once when TrendChart mounts and do not update with polling data.
  // Labels reflect the time of the last page load. Reload to get current labels.
  const labels = useMemo(hourLabels, [])

  return (
    <div className="bg-[var(--bg1)] border border-[var(--border)] rounded-lg p-4">
      <h2 className="text-xs mono text-[var(--text2)] uppercase tracking-wider mb-1">
        {t('latency.trend')}
      </h2>
      {/* Dummy data notice — remove this and replace gen24h() with real 24h time-series from usePolling()
          once the hook exposes historical data (Issue #15). Expected shape: { timestamp: number, latency: number }[] */}
      <p className="text-[10px] text-[var(--amber)] mono mb-4">{t('latency.dummy')}</p>
      <div className="h-[320px]">
        {/* key=theme forces Chart.js re-mount on theme switch to pick up new CSS var values */}
        <Line key={theme} data={{ labels, datasets }} options={options} />
      </div>
    </div>
  )
}

// ── Main Component ───────────────────────────────────────────

export default function Latency() {
  const { t } = useLang()
  const { theme } = useTheme()
  const { services: rawServices, loading, error } = usePolling()

  // Defensive default — handles transient undefined state
  const services = rawServices ?? []

  if (loading) return <SkeletonUI />
  if (error)   return <EmptyState type="error" onAction={() => window.location.reload()} />

  const sorted = [...services].sort((a, b) => a.latency - b.latency)
  const fastest = sorted[0]
  const slowest = sorted[sorted.length - 1]
  const avg = services.length
    ? Math.round(services.reduce((s, v) => s + v.latency, 0) / services.length)
    : 0
  const maxLatency = slowest?.latency ?? 1

  return (
    <div className=" space-y-6">

      {/* ── Summary Cards ── */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <SummaryCard label={t('latency.fastest')} value={fastest?.latency ?? '—'} name={fastest?.name ?? ''} colorClass="text-[var(--green)]" />
        <SummaryCard label={t('latency.average')} value={avg}                       name=""                    colorClass="text-[var(--blue)]" />
        <SummaryCard label={t('latency.slowest')} value={slowest?.latency ?? '—'}   name={slowest?.name ?? ''} colorClass="text-[var(--red)]" />
      </div>

      {/* ── Ranking Bar Chart ── */}
      <section className="bg-[var(--bg1)] border border-[var(--border)] rounded-lg p-4">
        <h2 className="text-xs mono text-[var(--text2)] uppercase tracking-wider mb-4">
          {t('latency.rankings')}
        </h2>
        {services.length === 0 ? (
          <EmptyState type="neutral" />
        ) : (
          <div className="flex flex-col gap-3">
            {sorted.map((svc, i) => (
              <RankingBar key={svc.id} service={svc} maxLatency={maxLatency} rank={i + 1} />
            ))}
          </div>
        )}
      </section>

      {/* ── 24h Trend Line Chart ── */}
      <TrendChart services={services} theme={theme} t={t} />

    </div>
  )
}
