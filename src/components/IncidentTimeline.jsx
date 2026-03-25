// IncidentTimeline — shared accordion detail panel for incident timelines
// Used in: Incidents, Overview, ServiceDetails pages

import { useRef, useEffect } from 'react'

const STAGE_DOT = {
  investigating: 'bg-[var(--amber)]',
  identified:    'bg-[var(--blue)]',
  monitoring:    'bg-[var(--teal)]',
  resolved:      'bg-[var(--green)]',
}

const STAGE_TEXT = {
  investigating: 'text-[var(--amber)]',
  identified:    'text-[var(--blue)]',
  monitoring:    'text-[var(--teal)]',
  resolved:      'text-[var(--green)]',
}

function formatDate(iso, lang) {
  if (!iso) return ''
  const d = new Date(iso)
  if (isNaN(d.getTime())) return ''
  return d.toLocaleString(lang === 'ko' ? 'ko-KR' : 'en-US', {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
    timeZoneName: 'short',
  })
}

function TimelineStep({ stage, text, at, isLast, t, lang }) {
  return (
    <div className="flex gap-[14px]">
      <div className="flex flex-col items-center w-[14px] shrink-0">
        <span className={`w-2.5 h-2.5 rounded-full shrink-0 mt-[3px] ${STAGE_DOT[stage] ?? 'bg-[var(--text2)]'}`} />
        {!isLast && <div className="w-px flex-1 bg-[var(--border)] my-[3px] min-h-[16px]" />}
      </div>
      <div className="pb-4">
        <p className={`mono font-medium text-[10px] mb-[3px] ${STAGE_TEXT[stage] ?? 'text-[var(--text2)]'}`}>{t(`incidents.timeline.${stage}`)}</p>
        {text && <p className="text-xs text-[var(--text1)] mb-[3px]" style={{ lineHeight: 1.6 }}>{text}</p>}
        <p className="mono text-[10px] text-[var(--text2)]">{formatDate(at, lang)}</p>
      </div>
    </div>
  )
}

export default function IncidentTimeline({ title, subtitle, timeline, onClose, t, lang }) {
  const panelRef = useRef(null)
  useEffect(() => {
    const timer = setTimeout(() => {
      panelRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
    }, 50)
    return () => clearTimeout(timer)
  }, [title])

  return (
    <div ref={panelRef} className="bg-[var(--bg1)] border border-[var(--border)] rounded-lg overflow-hidden mt-2">
      <div className="flex items-start justify-between border-b border-[var(--border)]" style={{ padding: '14px 16px' }}>
        <div>
          <p className="text-sm font-medium text-[var(--text0)] mb-1">{title}</p>
          <p className="mono text-[10px] text-[var(--text2)]">{subtitle}</p>
        </div>
        <button
          onClick={(e) => { e.stopPropagation(); onClose() }}
          className="shrink-0 mono text-[11px] text-[var(--text1)] bg-[var(--bg2)] border border-[var(--border)] rounded hover:opacity-80 transition-opacity cursor-pointer"
          style={{ padding: '4px 10px' }}
          aria-label={t('modal.close')}
        >
          ✕ {t('modal.close')}
        </button>
      </div>
      <div style={{ padding: '20px 24px' }}>
        {(timeline ?? []).length === 0 ? (
          <p className="text-xs text-[var(--text2)]">{t('incidents.timeline.empty')}</p>
        ) : (
          timeline.map((step, i) => (
            <TimelineStep
              key={`${step.stage}-${i}`}
              stage={step.stage}
              text={step.text}
              at={step.at}
              isLast={i === timeline.length - 1}
              t={t}
              lang={lang}
            />
          ))
        )}
      </div>
    </div>
  )
}
