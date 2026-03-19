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
    const focusable = panelRef.current
      ? Array.from(panelRef.current.querySelectorAll(FOCUSABLE))
      : []

    // Move focus into dialog on open
    focusable[0]?.focus()

    function onKeyDown(e) {
      if (e.key === 'Escape') { onCloseRef.current(); return }
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
        className="relative w-full max-w-lg max-h-[80vh] overflow-y-auto
                   bg-[var(--bg1)] border border-[var(--border)] rounded-lg p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-4">
          <h2 id={titleId} className="text-sm font-medium text-[var(--text0)]">
            {title}
          </h2>
          <button
            onClick={onClose}
            className="text-[var(--text2)] hover:text-[var(--text0)] transition-colors mono"
            aria-label={t('modal.close')}
          >
            ✕
          </button>
        </div>
        <div className="text-xs text-[var(--text1)] leading-relaxed">
          {children}
        </div>
      </div>
    </div>
  )
}
