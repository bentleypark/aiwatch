// Settings page — theme, language, default period, SLA baseline,
// monitored services toggles, and Phase 3 alerts placeholders.

import { useState, useEffect } from 'react'
import { useLang } from '../hooks/useLang'
import { useTheme } from '../hooks/useTheme'
import { useSettings } from '../hooks/useSettings'
import { VALID_THEMES, VALID_LANGS, VALID_PERIODS, ALL_SERVICE_IDS, DEFAULT_SETTINGS } from '../utils/constants'
import { usePolling } from '../hooks/usePolling'

// ── Sub-components ───────────────────────────────────────────

function SectionTitle({ children }) {
  return (
    <h2 className="text-xs mono text-[var(--text2)] uppercase tracking-wider mb-4">
      {children}
    </h2>
  )
}

function FieldRow({ label, children }) {
  return (
    <div className="flex items-center justify-between gap-4 py-3 border-b border-[var(--border)] last:border-0">
      <span className="text-sm text-[var(--text1)]">{label}</span>
      <div className="flex items-center gap-2">{children}</div>
    </div>
  )
}

function OptionButton({ active, onClick, children }) {
  return (
    <button
      onClick={onClick}
      className={`px-3 py-1.5 text-xs mono rounded transition-colors ${
        active
          ? 'bg-[var(--blue)] text-[var(--bg0)]'
          : 'bg-[var(--bg2)] text-[var(--text2)] hover:text-[var(--text1)]'
      }`}
    >
      {children}
    </button>
  )
}

function Toggle({ checked, onChange, disabled }) {
  return (
    <button
      onClick={() => !disabled && onChange(!checked)}
      disabled={disabled}
      className={`relative w-9 h-5 rounded-full transition-colors ${
        disabled ? 'opacity-40 cursor-not-allowed' : 'cursor-pointer'
      } ${checked ? 'bg-[var(--blue)]' : 'bg-[var(--bg3)]'}`}
    >
      <span
        className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-[var(--bg0)] transition-transform ${
          checked ? 'translate-x-4' : ''
        }`}
      />
    </button>
  )
}

function DisabledBadge({ t }) {
  return (
    <span className="text-[10px] mono px-2 py-0.5 rounded bg-[var(--bg3)] text-[var(--amber)]">
      {t('topbar.analyze.soon')}
    </span>
  )
}

// ── Main Component ───────────────────────────────────────────

export default function Settings() {
  const { t, lang, setLang } = useLang()
  const { theme, setTheme } = useTheme()
  const { settings, save } = useSettings()
  const { services: rawServices } = usePolling()
  const services = rawServices ?? []

  // Local draft state (saved on explicit Save click)
  const [period, setPeriod] = useState(settings.period)
  const [sla, setSla] = useState(settings.sla)
  const [enabledServices, setEnabledServices] = useState(settings.enabledServices)

  // Save feedback
  const [saved, setSaved] = useState(false)

  // Sync local state if settings change externally
  useEffect(() => {
    setPeriod(settings.period)
    setSla(settings.sla)
    setEnabledServices(settings.enabledServices)
  }, [settings])

  function handleSave() {
    const slaNum = sla === '' ? DEFAULT_SETTINGS.sla : Number(sla)
    save({ period, sla: slaNum, enabledServices })
    setSaved(true)
    setTimeout(() => setSaved(false), 1800)
  }

  function toggleService(id) {
    setEnabledServices((prev) =>
      prev.includes(id) ? prev.filter((s) => s !== id) : [...prev, id]
    )
  }

  // Build service name map from polling data
  const nameMap = {}
  for (const s of services) nameMap[s.id] = s.name

  return (
    <div className="p-4 md:p-6 space-y-6 max-w-2xl">

      {/* ── General ── */}
      <section className="bg-[var(--bg1)] border border-[var(--border)] rounded p-4">
        <SectionTitle>{t('settings.general')}</SectionTitle>

        <FieldRow label={t('settings.theme')}>
          {VALID_THEMES.map((v) => (
            <OptionButton key={v} active={theme === v} onClick={() => setTheme(v)}>
              {t(`settings.theme.${v}`)}
            </OptionButton>
          ))}
        </FieldRow>

        <FieldRow label={t('settings.language')}>
          {VALID_LANGS.map((v) => (
            <OptionButton key={v} active={lang === v} onClick={() => setLang(v)}>
              {v === 'ko' ? '한국어' : 'English'}
            </OptionButton>
          ))}
        </FieldRow>

        <FieldRow label={t('settings.period')}>
          {VALID_PERIODS.map((v) => (
            <OptionButton key={v} active={period === v} onClick={() => setPeriod(v)}>
              {t(`settings.period.${v}`)}
            </OptionButton>
          ))}
        </FieldRow>

        <FieldRow label={t('settings.sla')}>
          <div className="flex items-center gap-1.5">
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
              className="w-20 px-2 py-1.5 text-xs mono text-right rounded
                         bg-[var(--bg2)] border border-[var(--border)] text-[var(--text1)]
                         focus:border-[var(--blue)] focus:outline-none"
            />
            <span className="text-xs mono text-[var(--text2)]">%</span>
          </div>
        </FieldRow>
      </section>

      {/* ── Monitoring ── */}
      <section className="bg-[var(--bg1)] border border-[var(--border)] rounded p-4">
        <SectionTitle>{t('settings.monitoring')}</SectionTitle>
        <div className="space-y-0">
          {ALL_SERVICE_IDS.map((id) => (
            <div
              key={id}
              className="flex items-center justify-between py-2.5 border-b border-[var(--border)] last:border-0"
            >
              <span className="text-sm text-[var(--text1)]">
                {nameMap[id] || id}
              </span>
              <Toggle
                checked={enabledServices.includes(id)}
                onChange={() => toggleService(id)}
              />
            </div>
          ))}
        </div>
      </section>

      {/* ── Alerts (Phase 3 — disabled) ── */}
      <section className="bg-[var(--bg1)] border border-[var(--border)] rounded p-4 opacity-60">
        <div className="flex items-center gap-3 mb-4">
          <SectionTitle>{t('settings.alerts')}</SectionTitle>
          <DisabledBadge t={t} />
        </div>

        <FieldRow label={t('settings.slack')}>
          <input
            type="text"
            disabled
            placeholder="https://hooks.slack.com/..."
            className="w-48 px-2 py-1.5 text-xs mono rounded
                       bg-[var(--bg2)] border border-[var(--border)] text-[var(--text2)]
                       cursor-not-allowed"
          />
        </FieldRow>

        <FieldRow label={t('settings.alert.condition')}>
          <DisabledBadge t={t} />
        </FieldRow>

        <FieldRow label={t('settings.alert.target')}>
          <DisabledBadge t={t} />
        </FieldRow>
      </section>

      {/* ── Save ── */}
      <div className="flex items-center gap-3">
        <button
          onClick={handleSave}
          className="px-5 py-2 text-sm mono rounded bg-[var(--blue)] text-white
                     hover:opacity-90 transition-opacity text-[var(--bg0)]"
        >
          {t('settings.save')}
        </button>
        {saved && (
          <span className="text-sm mono text-[var(--green)] animate-[fade-in_0.2s_ease-out]">
            {t('settings.saved')}
          </span>
        )}
      </div>

    </div>
  )
}
