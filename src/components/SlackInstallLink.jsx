import { useLang } from '../hooks/useLang'
import { trackEvent } from '../utils/analytics'
import { slackInstallUrl } from '../../api/_shared/slack-install'

// #1581 — "Add to Slack": a link to the worker's install route, which opens Slack's own channel
// picker. Bare icon (no `label`) for space-tight surfaces; icon + label as a visible CTA.
export default function SlackInstallLink({ location, serviceIds = [], size = 12, label, muted = false }) {
  const { t } = useLang()
  const serviceId = serviceIds.length === 1 ? serviceIds[0] : 'all'
  return (
    <a
      href={slackInstallUrl(serviceIds)}
      onClick={(e) => {
        e.stopPropagation()
        trackEvent('click_add_to_slack', { location, service_id: serviceId })
      }}
      title={t('slack.install.title')}
      aria-label={label ? undefined : t('slack.install.title')}
      className={!label ? '' : muted ? 'inline-flex items-center text-[var(--text2)] hover:text-[var(--text0)]' : 'inline-flex items-center hover:underline'}
      style={label
        ? { gap: '4px', textDecoration: 'none', ...(muted ? {} : { color: 'var(--text0)' }) }
        : { display: 'inline-flex', lineHeight: 0 }}
    >
      <SlackLogo size={size} />
      {label && <span>{label}</span>}
    </a>
  )
}

export function SlackLogo({ size = 12 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" style={{ flexShrink: 0 }}>
      <path fill="var(--slack-red)" d="M5.04 15.17a2.53 2.53 0 1 1-2.52-2.52h2.52v2.52zm1.27 0a2.53 2.53 0 0 1 5.05 0v6.3a2.53 2.53 0 1 1-5.05 0v-6.3z" />
      <path fill="var(--slack-blue)" d="M8.83 5.04a2.53 2.53 0 1 1 2.53-2.52v2.52H8.83zm0 1.27a2.53 2.53 0 0 1 0 5.05H2.52a2.53 2.53 0 0 1 0-5.05h6.31z" />
      <path fill="var(--slack-green)" d="M18.96 8.83a2.53 2.53 0 1 1 2.52 2.53h-2.52V8.83zm-1.27 0a2.53 2.53 0 0 1-5.05 0V2.52a2.53 2.53 0 1 1 5.05 0v6.31z" />
      <path fill="var(--slack-yellow)" d="M15.17 18.96a2.53 2.53 0 1 1-2.53 2.52v-2.52h2.53zm0-1.27a2.53 2.53 0 0 1 0-5.05h6.31a2.53 2.53 0 1 1 0 5.05h-6.31z" />
    </svg>
  )
}
