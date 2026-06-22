// ReportModal — crowd "Report an issue" input (#575). One modal, two entry points:
//   - Overview: opened with no preset → the user picks a service from the dropdown.
//   - ServiceDetails: opened with `presetServiceId` → the service is fixed (dropdown locked).
// Posts {svcId, category, description} to the worker /api/report-issue. Honest feedback only — NEVER
// a "N reporting" count (the load-bearing #575 constraint; the gated display is a separate surface).
// A localStorage guard mirrors the server's per-IP/day dedup so the UI reflects an already-sent report.

import { useEffect, useMemo, useRef, useState } from 'react'
import Modal from './Modal'
import { useLang } from '../hooks/useLang'
import { trackEvent } from '../utils/analytics'

// Derive the worker origin from VITE_API_URL (points at /api/status) — mirrors useMonthlyArchives.
const API_BASE = (() => {
  const raw = import.meta.env.VITE_API_URL || 'https://aiwatch-worker.p2c2kbf.workers.dev/api/status'
  return raw.replace(/\/api\/status\/?(?:cached\/?)?$/, '')
})()

// Keep ids in sync with worker/src/report.ts REPORT_CATEGORIES.
const CATEGORIES = ['outage', 'degraded', 'errors', 'login', 'other']
const DESC_MAX = 80

export default function ReportModal({ isOpen, onClose, services, presetServiceId }) {
  const { t } = useLang()
  const sortedServices = useMemo(
    () => [...(services ?? [])].sort((a, b) => a.name.localeCompare(b.name)),
    [services],
  )
  const [svcId, setSvcId] = useState(presetServiceId ?? '')
  const [category, setCategory] = useState('outage')
  const [desc, setDesc] = useState('')
  const [state, setState] = useState('idle') // idle | sending | done | error | rateLimited | already
  const descRef = useRef(null)

  // Reset when (re)opened; honor a preset and reflect a prior report for it.
  useEffect(() => {
    if (!isOpen) return
    const initial = presetServiceId ?? ''
    setSvcId(initial)
    setCategory('outage')
    setDesc('')
    setState(initial && alreadyReported(initial) ? 'already' : 'idle')
  }, [isOpen, presetServiceId])

  function alreadyReported(id) {
    try { return !!localStorage.getItem(`aiwatch-reported-${id}`) } catch { return false }
  }

  async function submit() {
    if (!svcId || state === 'sending') return
    if (alreadyReported(svcId)) { setState('already'); return }
    setState('sending')
    try {
      const res = await fetch(`${API_BASE}/api/report-issue`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ svcId, category, description: desc.trim() }),
      })
      if (res.status === 429) { setState('rateLimited'); return }  // per-IP/hour cap — actionable hint
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      try { localStorage.setItem(`aiwatch-reported-${svcId}`, '1') } catch { /* private mode */ }
      trackEvent('report_issue', { location: 'dashboard', service_id: svcId, category })
      setState('done')
      setTimeout(onClose, 1400)
    } catch {
      setState('error')
    }
  }

  if (!isOpen) return null

  const locked = !!presetServiceId
  const lockedName = locked ? (sortedServices.find((s) => s.id === presetServiceId)?.name ?? presetServiceId) : ''

  return (
    <Modal isOpen={isOpen} onClose={onClose} title={t('report.title')}>
      {state === 'already' ? (
        <p className="text-sm text-[var(--text1)]" style={{ padding: '4px 0 8px' }}>{t('report.already')}</p>
      ) : (
        <div className="flex flex-col" style={{ gap: '14px', paddingTop: '4px' }}>
          {/* Service */}
          <div>
            <label className="mono text-[10px] uppercase text-[var(--text2)]" style={{ letterSpacing: '0.08em' }} htmlFor="report-svc">{t('report.service')}</label>
            {locked ? (
              <div className="text-sm text-[var(--text0)]" style={{ marginTop: '6px' }}>{lockedName}</div>
            ) : (
              <select
                id="report-svc"
                value={svcId}
                onChange={(e) => { setSvcId(e.target.value); setState(alreadyReported(e.target.value) ? 'already' : 'idle') }}
                className="w-full bg-[var(--bg0)] border border-[var(--border)] rounded text-[var(--text0)] text-sm"
                style={{ marginTop: '6px', padding: '9px 11px' }}
              >
                <option value="" disabled>{t('report.service.placeholder')}</option>
                {sortedServices.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            )}
          </div>
          {/* Category */}
          <div>
            <label className="mono text-[10px] uppercase text-[var(--text2)]" style={{ letterSpacing: '0.08em' }} htmlFor="report-cat">{t('report.category')}</label>
            <select
              id="report-cat"
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              className="w-full bg-[var(--bg0)] border border-[var(--border)] rounded text-[var(--text0)] text-sm"
              style={{ marginTop: '6px', padding: '9px 11px' }}
            >
              {CATEGORIES.map((c) => <option key={c} value={c}>{t(`report.category.${c}`)}</option>)}
            </select>
          </div>
          {/* Description */}
          <div>
            <div className="flex items-center justify-between">
              <label className="mono text-[10px] uppercase text-[var(--text2)]" style={{ letterSpacing: '0.08em' }} htmlFor="report-desc">{t('report.description')}</label>
              <span className="mono text-[10px] text-[var(--text2)]">{desc.length} / {DESC_MAX}</span>
            </div>
            <textarea
              id="report-desc"
              ref={descRef}
              value={desc}
              maxLength={DESC_MAX}
              onChange={(e) => setDesc(e.target.value)}
              placeholder={t('report.description.placeholder')}
              className="w-full bg-[var(--bg0)] border border-[var(--border)] rounded text-[var(--text0)] text-sm"
              style={{ marginTop: '6px', padding: '9px 11px', minHeight: '64px', resize: 'vertical' }}
            />
          </div>
          {state === 'done' && <p className="text-sm" style={{ color: 'var(--green)' }}>{t('report.thanks')}</p>}
          {state === 'error' && <p className="text-sm" style={{ color: 'var(--amber)' }}>{t('report.error')}</p>}
          {state === 'rateLimited' && <p className="text-sm" style={{ color: 'var(--amber)' }}>{t('report.rateLimited')}</p>}
          <div className="flex" style={{ gap: '10px' }}>
            <button
              type="button"
              onClick={submit}
              disabled={!svcId || state === 'sending' || state === 'done' || state === 'rateLimited'}
              className="flex-1 rounded text-sm font-medium"
              style={{ padding: '10px', background: 'var(--purple)', color: '#fff', opacity: (!svcId || state === 'sending' || state === 'done' || state === 'rateLimited') ? 0.5 : 1 }}
            >
              {state === 'sending' ? t('report.sending') : t('report.submit')}
            </button>
            <button type="button" onClick={onClose} className="rounded text-sm border border-[var(--border)] text-[var(--text1)]" style={{ padding: '10px 16px' }}>
              {t('report.cancel')}
            </button>
          </div>
        </div>
      )}
    </Modal>
  )
}
