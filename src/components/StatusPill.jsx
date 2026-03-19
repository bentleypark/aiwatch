// StatusPill — compact badge showing service operational status
// Colors use CSS token pairs: --status-bg-* (background) + --green/amber/red (text)
// Unknown status values fall back silently to 'operational'

import { useLang } from '../hooks/useLang'

const PILL_CLASS = {
  operational: 'bg-[var(--status-bg-green)] text-[var(--green)]',
  degraded:    'bg-[var(--status-bg-amber)] text-[var(--amber)]',
  down:        'bg-[var(--status-bg-red)]   text-[var(--red)]',
}

export default function StatusPill({ status = 'operational' }) {
  const { t } = useLang()
  const cls = PILL_CLASS[status] ?? PILL_CLASS.operational

  return (
    <span
      role="status"
      className={`inline-flex items-center px-2 py-0.5 rounded text-[11px] mono font-medium ${cls}`}
    >
      {t(`status.${status}`)}
    </span>
  )
}
