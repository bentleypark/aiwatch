// SkeletonUI — shimmer placeholders shown while data is loading
// Renders 4 stat card skeletons + 6 service card skeletons

import { useLang } from '../hooks/useLang'

function Block({ className }) {
  return (
    <div
      className={`bg-[var(--bg3)] rounded animate-[skeleton-shimmer_1.4s_ease-in-out_infinite] ${className}`}
    />
  )
}

function StatSkeleton() {
  return (
    <div className="bg-[var(--bg1)] border border-[var(--border)] rounded-lg p-4 flex flex-col gap-3">
      <Block className="h-3 w-20" />
      <Block className="h-7 w-12" />
      <Block className="h-3 w-28" />
    </div>
  )
}

function ServiceSkeleton() {
  return (
    <div className="bg-[var(--bg1)] border border-[var(--border)] rounded-lg p-4 flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <Block className="h-3 w-24" />
        <Block className="h-5 w-20 rounded-full" />
      </div>
      <Block className="h-3 w-16" />
    </div>
  )
}

export default function SkeletonUI() {
  const { t } = useLang()

  return (
    <div role="status" aria-label={t('modal.loading')}>
      <span className="sr-only">{t('modal.loading')}</span>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
        {Array.from({ length: 4 }, (_, i) => <StatSkeleton key={i} />)}
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {Array.from({ length: 6 }, (_, i) => <ServiceSkeleton key={i} />)}
      </div>
    </div>
  )
}
