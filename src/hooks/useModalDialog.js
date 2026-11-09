// #1879 — the <dialog> lifecycle both modals share (Modal.jsx #481, AnalysisModal).
import { useEffect, useRef } from 'react'

export function useModalDialog(dialogRef, isOpen, onClose) {
  // onCloseRef avoids re-running the open effect when the parent re-renders with a new onClose.
  // #932 — write the ref in a passive effect (not during render; react-hooks/refs) so it stays
  // concurrent-safe. The ref is only READ inside the dialog's close/click listeners, which fire on
  // user interaction (always after commit), so the post-commit update is soon enough.
  const onCloseRef = useRef(onClose)
  useEffect(() => { onCloseRef.current = onClose })

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
  }, [isOpen, dialogRef])
}
