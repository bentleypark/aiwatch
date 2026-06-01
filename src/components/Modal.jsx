// Modal — native <dialog> overlay (#481)
// Opens via showModal(): top-layer rendering, native focus-trap, inert background,
// native ESC handling, and focus return to the trigger on close — all for free.
// Closes on: backdrop click, ESC, ✕ button. Backdrop light-dismiss is driven by the JS
// click handler below (universal — works everywhere); closedby="any" is a progressive
// enhancement for engines that support it (not yet Baseline; absent in Firefox).
//
// Conditional render (return null when closed): each <Modal> instance only puts its
// <dialog> in the DOM while open. App.jsx mounts two instances (privacy + terms); an
// always-rendered <dialog> would leave two in the DOM at once, breaking `getByRole('dialog')`
// and any single-dialog selector. Closed = unmounted, so at most one <dialog> exists.

import { useEffect, useId, useRef } from 'react'
import { useLang } from '../hooks/useLang'

export default function Modal({ isOpen, onClose, title, children }) {
  const { t } = useLang()
  const titleId = useId()
  const dialogRef = useRef(null)

  // onCloseRef avoids re-running the effect when the parent re-renders with a new onClose
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose

  // On open: showModal() (top-layer, native focus-trap + inert + ESC), lock body scroll, and wire
  // the close paths. EVERY close routes through the native dialog.close() — it runs the focus-restore
  // algorithm (returns focus to the trigger) that a plain React unmount would skip. The native `close`
  // event then syncs state back: onClose() → parent clears isOpen → this unmounts. So `close` is the
  // single sync point and there's no re-open footgun (state always follows the dialog).
  // - `close` = fired by ESC, closedby="any", and our own .close() calls → onClose() syncs React.
  // - `click` = backdrop light-dismiss fallback (universal). A backdrop click reports e.target === dialog,
  //   but so does a click on the dialog's own scrollbar (overflow-y-auto) — guard with getBoundingClientRect
  //   so only a click OUTSIDE the panel rect closes (matches native closedby, avoids the scrollbar footgun).
  // showModal() does NOT lock body scroll, so we still do.
  useEffect(() => {
    const dialog = dialogRef.current
    if (!isOpen || !dialog) return
    if (!dialog.open) dialog.showModal()
    document.body.style.overflow = 'hidden'

    const handleClose = () => onCloseRef.current?.()
    const handleClick = (e) => {
      if (e.target !== dialog) return
      const r = dialog.getBoundingClientRect()
      const outsidePanel = e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom
      if (outsidePanel) dialog.close()
    }
    dialog.addEventListener('close', handleClose)
    dialog.addEventListener('click', handleClick)
    return () => {
      dialog.removeEventListener('close', handleClose)
      dialog.removeEventListener('click', handleClick)
      document.body.style.overflow = ''
    }
  }, [isOpen])

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
      className="bg-[var(--bg1)] border border-[var(--border-hi)] overflow-y-auto p-0"
      style={{ width: 'min(600px, 90vw)', maxHeight: '80vh', borderRadius: '12px', margin: 'auto' }}
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
