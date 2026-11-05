// Modal — native <dialog> overlay (#481)
// Opens via showModal(): top-layer rendering, native focus-trap, inert background,
// native ESC handling, and focus return to the trigger on close — all for free.
// Closes on: backdrop click, ESC, ✕ button. Backdrop light-dismiss is driven by the JS
// click handler in useModalDialog (universal — works everywhere); closedby="any" is a progressive
// enhancement for engines that support it (not yet Baseline; absent in Firefox).
//
// Conditional render (return null when closed): each <Modal> instance only puts its
// <dialog> in the DOM while open. App.jsx mounts two instances (privacy + terms); an
// always-rendered <dialog> would leave two in the DOM at once, breaking `getByRole('dialog')`
// and any single-dialog selector. Closed = unmounted, so at most one <dialog> exists.

import { useId, useRef } from 'react'
import { useLang } from '../hooks/useLang'
import { useModalDialog } from '../hooks/useModalDialog'

export default function Modal({ isOpen, onClose, title, children }) {
  const { t } = useLang()
  const titleId = useId()
  const dialogRef = useRef(null)

  useModalDialog(dialogRef, isOpen, onClose)

  if (!isOpen) return null

  return (
    // Native <dialog> has implicit role="dialog"; showModal() makes it modal (no aria-modal needed).
    // `margin: auto` MUST be inline, not a Tailwind `.m-auto` util: index.css's unlayered
    // `* { margin: 0 }` reset beats @layer-utilities classes, which would kill the UA dialog's
    // margin:auto centering and pin the panel to the top-left. Inline style outranks both.
    <dialog
      ref={dialogRef}
      closedby="any"
      aria-labelledby={titleId}
      className="bg-[var(--bg1)] border border-[var(--border-hi)] overflow-y-auto"
      style={{ width: 'min(600px, 90vw)', maxHeight: '80dvh', borderRadius: '12px', margin: 'auto' }}
    >
      <div className="flex items-center justify-between sticky top-0 z-10 bg-[var(--bg1)]"
           style={{ padding: '18px 20px', borderBottom: '1px solid var(--border)' }}>
        <h2 id={titleId} style={{ fontSize: '14px', fontWeight: 500, color: 'var(--text0)' }}>
          {title}
        </h2>
        <button
          onClick={() => dialogRef.current?.close()}
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
    </dialog>
  )
}
