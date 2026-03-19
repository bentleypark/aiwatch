// Modal — accessible overlay dialog
// Closes on: backdrop click, ESC key, ✕ button
// Focus is trapped inside the dialog while open; restored to prior element on close.

import { useEffect, useId, useRef } from 'react'
import { useLang } from '../hooks/useLang'

// Selectors for focusable elements within the dialog
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), ' +
  'select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

export default function Modal({ isOpen, onClose, title, children }) {
  const { t } = useLang()
  const titleId = useId()
  const panelRef = useRef(null)

  // onCloseRef avoids re-running the effect when parent re-renders with new onClose reference
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose

  useEffect(() => {
    if (!isOpen) return

    const previouslyFocused = document.activeElement
    // Move focus into dialog on open
    const initialFocusable = panelRef.current
      ? Array.from(panelRef.current.querySelectorAll(FOCUSABLE))
      : []
    initialFocusable[0]?.focus()

    function onKeyDown(e) {
      if (e.key === 'Escape') { onCloseRef.current(); return }
      // Re-query focusable elements each time (content may have changed)
      const focusable = panelRef.current
        ? Array.from(panelRef.current.querySelectorAll(FOCUSABLE))
        : []
      if (e.key !== 'Tab' || focusable.length === 0) return
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (e.shiftKey) {
        if (document.activeElement === first) { e.preventDefault(); last.focus() }
      } else {
        if (document.activeElement === last) { e.preventDefault(); first.focus() }
      }
    }

    document.addEventListener('keydown', onKeyDown)
    document.body.style.overflow = 'hidden'

    return () => {
      document.removeEventListener('keydown', onKeyDown)
      document.body.style.overflow = ''
      previouslyFocused?.focus()
    }
  }, [isOpen])

  if (!isOpen) return null

  return (
    // Clicking the backdrop closes the modal; clicking the panel does not propagate
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/60"
      onClick={onClose}
      aria-modal="true"
      role="dialog"
      aria-labelledby={titleId}
    >
      <div
        ref={panelRef}
        className="relative bg-[var(--bg1)] border border-[var(--border-hi)] overflow-y-auto"
        style={{ width: 'min(600px, 90vw)', maxHeight: '80vh', borderRadius: '12px' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between sticky top-0 z-10 bg-[var(--bg1)]"
             style={{ padding: '18px 20px', borderBottom: '1px solid var(--border)' }}>
          <h2 id={titleId} style={{ fontSize: '14px', fontWeight: 500, color: 'var(--text0)' }}>
            {title}
          </h2>
          <button
            onClick={onClose}
            className="text-[var(--text1)] hover:text-[var(--text0)] transition-colors"
            style={{ background: 'transparent', border: 'none', cursor: 'pointer', fontSize: '18px', lineHeight: 1, padding: '2px 6px' }}
            aria-label={t('modal.close')}
          >
            ✕
          </button>
        </div>
        <div style={{ padding: '20px', fontSize: '13px', color: 'var(--text1)', lineHeight: 1.8 }}>
          {children}
        </div>
      </div>
    </div>
  )
}
