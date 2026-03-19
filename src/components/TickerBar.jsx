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

  const apiItems = services.filter((s) => s.category !== 'agent')
  const agentItems = services.filter((s) => s.category === 'agent')

  if (services.length === 0) {
    return (
      <div className="w-full overflow-hidden h-full flex items-center pl-5">
        <span className="mono text-[11px] text-[var(--text2)]">...</span>
      </div>
    )
  }

  const separator = <span style={{ color: 'var(--border-hi)', margin: '0 6px' }}>|</span>

  const renderItems = (prefix) => (
    <>
      {apiItems.map((svc) => (
        <TickerItem key={`${prefix}-${svc.id}`} name={svc.name} status={svc.status} />
      ))}
      {agentItems.length > 0 && separator}
      {agentItems.map((svc) => (
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
