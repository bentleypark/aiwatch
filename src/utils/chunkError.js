/**
 * Detects whether an error is a dynamic-import chunk load failure.
 * Matches browser-specific error messages across Chrome / Firefox / Safari.
 * Used by ChunkErrorBoundary to decide whether to auto-reload (hash mismatch
 * after a new deployment) vs show the manual error UI (non-chunk failure).
 */
export function isChunkLoadError(error) {
  const msg = String(error?.message ?? '')
  return (
    msg.includes('Failed to fetch dynamically imported module') || // Chrome
    msg.includes('error loading dynamically imported module') ||   // Firefox
    msg.includes('Importing a module script failed') ||            // Safari
    /Loading chunk \d+ failed/.test(msg)                           // Vite legacy
  )
}
