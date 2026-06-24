// RecentUserReports — renders the GATED crowd-report feed (#575). The worker only includes a
// service's reports in `reportFeed` when an independent signal corroborates a problem, so anything
// passed here is already gated — this is pure display. Used by the Overview panel (multi-service,
// pass serviceName per row) and the ServiceDetails section (single service, serviceName omitted).
// Descriptions are rendered as text (React escapes) — no innerHTML.
//
// Shows the first PREVIEW rows + a "Show N more"/"Show less" toggle for the rest (same 5-row preview
// as the incident lists, #incident-history-collapse), so a busy service doesn't dump 20 rows.

import { useState } from 'react'
import { useLang } from '../hooks/useLang'

const PREVIEW = 5

function relTime(ts, now) {
  const m = Math.max(0, Math.round((now - ts) / 60_000))
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m ago`
  return `${Math.floor(m / 60)}h ago`
}

/**
 * @param {{items: Array<{serviceName?: string, cat: string, desc: string, ts: number}>}} props
 */
export default function RecentUserReports({ items }) {
  const { t } = useLang()
  const [expanded, setExpanded] = useState(false)
  const now = Date.now()
  if (!items || items.length === 0) return null
  const visible = expanded ? items : items.slice(0, PREVIEW)
  const hidden = items.length - visible.length
  return (
    <div className="flex flex-col" style={{ gap: '8px' }}>
      <p className="text-[11px] text-[var(--text2)]" style={{ lineHeight: 1.5 }}>{t('report.feed.note')}</p>
      {visible.map((r, i) => (
        <div key={`${r.ts}-${r.cat}-${i}`} className="flex items-baseline justify-between" style={{ gap: '10px', padding: '6px 0', borderBottom: '1px solid var(--border)' }}>
          <div className="text-[13px] text-[var(--text0)]" style={{ minWidth: 0 }}>
            {r.serviceName && <span className="text-[var(--text2)]">{r.serviceName} · </span>}
            <span className="font-medium">{t(`report.category.${r.cat}`)}</span>
            {r.desc && <span className="text-[var(--text1)]"> — {r.desc}</span>}
          </div>
          <span className="mono text-[10px] text-[var(--text2)] shrink-0">{relTime(r.ts, now)}</span>
        </div>
      ))}
      {items.length > PREVIEW && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          className="mono text-[10px] text-[var(--text2)] hover:text-[var(--text1)] uppercase tracking-wider flex items-center gap-1.5 self-start"
          style={{ padding: '6px 2px' }}
        >
          <span aria-hidden="true">{expanded ? '▴' : '▾'}</span>
          {expanded ? t('svc.incidents.showLess') : t('svc.incidents.showMore').replace('{n}', String(hidden))}
        </button>
      )}
    </div>
  )
}
