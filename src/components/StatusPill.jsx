// StatusPill — compact badge showing service operational status
// Colors use CSS token pairs: --status-bg-* (background) + --green/amber/red (text)
// Unknown status values fall back silently to 'operational'

import { useLang } from '../hooks/useLang'
import { resolveStatusDisplay } from '../utils/statusDisplay'

const PILL_CLASS = {
  operational: 'bg-[var(--status-bg-green)]  text-[var(--green)]',
  // #722 — intermediate "Partial" state (yellow), distinct from degraded (amber).
  // 4-step gradient: operational(green) → partial(yellow) → degraded(amber) → down(red).
  partial:     'bg-[var(--status-bg-yellow)] text-[var(--yellow)]',
  degraded:    'bg-[var(--status-bg-amber)]  text-[var(--amber)]',
  down:        'bg-[var(--status-bg-red)]    text-[var(--red)]',
  unknown:     'bg-[var(--bg3)] text-[var(--text2)]', // #689 — status source inactive: can't confirm
}

export default function StatusPill({ status = 'operational', partialCount = 0, sourceDead = false }) {
  const { t } = useLang()
  // #689 — when the status source is inactive (4xx / deactivated page) AIWatch cannot confirm the
  // service's status, so show a NEUTRAL "Unknown" pill rather than a misleading green "Operational"
  // (which would then need an awkward "but it's just a default" disclaimer). Honest > reassuring.
  // #722 — when the service reads operational but some underlying resources report issues
  // (BetterStack <threshold case, #447), promote the PILL ITSELF to a yellow "Partial" state rather
  // than a green pill + tiny chip: the provider page shows "Some services are down" and peers
  // (StatusGator/IsDown) use an intermediate "warn" state — a green pill understated the gap.
  // Render-time relabel only — it never changes the `status` field, so it can't itself escalate the
  // service to degraded or fire a degraded alert (those key off `status`). It does NOT shield the
  // Score/ranking from the real outage: that already flows in via uptime/incidents (server-side,
  // intended). resolveStatusDisplay also maps sourceDead → 'unknown' (#689) so a dead-source pill
  // never reads partial (component counts aren't trustworthy then).
  const effective = resolveStatusDisplay(status, partialCount, sourceDead)
  const isPartial = effective === 'partial'
  const cls = PILL_CLASS[effective] ?? PILL_CLASS.operational

  // #744 — single chip for partial: the "Partial" pill already conveys the state, so fold the count
  // into it (`⚠ Partial · N`) instead of a redundant second `⚠ N affected` chip.
  return (
    <span
      role="status"
      className={`inline-flex items-center mono font-medium uppercase text-[9px] tracking-[0.06em] whitespace-nowrap shrink-0 ${cls}`}
      style={{ padding: '3px 7px', borderRadius: '4px' }}
      title={isPartial ? t('status.partial.tooltip') : undefined}
    >
      {isPartial ? `⚠ ${t('status.partial')} · ${partialCount}` : t(`status.${effective}`)}
    </span>
  )
}
