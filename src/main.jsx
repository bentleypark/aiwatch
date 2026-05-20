import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
)

// Register the PWA service worker in production only. In dev the SW's
// stale-while-revalidate cache serves previously-cached `/src/*` modules,
// masking source edits until the cache is manually cleared (#432). Dev also
// proactively unregisters any SW left over from an earlier session so a stale
// cache can't survive into the current dev run.
if ('serviceWorker' in navigator) {
  if (import.meta.env.PROD) {
    navigator.serviceWorker.register('/sw.js').catch(() => {})
  } else {
    navigator.serviceWorker.getRegistrations().then((regs) => regs.forEach((r) => r.unregister())).catch(() => {})
  }
}
