// Settings page — redesigned to match design mockup.
// Segment controls, green toggles, description text, service dots+uptime.

import { useState, useEffect, useRef } from 'react'
import { useLang } from '../hooks/useLang'
import { useTheme } from '../hooks/useTheme'
import { useSettings } from '../hooks/useSettings'
import { VALID_THEMES, VALID_LANGS, VALID_PERIODS, SERVICE_AND_WEBAPP_IDS, AGENT_SERVICE_IDS, ALL_SERVICE_IDS, DEFAULT_SETTINGS } from '../utils/constants'
import { usePolling } from '../hooks/usePolling'
import { trackEvent } from '../utils/analytics'

// ── Styles matching design mockup ────────────────────────

const sectionTitleStyle = { fontFamily: 'var(--font-mono)', fontSize: '9px', color: 'var(--text2)', letterSpacing: '0.12em', textTransform: 'uppercase', paddingBottom: '8px', borderBottom: '1px solid var(--border)', marginBottom: '2px' }

const STATUS_DOT_CLASS = {
  operational: 'bg-[var(--green)]',
  degraded: 'bg-[var(--amber)]',
  down: 'bg-[var(--red)]',
  unknown: 'bg-[var(--text2)]',
}

// ── Sub-components ───────────────────────────────────────

function FieldRow({ label, desc, children, last }) {
  return (
    <div className="flex items-center justify-between" style={{ padding: '13px 0', borderBottom: last ? 'none' : '1px solid var(--border)', gap: '16px' }}>
      <div>
        <div style={{ fontSize: '13px', fontWeight: 500, color: 'var(--text0)', marginBottom: '2px' }}>{label}</div>
        {desc && <div className="mono" style={{ fontSize: '10px', color: 'var(--text2)', lineHeight: 1.5 }}>{desc}</div>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  )
}

// Segment control: bg2 capsule with active: bg4/text0 per design mockup
function SegmentControl({ options, value, onChange }) {
  return (
    <div role="radiogroup" className="flex bg-[var(--bg2)] border border-[var(--border)]" style={{ borderRadius: '6px', padding: '2px', gap: '1px' }}>
      {options.map((opt) => (
        <button
          key={opt.value}
          onClick={() => onChange(opt.value)}
          aria-pressed={value === opt.value}
          className="mono cursor-pointer transition-all whitespace-nowrap"
          style={{
            fontSize: '10px',
            padding: '4px 10px',
            borderRadius: '4px',
            letterSpacing: '0.04em',
            background: value === opt.value ? 'var(--bg4)' : 'transparent',
            color: value === opt.value ? 'var(--text0)' : 'var(--text2)',
            border: 'none',
          }}
        >
          {opt.label}
        </button>
      ))}
    </div>
  )
}

// Toggle: green theme per design mockup (green-dim bg + green border + green knob)
function Toggle({ checked, onChange, disabled }) {
  return (
    <button
      role="switch"
      aria-checked={checked}
      onClick={() => !disabled && onChange(!checked)}
      disabled={disabled}
      className={`relative transition-colors ${disabled ? 'opacity-40 cursor-not-allowed' : 'cursor-pointer'}`}
      style={{
        width: '36px', height: '20px', borderRadius: '20px',
        background: checked ? 'var(--status-bg-green)' : 'var(--bg4)',
        border: `1px solid ${checked ? 'var(--green)' : 'var(--border-hi)'}`,
      }}
    >
      <span
        className="absolute transition-transform"
        style={{
          width: '14px', height: '14px', borderRadius: '50%', top: '2px', left: '2px',
          background: checked ? 'var(--green)' : 'var(--text2)',
          transform: checked ? 'translateX(16px)' : 'translateX(0)',
        }}
      />
    </button>
  )
}

// Coming Soon badge: blue-dim/blue per design mockup
function ComingSoonBadge({ t }) {
  return (
    <span className="mono" style={{ fontSize: '9px', padding: '2px 6px', borderRadius: '3px', background: 'var(--blue-dim)', color: 'var(--blue)', letterSpacing: '0.04em' }}>
      {t('topbar.analyze.soon')}
    </span>
  )
}

// ── Main Component ───────────────────────────────────────

export default function Settings() {
  const { t, lang, setLang } = useLang()
  const { theme, setTheme } = useTheme()
  const { settings, save } = useSettings()
  const { services: rawServices } = usePolling()
  const services = rawServices ?? []

  const [period, setPeriod] = useState(settings.period)
  const [sla, setSla] = useState(settings.sla)
  const [enabledServices, setEnabledServices] = useState(settings.enabledServices)
  const [saved, setSaved] = useState(false)
  const saveTimerRef = useRef(null)

  useEffect(() => () => clearTimeout(saveTimerRef.current), [])
  useEffect(() => {
    setPeriod(settings.period)
    setSla(settings.sla)
    setEnabledServices(settings.enabledServices)
  }, [settings])

  function handleSave() {
    const slaNum = sla === '' ? DEFAULT_SETTINGS.sla : Number(sla)
    save({ period, sla: slaNum, enabledServices })
    trackEvent('save_settings')
    setSaved(true)
    clearTimeout(saveTimerRef.current)
    saveTimerRef.current = setTimeout(() => setSaved(false), 1800)
  }

  function toggleService(id) {
    setEnabledServices((prev) =>
      prev.includes(id) ? prev.filter((s) => s !== id) : [...prev, id]
    )
  }

  // Check if draft differs from saved settings
  const hasNoChanges = period === settings.period
    && sla === settings.sla
    && JSON.stringify([...enabledServices].sort()) === JSON.stringify([...settings.enabledServices].sort())

  // Service data map
  const svcMap = {}
  for (const s of services) svcMap[s.id] = s

  return (
    <div className="flex flex-col" style={{ maxWidth: '640px', gap: '28px' }}>

      {/* ── General ── */}
      <section>
        <div style={sectionTitleStyle}>{t('settings.general')}</div>

        <FieldRow label={t('settings.theme')} desc={t('settings.theme.desc')}>
          <SegmentControl
            value={theme}
            onChange={setTheme}
            options={VALID_THEMES.map((v) => ({ value: v, label: t(`settings.theme.${v}`) }))}
          />
        </FieldRow>

        <FieldRow label={t('settings.language')} desc={t('settings.lang.desc')}>
          <SegmentControl
            value={lang}
            onChange={setLang}
            options={VALID_LANGS.map((v) => ({ value: v, label: v === 'ko' ? '한국어' : 'English' }))}
          />
        </FieldRow>

        <FieldRow label={t('settings.period')} desc={t('settings.period.desc')}>
          <SegmentControl
            value={period}
            onChange={setPeriod}
            options={VALID_PERIODS.map((v) => ({ value: v, label: t(`settings.period.${v}`) }))}
          />
        </FieldRow>

        <FieldRow label={t('settings.sla')} desc={t('settings.sla.desc')}>
          <div className="flex items-center" style={{ gap: '6px' }}>
            <input
              type="number"
              min="0"
              max="100"
              step="0.01"
              value={sla}
              onChange={(e) => {
                const raw = e.target.value
                if (raw === '') { setSla(''); return }
                const v = parseFloat(raw)
                if (!isNaN(v) && v >= 0 && v <= 100) setSla(v)
              }}
              className="mono"
              style={{
                width: '80px', fontSize: '12px', padding: '5px 8px', textAlign: 'right',
                background: 'var(--bg2)', border: '1px solid var(--border-hi)', borderRadius: '5px',
                color: 'var(--text0)', outline: 'none',
              }}
            />
            <span className="mono" style={{ fontSize: '10px', color: 'var(--text2)' }}>%</span>
          </div>
        </FieldRow>
      </section>

      {/* ── Monitoring (API + WebApp) ── */}
      <section>
        <div style={sectionTitleStyle}>{t('settings.monitoring')}</div>
        <div className="mono" style={{ fontSize: '10px', color: 'var(--text2)', padding: '8px 0 10px' }}>
          {t('settings.monitoring.desc')}
        </div>
        <div>
          {SERVICE_AND_WEBAPP_IDS.map((id) => {
            const svc = svcMap[id]
            const dotCls = STATUS_DOT_CLASS[svc?.status] ?? STATUS_DOT_CLASS.unknown
            return (
              <div key={id} className="flex items-center justify-between" style={{ padding: '10px 0', borderBottom: '1px solid var(--border)' }}>
                <div className="flex items-center" style={{ gap: '8px' }}>
                  <span className={`rounded-full shrink-0 ${dotCls}`} style={{ width: '6px', height: '6px' }} />
                  <span style={{ fontSize: '12px', color: 'var(--text0)' }}>{svc?.name ?? id}</span>
                  <span className="mono" style={{ fontSize: '10px', color: 'var(--text2)', marginLeft: '4px' }}>
                    {svc?.uptime30d != null ? `${svc.uptime30d.toFixed(2)}%` : ''}
                  </span>
                </div>
                <Toggle checked={enabledServices.includes(id)} onChange={() => toggleService(id)} />
              </div>
            )
          })}
        </div>
      </section>

      {/* ── Coding Agents ── */}
      <section>
        <div style={sectionTitleStyle}>{t('nav.agents')}</div>
        <div className="mono" style={{ fontSize: '10px', color: 'var(--text2)', padding: '8px 0 10px' }}>
          {t('settings.monitoring.desc')}
        </div>
        <div>
          {AGENT_SERVICE_IDS.map((id) => {
            const svc = svcMap[id]
            const dotCls = STATUS_DOT_CLASS[svc?.status] ?? STATUS_DOT_CLASS.unknown
            return (
              <div key={id} className="flex items-center justify-between" style={{ padding: '10px 0', borderBottom: '1px solid var(--border)' }}>
                <div className="flex items-center" style={{ gap: '8px' }}>
                  <span className={`rounded-full shrink-0 ${dotCls}`} style={{ width: '6px', height: '6px' }} />
                  <span style={{ fontSize: '12px', color: 'var(--text0)' }}>{svc?.name ?? id}</span>
                  <span className="mono" style={{ fontSize: '10px', color: 'var(--text2)', marginLeft: '4px' }}>
                    {svc?.uptime30d != null ? `${svc.uptime30d.toFixed(2)}%` : ''}
                  </span>
                </div>
                <Toggle checked={enabledServices.includes(id)} onChange={() => toggleService(id)} />
              </div>
            )
          })}
        </div>
      </section>

      {/* ── Alerts (Phase 3 — disabled) ── */}
      <section>
        <div className="flex items-center" style={{ ...sectionTitleStyle, gap: '8px' }}>
          <span>{t('settings.alerts')}</span>
          <ComingSoonBadge t={t} />
        </div>

        <div style={{ opacity: 0.42, pointerEvents: 'none' }}>
          <FieldRow label={t('settings.slack')} desc={t('settings.slack.desc')}>
            <input
              type="text"
              disabled
              placeholder="https://hooks.slack.com/..."
              className="mono"
              style={{
                width: '240px', fontSize: '11px', padding: '6px 10px',
                background: 'var(--bg2)', border: '1px solid var(--border-hi)', borderRadius: '5px',
                color: 'var(--text2)', outline: 'none',
              }}
            />
          </FieldRow>

          <FieldRow label={t('settings.alert.condition')} desc={t('settings.alert.condition.desc')}>
            <SegmentControl
              value=""
              onChange={() => {}}
              options={[{ value: 'down', label: t('status.down') }, { value: 'degraded', label: t('status.degraded') }, { value: 'all', label: t('overview.filter.all') }]}
            />
          </FieldRow>

          <FieldRow label={t('settings.alert.target')} desc={t('settings.alert.target.desc')} last>
            <SegmentControl
              value=""
              onChange={() => {}}
              options={[{ value: 'all', label: t('overview.filter.all') }, { value: 'custom', label: t('settings.alert.custom') }]}
            />
          </FieldRow>
        </div>
      </section>

      {/* ── Save ── */}
      <div className="flex items-center justify-end" style={{ gap: '12px' }}>
        <button
          onClick={handleSave}
          disabled={hasNoChanges}
          className="mono"
          style={{
            fontSize: '11px', padding: '5px 14px', borderRadius: '5px', border: 'none',
            background: hasNoChanges ? 'var(--bg3)' : 'var(--green)',
            color: hasNoChanges ? 'var(--text2)' : 'var(--bg0)',
            fontWeight: 500,
            cursor: hasNoChanges ? 'not-allowed' : 'pointer',
            opacity: hasNoChanges ? 0.5 : 1,
            transition: 'background 0.12s',
          }}
          onMouseEnter={(e) => { if (!hasNoChanges) e.target.style.filter = 'brightness(1.1)' }}
          onMouseLeave={(e) => { if (!hasNoChanges) e.target.style.filter = '' }}
        >
          {t('settings.save')}
        </button>
        {saved && (
          <span className="mono text-[var(--green)] animate-[fade-in_0.2s_ease-out]" style={{ fontSize: '11px' }}>
            {t('settings.saved')}
          </span>
        )}
      </div>

    </div>
  )
}
