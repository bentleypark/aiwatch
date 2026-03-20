// Latency — response time analysis page
// Shows fastest/average/slowest summary, ranked latency list, and current latency snapshot.

import { useMemo } from 'react'
import { useLang } from '../hooks/useLang'
import { usePolling } from '../hooks/usePolling'
import SkeletonUI from '../components/SkeletonUI'
import EmptyState from '../components/EmptyState'

// ── Constants ────────────────────────────────────────────────

// Latency thresholds for bar color coding
const FAST_MS   = 300  // ≤ 300ms → green
const NORMAL_MS = 500  // 301–500ms → amber  /  > 500ms → red

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

// ── Main Component ───────────────────────────────────────────

export default function Latency() {
  const { t } = useLang()
  const { services: rawServices, loading, error } = usePolling()

  // Defensive default — handles transient undefined state
  const services = rawServices ?? []

  if (loading && services.length === 0) return <SkeletonUI />
  if (error)   return <EmptyState type="error" onAction={() => window.location.reload()} />

  // Only include services with latency data (exclude web apps and coding agents)
  const withLatency = services.filter((s) => s.latency != null)
  const sorted = [...withLatency].sort((a, b) => a.latency - b.latency)
  const fastest = sorted[0]
  const slowest = sorted[sorted.length - 1]
  const avg = withLatency.length
    ? Math.round(withLatency.reduce((s, v) => s + v.latency, 0) / withLatency.length)
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

      {/* ── Summary Cards ── */}
      <div className="grid grid-cols-1 md:grid-cols-3" style={{ gap: '10px' }}>
        <SummaryCard label={t('latency.fastest')} value={fastest?.latency ?? '—'} sub={fastest?.name ?? ''} colorClass="text-[var(--green)]" />
        <SummaryCard label={t('latency.average')} value={avg}                      sub={`${services.length} ${t('latency.avg.services')}`}  colorClass="text-[var(--blue)]" />
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
          </div>
        )}
        </div>
      </section>

      {/* ── 24h Trend — placeholder until hourly data is accumulated in KV ── */}
      <section className="bg-[var(--bg1)] border border-[var(--border)] rounded-lg overflow-hidden">
        <div className="border-b border-[var(--border)]" style={{ padding: '12px 16px' }}>
          <div className="mono text-[10px] text-[var(--text1)] uppercase tracking-wider flex items-center gap-1.5">
            <span className="rounded-full shrink-0" style={{ width: '5px', height: '5px', background: 'var(--blue)' }} />
            {t('latency.trend')}
          </div>
        </div>
        <div className="flex items-center justify-center" style={{ padding: '40px 16px' }}>
          <p className="text-xs text-[var(--text2)] mono">{t('uptime.collecting')}</p>
        </div>
      </section>

    </div>
  )
}
