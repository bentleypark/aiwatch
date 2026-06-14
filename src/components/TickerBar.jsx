// Ticker Bar — auto-scrolling service status strip (desktop only)
// Design: gap 20px, font 11px mono, dot 5px, scrolls 40s linear infinite.

import { usePolling } from '../hooks/usePolling'
import { SERVICE_CATEGORIES } from '../utils/constants'

// Ticker follows the dev-audience category order (#658): LLM APIs → Coding Agents → Voice →
// Inference & Infra → Video → AI Apps. Flatten SERVICE_CATEGORIES (minus the 'all' meta-bucket)
// into a single id sequence so the strip scrolls in that order — no group dividers (continuous
// stream). A service missing from the map sorts to the end (defensive; the partition test pins
// SERVICE_CATEGORIES to the full service set).
const TICKER_ORDER_INDEX = new Map(
  Object.keys(SERVICE_CATEGORIES)
    .filter((k) => k !== 'all')
    .flatMap((k) => SERVICE_CATEGORIES[k].ids)
    .map((id, i) => [id, i]),
)

// Sort a raw services array into the dev-audience ticker order (#658). Pure + exported so the
// ordering invariant (Coding Agents follow LLM APIs, AI Apps last) is unit-testable without
// rendering the component. Non-mutating; unknown ids sort to the end.
export function orderServicesForTicker(rawServices) {
  return [...(rawServices ?? [])].sort(
    (a, b) =>
      (TICKER_ORDER_INDEX.get(a.id) ?? Number.MAX_SAFE_INTEGER) -
      (TICKER_ORDER_INDEX.get(b.id) ?? Number.MAX_SAFE_INTEGER),
  )
}

const STATUS_DOT_CLASS = {
  operational: 'bg-[var(--green)]',
  degraded: 'bg-[var(--amber)]',
  down: 'bg-[var(--red)]',
}

const STATUS_TEXT_CLASS = {
  operational: 'text-[var(--text1)]',
  degraded: 'text-[var(--amber)]',
  down: 'text-[var(--red)]',
}

function TickerItem({ name, status }) {
  const dotCls = STATUS_DOT_CLASS[status] ?? STATUS_DOT_CLASS.operational
  const textCls = STATUS_TEXT_CLASS[status] ?? STATUS_TEXT_CLASS.operational
  return (
    <span className={`inline-flex items-center gap-[5px] whitespace-nowrap mono text-[11px] ${textCls}`}>
      <span className={`w-[5px] h-[5px] rounded-full shrink-0 ${dotCls}`} aria-hidden="true" />
      {name}
    </span>
  )
}

export default function TickerBar() {
  const { services: rawServices } = usePolling()
  const services = orderServicesForTicker(rawServices)

  if (services.length === 0) {
    return (
      <div className="w-full overflow-hidden h-full flex items-center pl-5">
        <span className="mono text-[11px] text-[var(--text2)]">...</span>
      </div>
    )
  }

  const renderItems = (prefix) => (
    <>
      {services.map((svc) => (
        <TickerItem key={`${prefix}-${svc.id}`} name={svc.name} status={svc.status} />
      ))}
    </>
  )

  return (
    <div className="w-full overflow-hidden h-full flex items-center pl-5">
      <div
        className="flex gap-5 will-change-transform"
        style={{ animation: 'ticker-scroll 50s linear infinite' }}
      >
        {renderItems('a')}
        <div aria-hidden="true" className="flex gap-5">
          {renderItems('b')}
        </div>
      </div>
    </div>
  )
}
