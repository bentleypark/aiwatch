// Ticker Bar — auto-scrolling service status strip (desktop only)
// Design: gap 20px, font 11px mono, dot 5px, scrolls 40s linear infinite.

import { usePolling } from '../hooks/usePolling'

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
  const services = rawServices ?? []

  // Use polling data if available, otherwise minimal placeholder
  const items = services.length > 0
    ? services.map((s) => ({ id: s.id, name: s.name, status: s.status }))
    : [{ id: 'loading', name: '...', status: 'operational' }]

  return (
    <div className="w-full overflow-hidden h-full flex items-center pl-5">
      <div
        className="flex gap-5 will-change-transform"
        style={{ animation: 'ticker-scroll 40s linear infinite' }}
      >
        {items.map((svc) => (
          <TickerItem key={svc.id} name={svc.name} status={svc.status} />
        ))}
        {/* Duplicate for seamless loop */}
        <div aria-hidden="true" className="flex gap-5">
          {items.map((svc) => (
            <TickerItem key={`${svc.id}:dup`} name={svc.name} status={svc.status} />
          ))}
        </div>
      </div>
    </div>
  )
}
