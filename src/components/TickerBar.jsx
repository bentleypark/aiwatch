// Ticker Bar — auto-scrolling service status strip (desktop only)
// Design: gap 20px, font 11px mono, dot 5px, scrolls 40s linear infinite.

import { useState } from 'react'
import { usePolling } from '../hooks/usePolling'
import { useLang } from '../hooks/useLang'
import { orderServicesForTicker, tickerClassesFor } from '../utils/ticker'

function TickerItem({ name, status }) {
  const { dot: dotCls, text: textCls } = tickerClassesFor(status)
  return (
    <span className={`inline-flex items-center gap-[5px] whitespace-nowrap mono text-[11px] ${textCls}`}>
      <span className={`w-[5px] h-[5px] rounded-full shrink-0 ${dotCls}`} aria-hidden="true" />
      {name}
    </span>
  )
}

export default function TickerBar() {
  const { services: rawServices } = usePolling()
  const { t } = useLang()
  const [paused, setPaused] = useState(false)
  const services = orderServicesForTicker(rawServices)

  if (services.length === 0) {
    return (
      <div className="w-full overflow-hidden h-full flex items-center">
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
    <div className="w-full h-full flex items-center">
      <div className="flex-1 min-w-0 overflow-hidden h-full flex items-center">
        <div className="ticker-track flex gap-5 will-change-transform" data-paused={paused}>
          {renderItems('a')}
          <div aria-hidden="true" className="flex gap-5">
            {renderItems('b')}
          </div>
        </div>
      </div>
      <button
        type="button"
        onClick={() => setPaused((p) => !p)}
        aria-pressed={paused}
        aria-label={t('ticker.pause')}
        title={t('ticker.pause')}
        className="ticker-pause shrink-0 h-full mono text-[11px] text-[var(--text2)] hover:text-[var(--text0)] cursor-pointer border-l border-[var(--border)] bg-[var(--bg1)]"
        style={{ padding: '0 12px' }}
      >
        {paused ? '▶' : '❚❚'}
      </button>
    </div>
  )
}
