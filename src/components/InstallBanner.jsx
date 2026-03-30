import { useState, useEffect, useCallback } from 'react'
import { useLang } from '../hooks/useLang'

const DISMISS_KEY = 'aiwatch-install-dismissed'
const VISITS_KEY = 'aiwatch-visits'
const MIN_VISITS = 2
const SHOW_DELAY = 10000 // 10 seconds

function isIOS() {
  return /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream
}

// Capture beforeinstallprompt at module level — it fires early, before React mounts
let earlyPrompt = null
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault()
  earlyPrompt = e
})

const bannerOuter = { position: 'fixed', bottom: 80, left: '50%', transform: 'translateX(-50%)', zIndex: 900, width: '90%', maxWidth: 400 }
const bannerInner = { background: 'var(--bg2)', border: '1px solid var(--border-hi)', borderRadius: 10, padding: '14px 18px', boxShadow: '0 4px 24px var(--bg0)' }
const closeBtn = { background: 'none', border: 'none', color: 'var(--text2)', cursor: 'pointer', fontSize: 16, padding: '0 4px', lineHeight: 1 }

export default function InstallBanner() {
  const { t } = useLang()
  const [deferredPrompt, setDeferredPrompt] = useState(null)
  const [showIOS, setShowIOS] = useState(false)

  useEffect(() => {
    if (localStorage.getItem(DISMISS_KEY)) return

    // Track visits
    const visits = parseInt(localStorage.getItem(VISITS_KEY) || '0', 10) + 1
    localStorage.setItem(VISITS_KEY, String(visits))
    if (visits < MIN_VISITS) return

    // Already installed as PWA
    if (window.matchMedia('(display-mode: standalone)').matches) return

    if (isIOS()) {
      const timer = setTimeout(() => setShowIOS(true), SHOW_DELAY)
      return () => clearTimeout(timer)
    }

    // Use early-captured prompt or listen for late arrival
    const show = (prompt) => setTimeout(() => setDeferredPrompt(prompt), SHOW_DELAY)

    if (earlyPrompt) {
      const timer = show(earlyPrompt)
      return () => clearTimeout(timer)
    }

    let timer
    const handler = (e) => {
      e.preventDefault()
      timer = show(e)
    }
    window.addEventListener('beforeinstallprompt', handler)

    return () => {
      window.removeEventListener('beforeinstallprompt', handler)
      clearTimeout(timer)
    }
  }, [])

  const handleInstall = useCallback(async () => {
    if (!deferredPrompt) return
    deferredPrompt.prompt()
    const { outcome } = await deferredPrompt.userChoice
    if (outcome === 'accepted') {
      localStorage.setItem(DISMISS_KEY, '1')
    }
    setDeferredPrompt(null)
  }, [deferredPrompt])

  const handleDismiss = useCallback(() => {
    localStorage.setItem(DISMISS_KEY, '1')
    setDeferredPrompt(null)
    setShowIOS(false)
  }, [])

  const logo = (
    <img src="/favicon.png" alt="AIWatch" width={28} height={28} style={{ borderRadius: 6 }} />
  )

  // Android/Desktop: beforeinstallprompt based
  if (deferredPrompt) {
    return (
      <div style={bannerOuter}>
        <div style={{ ...bannerInner, display: 'flex', alignItems: 'center', gap: 12 }}>
          {logo}
          <div style={{ flex: 1, minWidth: 0 }}>
            <p className="mono" style={{ fontSize: 12, fontWeight: 600, color: 'var(--text0)', marginBottom: 2 }}>
              {t('install.title')}
            </p>
            <p style={{ fontSize: 11, color: 'var(--text2)' }}>
              {t('install.desc')}
            </p>
          </div>
          <button
            onClick={handleInstall}
            style={{ padding: '6px 14px', background: 'var(--green)', color: 'var(--bg0)', border: 'none', borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap' }}
          >
            {t('install.btn')}
          </button>
          <button onClick={handleDismiss} style={closeBtn} aria-label="Close">✕</button>
        </div>
      </div>
    )
  }

  // iOS: manual instruction
  if (showIOS) {
    return (
      <div style={bannerOuter}>
        <div style={bannerInner}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'start', marginBottom: 8 }}>
            {logo}
            <button onClick={handleDismiss} style={closeBtn} aria-label="Close">✕</button>
          </div>
          <p className="mono" style={{ fontSize: 12, fontWeight: 600, color: 'var(--text0)', marginBottom: 6 }}>
            {t('install.title')}
          </p>
          <p style={{ fontSize: 11, color: 'var(--text1)', lineHeight: 1.5 }}>
            {t('install.ios')}
          </p>
        </div>
      </div>
    )
  }

  return null
}
