// StatusPill — compact badge showing service operational status
// Colors use CSS token pairs: --status-bg-* (background) + --green/amber/red (text)
// Unknown status values fall back silently to 'operational'

import { useLang } from '../hooks/useLang'

const PILL_CLASS = {
  operational: 'bg-[var(--status-bg-green)] text-[var(--green)]',
  degraded:    'bg-[var(--status-bg-amber)] text-[var(--amber)]',
  down:        'bg-[var(--status-bg-red)]   text-[var(--red)]',
}

export default function StatusPill({ status = 'operational', partialCount = 0 }) {
  const { t } = useLang()
  const cls = PILL_CLASS[status] ?? PILL_CLASS.operational
  // Show the "N affected" chip only when the service reads operational but some
  // underlying resources report issues (BetterStack <30% threshold case, #447).
  // On degraded/down the pill itself already conveys the problem.
  const showPartial = status === 'operational' && partialCount > 0

  const pill = (
    <span
      role="status"
      className={`inline-flex items-center mono font-medium uppercase text-[9px] tracking-[0.06em] whitespace-nowrap shrink-0 ${cls}`}
      style={{ padding: '3px 7px', borderRadius: '4px' }}
    >
      {t(`status.${status}`)}
    </span>
  )

  if (!showPartial) return pill

  return (
    <span className="inline-flex items-center gap-1.5">
      {pill}
      <span
        className="inline-flex items-center mono font-medium text-[9px] whitespace-nowrap shrink-0 bg-[var(--status-bg-amber)] text-[var(--amber)]"
        style={{ padding: '3px 7px', borderRadius: '4px' }}
        title={t('status.partial.tooltip')}
      >
        ⚠ {partialCount}{t('status.partial.suffix')}
      </span>
    </span>
  )
}
