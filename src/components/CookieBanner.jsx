import { useState } from 'react'
import { createPortal } from 'react-dom'
import { useLang } from '../hooks/useLang'
import { hasConsent, setConsent } from '../utils/analytics'

export default function CookieBanner() {
  const { t } = useLang()
  const [visible, setVisible] = useState(() => hasConsent() === null)

  if (!visible) return null

  const handleAccept = () => {
    setConsent(true)
    setVisible(false)
  }

  const handleEssentialOnly = () => {
    setConsent(false)
    setVisible(false)
  }

  return createPortal(
    <div style={{
      position: 'fixed', bottom: 0, left: 0, right: 0, zIndex: 9999,
      background: 'var(--bg1)', borderTop: '1px solid var(--border)',
      padding: '14px 20px',
    }}>
      <div style={{ maxWidth: '900px', margin: '0 auto' }}>
        <p className="text-xs text-[var(--text0)] font-medium" style={{ marginBottom: '6px' }}>
          {t('cookie.title')}
        </p>
        <p className="text-[11px] text-[var(--text2)]" style={{ lineHeight: '1.5', marginBottom: '10px' }}>
          {t('cookie.description')}
        </p>
        <div className="flex gap-2">
          <button
            onClick={handleEssentialOnly}
            className="mono text-[11px] text-[var(--text1)] hover:text-[var(--text0)] cursor-pointer transition-colors"
            style={{ padding: '6px 14px', borderRadius: '4px', border: '1px solid var(--border)' }}>
            {t('cookie.essential')}
          </button>
          <button
            onClick={handleAccept}
            className="mono text-[11px] text-[var(--bg0)] bg-[var(--green)] hover:opacity-90 cursor-pointer transition-opacity"
            style={{ padding: '6px 14px', borderRadius: '4px' }}>
            {t('cookie.accept')}
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}
