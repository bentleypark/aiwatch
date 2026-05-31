// Settings page — redesigned to match design mockup.
// Segment controls, green toggles, description text, service dots+uptime.

import { useState, useEffect, useRef } from 'react'
import { useLang } from '../hooks/useLang'
import { useTheme } from '../hooks/useTheme'
import { useSettings } from '../hooks/useSettings'
import { VALID_THEMES, VALID_LANGS, VALID_PERIODS, SERVICE_AND_APP_IDS, AGENT_SERVICE_IDS, ALL_SERVICE_IDS, DEFAULT_SETTINGS, ALL_SERVICES_FEED_URL } from '../utils/constants'
import { usePolling } from '../hooks/usePolling'
import { trackEvent } from '../utils/analytics'
import { subscribeWebhook, updateWebhookFilters, unsubscribeWebhook, getLocalSubStatus, reconcileSubscription } from '../utils/webhookSubscription'

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
  const [discordUrl, setDiscordUrl] = useState(settings.discordUrl)
  const [alertCondition, setAlertCondition] = useState(settings.alertCondition)
  const [alertTarget, setAlertTarget] = useState(settings.alertTarget)
  const [alertServices, setAlertServices] = useState(settings.alertServices)
  const [alertIncidents, setAlertIncidents] = useState(settings.alertIncidents)
  const [saved, setSaved] = useState(false)
  const [testResult, setTestResult] = useState(null) // null | 'sending' | 'ok' | 'error'
  // #486 PR2 — server-side subscription flow state.
  //  subStatus: 'none' | 'pending' | 'confirmed' — UX state for the saved discordUrl (server is
  //  authoritative; this drives which step to show). subAction: transient feedback for the in-flight
  //  subscribe/unsubscribe call.
  const [subStatus, setSubStatus] = useState('none')
  const [subAction, setSubAction] = useState(null) // null | 'subscribing' | 'unsubscribing' | 'error'
  const [monitoringOpen, setMonitoringOpen] = useState(false)
  const [agentsOpen, setAgentsOpen] = useState(false)
  const [alertServicesOpen, setAlertServicesOpen] = useState(true)
  const [rssCopied, setRssCopied] = useState(false)
  const [slackFeedCopied, setSlackFeedCopied] = useState(false)
  const saveTimerRef = useRef(null)
  const errorTimerRef = useRef(null)

  useEffect(() => () => { clearTimeout(saveTimerRef.current); clearTimeout(errorTimerRef.current) }, [])
  useEffect(() => {
    setPeriod(settings.period)
    setSla(settings.sla)
    setEnabledServices(settings.enabledServices)
    setDiscordUrl(settings.discordUrl)
    setAlertCondition(settings.alertCondition)
    setAlertTarget(settings.alertTarget)
    setAlertServices(settings.alertServices)
    setAlertIncidents(settings.alertIncidents)
  }, [settings])

  // Auto-dismiss the subscription error so a stale failure message doesn't linger forever (the user
  // reported it staying on screen). Editing the URL clears it immediately too (input onChange below);
  // this timer covers errors where the URL doesn't change (unsubscribe/reconcile). Re-armed on each
  // new error; cleared on unmount.
  useEffect(() => {
    if (subAction !== 'error') return undefined
    errorTimerRef.current = setTimeout(() => setSubAction(null), 5000)
    return () => clearTimeout(errorTimerRef.current)
  }, [subAction])

  // Reconcile the local subscription status whenever the SAVED discordUrl changes (load + after save).
  // Reads localStorage UX state for that URL's hash; server is the real source of truth.
  useEffect(() => {
    let cancelled = false
    getLocalSubStatus(settings.discordUrl).then((s) => { if (!cancelled) setSubStatus(s) })
    return () => { cancelled = true }
  }, [settings.discordUrl])

  // Copy the feed URL rather than linking it: a feed URL opened directly makes
  // the browser download raw XML. prompt() fallback covers insecure contexts.
  // copy_rss fires only on a confirmed copy (mirrors RssLink in ServiceDetails).
  function copyFeed() {
    const done = () => {
      setRssCopied(true)
      trackEvent('copy_rss', { location: 'settings', service_id: 'all' })
      setTimeout(() => setRssCopied(false), 2000)
    }
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(ALL_SERVICES_FEED_URL).then(done).catch(() => window.prompt(t('settings.rss.prompt'), ALL_SERVICES_FEED_URL))
    } else {
      window.prompt(t('settings.rss.prompt'), ALL_SERVICES_FEED_URL)
    }
  }

  // Slack uses its built-in /feed RSS app (#467) — paste this into any channel. We don't store a
  // Slack webhook; the native slash command + our RSS does the subscription, zero-config.
  const SLACK_FEED_CMD = `/feed subscribe ${ALL_SERVICES_FEED_URL}`
  function copySlackFeed() {
    const done = () => {
      setSlackFeedCopied(true)
      trackEvent('copy_slack_feed', { location: 'settings' })
      setTimeout(() => setSlackFeedCopied(false), 2000)
    }
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(SLACK_FEED_CMD).then(done).catch(() => window.prompt(t('settings.slack.prompt'), SLACK_FEED_CMD))
    } else {
      window.prompt(t('settings.slack.prompt'), SLACK_FEED_CMD)
    }
  }

  // #486 PR2 — "Save settings" now persists ONLY general settings (theme/lang/period/SLA + monitored
  // services). It omits discordUrl + alert filters: useSettings.save() merges, so omitted fields are
  // preserved from existing settings, and the Discord webhook is managed entirely by its own
  // Subscribe / Update / Unsubscribe buttons in the Alerts section.
  function handleSave() {
    const slaNum = sla === '' ? DEFAULT_SETTINGS.sla : Number(sla)
    save({ period, sla: slaNum, enabledServices })
    trackEvent('save_settings')
    setSaved(true)
    clearTimeout(saveTimerRef.current)
    saveTimerRef.current = setTimeout(() => setSaved(false), 1800)
  }

  const currentFilters = () => ({ alertCondition, alertTarget, alertServices, alertIncidents })

  // Persist the Discord URL + filters to localStorage (the subscription's own save path, separate from
  // the general "Save settings" button). Keeps localStorage in sync with what the server subscription
  // holds, so the UI survives reload and the reconcile effect (keyed on settings.discordUrl) works.
  function persistWebhookSettings(url) {
    save({ period, sla: sla === '' ? DEFAULT_SETTINGS.sla : Number(sla), enabledServices, discordUrl: url, ...currentFilters() })
  }

  // Subscribe the current webhook URL: persist URL+filters locally, then send the channel confirm
  // link. Driven by the dedicated Subscribe button — NOT by general Save.
  function handleSubscribe() {
    const url = discordUrl.trim()
    if (!url) return
    const isNewUrl = !settings.discordUrl
    persistWebhookSettings(url)
    setSubAction('subscribing')
    subscribeWebhook(url, currentFilters()).then((res) => {
      if (res.ok) {
        setSubStatus(res.status === 'confirmed' ? 'confirmed' : 'pending')
        setSubAction(null)
        // Track only on a successful subscribe — a 403/502 must not count as a registration. The
        // active-webhook count is now derived server-side from confirmed subscriptions (#486 PR3),
        // so the legacy webhook:reg: ping was removed.
        if (isNewUrl) trackEvent('webhook_register', { type: 'discord' })
      } else setSubAction('error')
    }).catch(() => setSubAction('error'))
  }

  // Push the current alert filters to an already-confirmed subscription (no new confirm code) AND
  // persist them locally so the change sticks across reloads.
  function handleUpdateFilters() {
    if (!settings.discordUrl) return
    persistWebhookSettings(settings.discordUrl)
    setSubAction('subscribing')
    updateWebhookFilters(settings.discordUrl, currentFilters()).then((res) => {
      setSubAction(res.ok ? 'updated' : 'error')
      if (res.ok) { clearTimeout(saveTimerRef.current); saveTimerRef.current = setTimeout(() => setSubAction(null), 1800) }
    }).catch(() => setSubAction('error'))
  }

  // Remove the server-side subscription for the saved URL. Only clears local state on a confirmed
  // server delete (privacy: no false "removed"); on failure keeps 'confirmed' + shows an error.
  function handleUnsubscribe() {
    if (!settings.discordUrl) return
    setSubAction('unsubscribing')
    unsubscribeWebhook(settings.discordUrl).then((res) => {
      if (res.ok) { setSubStatus('none'); setSubAction(null); trackEvent('webhook_remove', { type: 'discord' }) }
      else setSubAction('error')
    }).catch(() => setSubAction('error'))
  }

  // Reconcile after the user clicks the confirm link in their channel (the /confirm page is a
  // separate document and can't signal this SPA). Re-checks server status (side-effect-free) and, if
  // now confirmed, pushes any filters edited during the pending window.
  function handleReconcile() {
    if (!settings.discordUrl) return
    const filters = { alertCondition, alertTarget, alertServices, alertIncidents }
    setSubAction('subscribing')
    reconcileSubscription(settings.discordUrl, filters).then((res) => {
      if (res.ok) {
        // Authoritative server status — confirmed or still pending.
        setSubStatus(res.status)
        // If confirmed but the deferred filter push failed, the sub is live with the OLD filters.
        // Show an error (not a silent success) — filtersDirty is false now (settings.* already
        // persisted), so the [Update alert filters] button wouldn't otherwise prompt a retry.
        setSubAction(res.status === 'confirmed' && res.filtersSynced === false ? 'error' : null)
      } else {
        // Probe failed (transient 502/network). Do NOT touch subStatus — a healthy pending sub must
        // survive a blip. Just surface the error briefly; the pending UI + button stay so they retry.
        setSubAction('error')
      }
    }).catch(() => setSubAction('error'))
  }

  function toggleService(id) {
    setEnabledServices((prev) =>
      prev.includes(id) ? prev.filter((s) => s !== id) : [...prev, id]
    )
  }

  // Per-service alert subscription, shown only when Alert Targets = Custom (#470).
  function toggleAlertService(id) {
    setAlertServices((prev) =>
      prev.includes(id) ? prev.filter((s) => s !== id) : [...prev, id]
    )
  }

  // #486 PR2 — the "Save settings" button now covers ONLY general settings (theme/lang/period/SLA +
  // monitored-service toggles). The Discord webhook URL + its alert filters live in the Alerts section
  // and are persisted by the subscription buttons (Subscribe / Update), so they're excluded here.
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
        <button
          type="button"
          aria-expanded={monitoringOpen}
          onClick={() => setMonitoringOpen(v => !v)}
          className="w-full flex items-center justify-between cursor-pointer"
          style={{ ...sectionTitleStyle, borderBottom: 'none', background: 'none', padding: '0 0 8px', margin: '0 0 2px', textAlign: 'left' }}
        >
          <span>{t('settings.monitoring')} ({SERVICE_AND_APP_IDS.length})</span>
          <svg width="12" height="12" viewBox="0 0 12 12" style={{ color: 'var(--text2)', transition: 'transform 0.2s', transform: monitoringOpen ? 'rotate(180deg)' : 'rotate(0deg)' }}><path d="M2.5 4.5L6 8L9.5 4.5" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round"/></svg>
        </button>
        {monitoringOpen && (
          <div>
            <div className="mono" style={{ fontSize: '10px', color: 'var(--text2)', padding: '8px 0 10px' }}>
              {t('settings.monitoring.desc')}
            </div>
            {SERVICE_AND_APP_IDS.map((id) => {
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
        )}
      </section>

      {/* ── Coding Agents ── */}
      <section>
        <button
          type="button"
          aria-expanded={agentsOpen}
          onClick={() => setAgentsOpen(v => !v)}
          className="w-full flex items-center justify-between cursor-pointer"
          style={{ ...sectionTitleStyle, borderBottom: 'none', background: 'none', padding: '0 0 8px', margin: '0 0 2px', textAlign: 'left' }}
        >
          <span>{t('nav.agents')} ({AGENT_SERVICE_IDS.length})</span>
          <svg width="12" height="12" viewBox="0 0 12 12" style={{ color: 'var(--text2)', transition: 'transform 0.2s', transform: agentsOpen ? 'rotate(180deg)' : 'rotate(0deg)' }}><path d="M2.5 4.5L6 8L9.5 4.5" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round"/></svg>
        </button>
        {agentsOpen && (
          <div>
            <div className="mono" style={{ fontSize: '10px', color: 'var(--text2)', padding: '8px 0 10px' }}>
              {t('settings.monitoring.desc')}
            </div>
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
        )}
      </section>

      {/* ── Save (general settings only — theme/lang/period/SLA + monitored services). The Discord
          webhook + its alert filters are saved separately by the Subscribe/Update buttons in Alerts. */}
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

      {/* ── Alerts ── */}
      <section>
        <div style={sectionTitleStyle}>{t('settings.alerts')}</div>

        {/* RSS — lead with the zero-friction channel (#433/#428): no account, no
            webhook, no PII. Slack/Discord webhooks follow as the power-user path. */}
        <div style={{ padding: '13px 0', borderBottom: '1px solid var(--border)' }}>
          <div style={{ fontSize: '13px', fontWeight: 500, color: 'var(--text0)', marginBottom: '2px', display: 'flex', alignItems: 'center', gap: '6px' }}>
            <svg width="11" height="11" viewBox="0 0 24 24" aria-hidden="true" style={{ fill: 'var(--rss)' }}>
              <circle cx="6.18" cy="17.82" r="2.18" />
              <path d="M4 4.44v2.83c7.03 0 12.73 5.7 12.73 12.73h2.83C19.56 11.4 12.6 4.44 4 4.44zm0 5.66v2.83c3.9 0 7.07 3.17 7.07 7.07h2.83c0-5.47-4.43-9.9-9.9-9.9z" />
            </svg>
            {t('settings.rss')}
          </div>
          <div className="mono" style={{ fontSize: '10px', color: 'var(--text2)', lineHeight: 1.5, marginBottom: '8px' }}>{t('settings.rss.desc')}</div>
          <div className="flex items-center gap-2">
            <input
              type="text"
              readOnly
              value={ALL_SERVICES_FEED_URL}
              onClick={(e) => e.target.select()}
              className="mono"
              style={{
                flex: 1, fontSize: '11px', padding: '6px 10px',
                background: 'var(--bg2)', border: '1px solid var(--border-hi)', borderRadius: '5px',
                color: 'var(--text0)', outline: 'none', boxSizing: 'border-box',
              }}
            />
            <button
              onClick={copyFeed}
              className="mono shrink-0"
              style={{
                fontSize: '11px', padding: '6px 12px', borderRadius: '5px', border: 'none',
                background: rssCopied ? 'var(--green)' : 'var(--bg3)',
                color: rssCopied ? 'var(--bg0)' : 'var(--text1)', cursor: 'pointer',
              }}
            >
              {rssCopied ? t('settings.rss.copied') : t('settings.rss.copy')}
            </button>
          </div>
        </div>

        <div style={{ padding: '13px 0', borderBottom: '1px solid var(--border)' }}>
          <div style={{ fontSize: '13px', fontWeight: 500, color: 'var(--text0)', marginBottom: '2px' }}>{t('settings.slack')}</div>
          <div className="mono" style={{ fontSize: '10px', color: 'var(--text2)', lineHeight: 1.5, marginBottom: '8px' }}>{t('settings.slack.desc')}</div>
          <div className="flex items-center gap-2">
            <input
              type="text"
              readOnly
              value={SLACK_FEED_CMD}
              onClick={(e) => e.target.select()}
              className="mono"
              style={{
                flex: 1, fontSize: '11px', padding: '6px 10px',
                background: 'var(--bg2)', border: '1px solid var(--border-hi)', borderRadius: '5px',
                color: 'var(--text0)', outline: 'none', boxSizing: 'border-box',
              }}
            />
            <button
              onClick={copySlackFeed}
              className="mono shrink-0"
              style={{
                fontSize: '11px', padding: '6px 12px', borderRadius: '5px', border: 'none',
                background: slackFeedCopied ? 'var(--green)' : 'var(--bg3)',
                color: slackFeedCopied ? 'var(--bg0)' : 'var(--text1)', cursor: 'pointer',
              }}
            >
              {slackFeedCopied ? t('settings.rss.copied') : t('settings.rss.copy')}
            </button>
          </div>
        </div>

        <div style={{ padding: '13px 0', borderBottom: '1px solid var(--border)' }}>
          <div style={{ fontSize: '13px', fontWeight: 500, color: 'var(--text0)', marginBottom: '2px' }}>{t('settings.discord')}</div>
          <div className="mono" style={{ fontSize: '10px', color: 'var(--text2)', lineHeight: 1.5, marginBottom: '8px' }}>{t('settings.discord.desc')}</div>
          <input
            type="text"
            value={discordUrl}
            onChange={(e) => { setDiscordUrl(e.target.value); if (subAction === 'error') setSubAction(null) }}
            placeholder="https://discord.com/api/webhooks/..."
            className="mono"
            style={{
              width: '100%', fontSize: '11px', padding: '6px 10px',
              background: 'var(--bg2)', border: '1px solid var(--border-hi)', borderRadius: '5px',
              color: 'var(--text0)', outline: 'none', boxSizing: 'border-box',
            }}
          />
          {/* #486 PR2 — the Discord subscription is managed HERE by its own buttons, fully decoupled
              from the general "Save settings" button. State machine:
                • subscribing/unsubscribing → in-flight text
                • error → error text (retry via Subscribe)
                • updated → transient "filters updated" confirmation
                • url empty or changed-since-subscribe, or status 'none' → [Subscribe]
                • pending (saved url) → "check your channel" + [I've confirmed → reconcile]
                • confirmed (saved url) → "✓ Subscribed" + [Update alert filters] + [Unsubscribe] */}
          {(() => {
            const url = discordUrl.trim()
            const savedMatchesInput = url && url === settings.discordUrl
            const inFlight = subAction === 'subscribing' || subAction === 'unsubscribing'
            // Subscribe shows when there's a URL that isn't an active (pending/confirmed) sub for the
            // SAVED url — i.e. a brand-new URL, a changed URL, or a 'none' status.
            const showSubscribe = url && !inFlight && (!savedMatchesInput || subStatus === 'none')
            // Are the on-screen filters out of sync with what the server subscription holds? settings.*
            // mirrors the last value pushed to the server (persisted by Subscribe/Update), so any diff
            // means there are unsaved filter changes the user must apply via [Update alert filters].
            const filtersDirty = alertCondition !== settings.alertCondition
              || alertTarget !== settings.alertTarget
              || alertIncidents !== settings.alertIncidents
              || JSON.stringify([...alertServices].sort()) !== JSON.stringify([...settings.alertServices].sort())
            return (
              <div style={{ marginTop: '8px' }}>
                {subAction === 'subscribing' && (
                  <div className="mono" style={{ fontSize: '10px', color: 'var(--text2)' }}>{t('settings.discord.subscribing')}</div>
                )}
                {subAction === 'unsubscribing' && (
                  <div className="mono" style={{ fontSize: '10px', color: 'var(--text2)' }}>{t('settings.discord.unsubscribing')}</div>
                )}
                {subAction === 'error' && (
                  <div className="mono" style={{ fontSize: '10px', color: 'var(--red)', marginBottom: '6px' }}>{t('settings.discord.sub.error')}</div>
                )}
                {subAction === 'updated' && (
                  <div className="mono" style={{ fontSize: '10px', color: 'var(--green)' }}>{t('settings.discord.filtersUpdated')}</div>
                )}

                {showSubscribe && (
                  <button
                    type="button"
                    onClick={handleSubscribe}
                    className="mono"
                    style={{ fontSize: '11px', padding: '5px 14px', borderRadius: '5px', border: 'none', background: 'var(--green)', color: 'var(--bg0)', cursor: 'pointer' }}
                  >
                    {t('settings.discord.subscribe')}
                  </button>
                )}

                {!inFlight && savedMatchesInput && subStatus === 'pending' && (
                  <div>
                    <div className="mono" style={{ fontSize: '10px', color: 'var(--amber)', lineHeight: 1.5, marginBottom: '6px' }}>{t('settings.discord.pending')}</div>
                    {filtersDirty && (
                      <div className="mono" style={{ fontSize: '10px', color: 'var(--text2)', lineHeight: 1.5, marginBottom: '6px' }}>{t('settings.discord.pendingDirty')}</div>
                    )}
                    <button
                      type="button"
                      onClick={handleReconcile}
                      className="mono"
                      style={{ fontSize: '10px', padding: 0, background: 'none', border: 'none', cursor: 'pointer', color: 'var(--blue)', textDecoration: 'underline' }}
                    >
                      {t('settings.discord.reconcile')}
                    </button>
                  </div>
                )}

                {!inFlight && savedMatchesInput && subStatus === 'confirmed' && (
                  <div className="flex items-center" style={{ gap: '12px' }}>
                    <span className="mono" style={{ fontSize: '10px', color: 'var(--green)' }}>{t('settings.discord.confirmed')}</span>
                    {filtersDirty ? (
                      // Unsaved filter changes — offer to push them to the server subscription.
                      <button
                        type="button"
                        onClick={handleUpdateFilters}
                        className="mono"
                        style={{ fontSize: '10px', padding: 0, background: 'none', border: 'none', cursor: 'pointer', color: 'var(--blue)', textDecoration: 'underline' }}
                      >
                        {t('settings.discord.updateFilters')}
                      </button>
                    ) : (
                      // In sync with the server — nothing to apply.
                      <span className="mono" style={{ fontSize: '10px', color: 'var(--text2)' }}>{t('settings.discord.filtersSynced')}</span>
                    )}
                    <button
                      type="button"
                      onClick={handleUnsubscribe}
                      className="mono"
                      style={{ fontSize: '10px', padding: 0, background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text2)', textDecoration: 'underline' }}
                    >
                      {t('settings.discord.unsubscribe')}
                    </button>
                  </div>
                )}
              </div>
            )
          })()}

          {/* #486 PR2 — alert filters live INSIDE the Discord block (they only shape Discord webhook
              delivery). Persisted by Subscribe / Update, never by the general Save button. */}
          <div style={{ marginTop: '4px', paddingTop: '4px', borderTop: '1px solid var(--border)' }}>
        <FieldRow label={t('settings.alert.condition')} desc={t('settings.alert.condition.desc')}>
          <SegmentControl
            value={alertCondition}
            onChange={setAlertCondition}
            options={[{ value: 'down', label: t('status.down') }, { value: 'all', label: t('overview.filter.all') }]}
          />
        </FieldRow>

        <FieldRow label={t('settings.alert.target')} desc={t('settings.alert.target.desc')}>
          <SegmentControl
            value={alertTarget}
            onChange={setAlertTarget}
            options={[{ value: 'all', label: t('overview.filter.all') }, { value: 'custom', label: t('settings.alert.custom') }]}
          />
        </FieldRow>

        {/* Per-service picker — only meaningful when Alert Targets = Custom (#470) */}
        {alertTarget === 'custom' && (
          <div style={{ padding: '0 0 13px', borderBottom: '1px solid var(--border)' }}>
            <div className="flex items-center justify-between" style={{ padding: '4px 0 8px' }}>
              <button
                type="button"
                aria-expanded={alertServicesOpen}
                onClick={() => setAlertServicesOpen((v) => !v)}
                className="flex items-center cursor-pointer"
                style={{ gap: '6px', background: 'none', border: 'none', padding: 0, color: 'var(--text1)', fontSize: '11px' }}
              >
                <span>{t('settings.alert.services')} ({alertServices.length}/{ALL_SERVICE_IDS.length})</span>
                <svg width="12" height="12" viewBox="0 0 12 12" style={{ color: 'var(--text2)', transition: 'transform 0.2s', transform: alertServicesOpen ? 'rotate(180deg)' : 'rotate(0deg)' }}><path d="M2.5 4.5L6 8L9.5 4.5" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round"/></svg>
              </button>
              <div className="flex items-center" style={{ gap: '8px' }}>
                <button type="button" onClick={() => setAlertServices([...ALL_SERVICE_IDS])} style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: 'var(--blue)', fontSize: '10px' }}>{t('settings.alert.services.all')}</button>
                <span style={{ color: 'var(--text2)', fontSize: '10px' }}>·</span>
                <button type="button" onClick={() => setAlertServices([])} style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: 'var(--blue)', fontSize: '10px' }}>{t('settings.alert.services.none')}</button>
              </div>
            </div>
            {alertServicesOpen && (
              <div>
                {alertServices.length === 0 && (
                  <div className="mono" style={{ fontSize: '10px', color: 'var(--amber)', padding: '0 0 8px' }}>{t('settings.alert.services.empty')}</div>
                )}
                {ALL_SERVICE_IDS.map((id) => {
                  const svc = svcMap[id]
                  const dotCls = STATUS_DOT_CLASS[svc?.status] ?? STATUS_DOT_CLASS.unknown
                  return (
                    <div key={id} className="flex items-center justify-between" style={{ padding: '8px 0', borderBottom: '1px solid var(--border)' }}>
                      <div className="flex items-center" style={{ gap: '8px' }}>
                        <span className={`rounded-full shrink-0 ${dotCls}`} style={{ width: '6px', height: '6px' }} />
                        <span style={{ fontSize: '12px', color: 'var(--text0)' }}>{svc?.name ?? id}</span>
                      </div>
                      <Toggle checked={alertServices.includes(id)} onChange={() => toggleAlertService(id)} />
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        )}

        <FieldRow label={t('settings.alert.incidents')} desc={t('settings.alert.incidents.desc')} last>
          <Toggle checked={alertIncidents} onChange={() => setAlertIncidents((v) => !v)} />
        </FieldRow>
          </div>

          {discordUrl && (
          <div style={{ marginTop: '12px' }}>
            <button
              onClick={async () => {
                setTestResult('sending')
                const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:8788'
                const apiBase = API_URL.replace('/api/status', '')
                const payload = { embeds: [{ title: t('settings.alert.test.title'), description: t('settings.alert.test.desc'), color: 5814783, footer: { text: 'AIWatch Alert — Test' } }] }
                try {
                  const r = await fetch(`${apiBase}/api/alert`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ webhookUrl: discordUrl, channel: 'discord', payload }) })
                  setTestResult(r.ok ? 'ok' : 'error')
                } catch { setTestResult('error') }
                setTimeout(() => setTestResult(null), 3000)
              }}
              disabled={testResult === 'sending'}
              className="mono"
              style={{
                fontSize: '11px', padding: '5px 14px', borderRadius: '5px', border: 'none',
                background: 'var(--blue)', color: 'var(--bg0)', cursor: 'pointer', opacity: testResult === 'sending' ? 0.6 : 1,
              }}
            >
              {testResult === 'sending' ? t('settings.alert.testing') : testResult === 'ok' ? t('settings.alert.test.ok') : testResult === 'error' ? t('settings.alert.test.error') : t('settings.alert.test')}
            </button>
          </div>
          )}
        </div>
      </section>

    </div>
  )
}
