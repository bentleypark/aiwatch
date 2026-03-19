// SkeletonUI — shimmer placeholders matching design mockup
// Stat cards with labels + service cards with name/badge/metrics/history structure

import { useLang } from '../hooks/useLang'

function Block({ style, className = '' }) {
  return (
    <div
      className={`bg-[var(--bg3)] rounded animate-[skeleton-shimmer_1.4s_ease-in-out_infinite] ${className}`}
      style={style}
    />
  )
}

// Stat card skeleton: label text visible, value/sub as shimmer blocks, top border bg3
function StatSkeleton({ label }) {
  return (
    <div className="relative bg-[var(--bg1)] border border-[var(--border)] rounded-lg overflow-hidden"
         style={{ padding: '14px 16px' }}>
      <span className="absolute top-0 left-0 right-0 h-px bg-[var(--bg3)]" />
      <div className="mono text-[9px] text-[var(--text2)] uppercase" style={{ letterSpacing: '0.1em', marginBottom: '6px' }}>
        {label}
      </div>
      <Block style={{ height: '18px', width: '48px', marginBottom: '4px' }} />
      <Block style={{ height: '10px', width: '72px' }} />
    </div>
  )
}

// Service card skeleton: mimics name+badge / 3-col metrics / history bar
function ServiceSkeleton() {
  return (
    <div className="bg-[var(--bg1)] border border-[var(--border)] rounded-lg" style={{ padding: '14px' }}>
      {/* Name + badge row */}
      <div className="flex items-center justify-between" style={{ marginBottom: '10px' }}>
        <div>
          <Block style={{ height: '14px', width: '80px', marginBottom: '5px' }} />
          <Block style={{ height: '10px', width: '52px' }} />
        </div>
        <Block style={{ height: '18px', width: '60px', borderRadius: '4px' }} />
      </div>
      {/* 3-col metrics */}
      <div className="grid grid-cols-3" style={{ gap: '6px', marginBottom: '10px' }}>
        {[0, 1, 2].map((i) => (
          <div key={i} style={{ textAlign: 'center' }}>
            <Block style={{ height: '13px', width: '38px', margin: '0 auto 4px' }} />
            <Block style={{ height: '9px', width: '30px', margin: '0 auto' }} />
          </div>
        ))}
      </div>
      {/* History bar */}
      <Block style={{ height: '18px', width: '100%' }} />
    </div>
  )
}

export default function SkeletonUI() {
  const { t } = useLang()

  return (
    <div role="status" aria-label={t('modal.loading')}>
      <span className="sr-only">{t('modal.loading')}</span>

      {/* Stat cards with visible labels */}
      <div className="grid grid-cols-2 md:grid-cols-4" style={{ gap: '10px', marginBottom: '20px' }}>
        <StatSkeleton label={t('overview.stats.operational')} />
        <StatSkeleton label={t('overview.stats.degraded')} />
        <StatSkeleton label={t('overview.stats.down')} />
        <StatSkeleton label={t('overview.stats.uptime')} />
      </div>

      {/* Section title */}
      <div className="mono text-[10px] text-[var(--text2)] uppercase flex items-center gap-2" style={{ letterSpacing: '0.1em', marginBottom: '12px' }}>
        <span className="text-[var(--green)] font-semibold">//</span>
        {t('nav.services')}
      </div>

      {/* Service card skeletons */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3" style={{ gap: '8px' }}>
        {Array.from({ length: 6 }, (_, i) => <ServiceSkeleton key={i} />)}
      </div>
    </div>
  )
}
