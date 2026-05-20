import { useState } from 'react'
import { useLang } from '../hooks/useLang'
import { trackEvent } from '../utils/analytics'

// RSS copy affordance — copies a feed URL to the clipboard with a prompt()
// fallback, fires a copy_rss GA4 event on success, and tints green briefly.
// Two modes (#433):
//   • bare icon (no `label`)   — passive, space-tight surfaces (sidebar footer)
//   • icon + label (`label`)   — a visible CTA link (incident banner) where a
//                                bare glyph gets lost at the peak-intent moment
// Richer layouts (ServiceDetails RssLink, Settings Alerts row) keep their own markup.
export default function RssCopyIcon({ url, location, serviceId = 'all', size = 12, label }) {
  const { t } = useLang()
  const [copied, setCopied] = useState(false)

  const handleCopy = (e) => {
    // Banner/sidebar icons live inside other clickable rows — don't bubble.
    e.stopPropagation()
    const done = () => {
      setCopied(true)
      trackEvent('copy_rss', { location, service_id: serviceId })
      setTimeout(() => setCopied(false), 2000)
    }
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(url).then(done).catch(() => window.prompt(t('rss.copy.prompt'), url))
    } else {
      window.prompt(t('rss.copy.prompt'), url)
    }
  }

  const color = copied ? 'var(--green)' : 'var(--rss)'

  return (
    <button
      type="button"
      onClick={handleCopy}
      title={t('rss.copy.title')}
      // With a visible label the text is the accessible name (WCAG); only the
      // bare-icon mode needs an aria-label.
      aria-label={label ? undefined : t('rss.copy.title')}
      className={label ? 'inline-flex items-center hover:underline' : ''}
      style={label
        ? { background: 'none', border: 'none', padding: 0, cursor: 'pointer', gap: '4px', color, font: 'inherit' }
        : { background: 'none', border: 'none', padding: 0, cursor: 'pointer', display: 'inline-flex', lineHeight: 0 }}
    >
      <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" style={{ fill: color, flexShrink: 0 }}>
        <circle cx="6.18" cy="17.82" r="2.18" />
        <path d="M4 4.44v2.83c7.03 0 12.73 5.7 12.73 12.73h2.83C19.56 11.4 12.6 4.44 4 4.44zm0 5.66v2.83c3.9 0 7.07 3.17 7.07 7.07h2.83c0-5.47-4.43-9.9-9.9-9.9z" />
      </svg>
      {label && <span>{copied ? t('rss.copy.copied') : label}</span>}
    </button>
  )
}
