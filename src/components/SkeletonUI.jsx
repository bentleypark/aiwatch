// SkeletonUI — shimmer placeholders for each page layout
// Shared Block + StatSkeleton, with page-specific exports.

import { useLang } from '../hooks/useLang'

function Block({ style, className = '' }) {
  return (
    <div
      className={`bg-[var(--bg3)] rounded animate-[skeleton-shimmer_1.4s_ease-in-out_infinite] ${className}`}
      style={style}
    />
  )
}

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

function SectionSkeleton() {
  return (
    <div className="bg-[var(--bg1)] border border-[var(--border)] rounded-lg overflow-hidden">
      <div className="border-b border-[var(--border)]" style={{ padding: '12px 16px' }}>
        <Block style={{ height: '10px', width: '100px' }} />
      </div>
      <div style={{ padding: '16px' }}>
        <Block style={{ height: '200px', width: '100%' }} />
      </div>
    </div>
  )
}

function BarRowSkeleton() {
  return (
    <div className="flex items-center gap-3">
      <Block style={{ height: '12px', width: '80px' }} />
      <Block style={{ height: '8px', flex: 1, borderRadius: '4px' }} />
      <Block style={{ height: '12px', width: '50px' }} />
    </div>
  )
}

function ServiceSkeleton() {
  return (
    <div className="bg-[var(--bg1)] border border-[var(--border)] rounded-lg" style={{ padding: '14px' }}>
      <div className="flex items-center justify-between" style={{ marginBottom: '10px' }}>
        <div>
          <Block style={{ height: '14px', width: '80px', marginBottom: '5px' }} />
          <Block style={{ height: '10px', width: '52px' }} />
        </div>
        <Block style={{ height: '18px', width: '60px', borderRadius: '4px' }} />
      </div>
      <div className="grid grid-cols-3" style={{ gap: '6px', marginBottom: '10px' }}>
        {[0, 1, 2].map((i) => (
          <div key={i} style={{ textAlign: 'center' }}>
            <Block style={{ height: '13px', width: '38px', margin: '0 auto 4px' }} />
            <Block style={{ height: '9px', width: '30px', margin: '0 auto' }} />
          </div>
        ))}
      </div>
      <Block style={{ height: '18px', width: '100%' }} />
    </div>
  )
}

// ── Overview Skeleton ──
export default function SkeletonUI() {
  const { t } = useLang()
  return (
    <div role="status" aria-label={t('modal.loading')}>
      <span className="sr-only">{t('modal.loading')}</span>
      <div className="grid grid-cols-2 md:grid-cols-4" style={{ gap: '10px', marginBottom: '20px' }}>
        <StatSkeleton label={t('overview.stats.operational')} />
        <StatSkeleton label={t('overview.stats.degraded')} />
        <StatSkeleton label={t('overview.stats.down')} />
        <StatSkeleton label={t('overview.stats.uptime')} />
      </div>
      <div className="mono text-[10px] text-[var(--text2)] uppercase flex items-center gap-2" style={{ letterSpacing: '0.1em', marginBottom: '12px' }}>
        <span className="text-[var(--green)] font-semibold">//</span>
        {t('nav.services')}
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3" style={{ gap: '8px' }}>
        {Array.from({ length: 6 }, (_, i) => <ServiceSkeleton key={i} />)}
      </div>
    </div>
  )
}

// ── Latency Skeleton ──
export function LatencySkeleton() {
  const { t } = useLang()
  return (
    <div role="status" aria-label={t('modal.loading')}>
      <span className="sr-only">{t('modal.loading')}</span>
      <div className="grid grid-cols-1 md:grid-cols-3" style={{ gap: '10px', marginBottom: '20px' }}>
        <StatSkeleton label={t('latency.fastest')} />
        <StatSkeleton label={t('latency.average')} />
        <StatSkeleton label={t('latency.slowest')} />
      </div>
      <div className="bg-[var(--bg1)] border border-[var(--border)] rounded-lg overflow-hidden">
        <div className="border-b border-[var(--border)]" style={{ padding: '12px 16px' }}>
          <Block style={{ height: '10px', width: '120px' }} />
        </div>
        <div className="flex flex-col gap-3" style={{ padding: '16px' }}>
          {Array.from({ length: 8 }, (_, i) => <BarRowSkeleton key={i} />)}
        </div>
      </div>
    </div>
  )
}

// ── Incidents Skeleton ──
export function IncidentsSkeleton() {
  const { t } = useLang()
  return (
    <div role="status" aria-label={t('modal.loading')}>
      <span className="sr-only">{t('modal.loading')}</span>
      <div className="flex gap-2" style={{ marginBottom: '16px' }}>
        <Block style={{ height: '28px', width: '80px', borderRadius: '4px' }} />
        <Block style={{ height: '28px', width: '80px', borderRadius: '4px' }} />
        <Block style={{ height: '28px', width: '80px', borderRadius: '4px' }} />
      </div>
      <div className="flex flex-col gap-2">
        {Array.from({ length: 6 }, (_, i) => (
          <div key={i} className="bg-[var(--bg1)] border border-[var(--border)] rounded-lg" style={{ padding: '14px' }}>
            <div className="flex items-center justify-between" style={{ marginBottom: '8px' }}>
              <Block style={{ height: '14px', width: '200px' }} />
              <Block style={{ height: '18px', width: '60px', borderRadius: '4px' }} />
            </div>
            <Block style={{ height: '10px', width: '120px' }} />
          </div>
        ))}
      </div>
    </div>
  )
}

// ── Uptime Skeleton ──
export function UptimeSkeleton() {
  const { t } = useLang()
  return (
    <div role="status" aria-label={t('modal.loading')}>
      <span className="sr-only">{t('modal.loading')}</span>
      <div className="grid grid-cols-1 md:grid-cols-3" style={{ gap: '10px', marginBottom: '20px' }}>
        <StatSkeleton label={t('uptime.stable')} />
        <StatSkeleton label={t('uptime.average')} />
        <StatSkeleton label={t('uptime.issues')} />
      </div>
      <div className="bg-[var(--bg1)] border border-[var(--border)] rounded-lg overflow-hidden">
        <div className="border-b border-[var(--border)]" style={{ padding: '12px 16px' }}>
          <Block style={{ height: '10px', width: '120px' }} />
        </div>
        <div className="flex flex-col gap-3" style={{ padding: '16px' }}>
          {Array.from({ length: 10 }, (_, i) => <BarRowSkeleton key={i} />)}
        </div>
      </div>
    </div>
  )
}

// ── ServiceDetails Skeleton ──
export function ServiceDetailsSkeleton() {
  const { t } = useLang()
  return (
    <div role="status" aria-label={t('modal.loading')}>
      <span className="sr-only">{t('modal.loading')}</span>
      {/* Header */}
      <div className="flex items-center gap-3" style={{ marginBottom: '20px' }}>
        <Block style={{ height: '24px', width: '24px', borderRadius: '6px' }} />
        <Block style={{ height: '18px', width: '150px' }} />
        <Block style={{ height: '20px', width: '70px', borderRadius: '4px' }} />
      </div>
      {/* 4 metric cards */}
      <div className="grid grid-cols-2 md:grid-cols-4" style={{ gap: '10px', marginBottom: '20px' }}>
        <StatSkeleton label={t('svc.latency')} />
        <StatSkeleton label={t('svc.uptime30d')} />
        <StatSkeleton label={t('svc.incidents')} />
        <StatSkeleton label={t('svc.mttr')} />
      </div>
      {/* Chart + Calendar */}
      <div className="flex flex-col" style={{ gap: '20px' }}>
        <SectionSkeleton />
        <SectionSkeleton />
      </div>
    </div>
  )
}
