// Background service worker (MV3, type:module) for the AIWatch Claude extension (#837).
//
// MV3 service workers are EPHEMERAL — they sleep after ~30s and lose all in-memory
// state. So: state lives in chrome.storage (never module variables), and polling is
// driven by chrome.alarms (never setInterval). On each tick we fetch the lite
// projection, paint the toolbar badge with the worst-of-3 status, and cache the
// payload so the popup renders instantly on open.

import { STATUS_URL, POLL_PERIOD_MINUTES } from './config.js'
import { worstStatus, badgeFor } from './lib/render.js'

const ALARM_NAME = 'aiwatch-poll'
const STORAGE_KEY = 'aiwatch:status'

// Fetch the projection, update the badge, and persist the payload. All errors are
// surfaced (logged) — never silently swallowed — and leave the last-known payload in
// place while flipping the badge to grey (unknown) so a stale green can't mislead.
async function poll() {
  try {
    const res = await fetch(STATUS_URL, { cache: 'no-store' })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const payload = await res.json()
    // Shape guard: a 200 that parses to JSON but isn't our payload (captive portal, proxy
    // error page, {}) must be treated as a failure — otherwise we'd overwrite a genuinely
    // good cached payload with junk. Route it through the catch (grey badge + keep last-known).
    if (!payload || !Array.isArray(payload.services)) throw new Error('unexpected payload shape')
    await chrome.storage.local.set({ [STORAGE_KEY]: { payload, fetchedAt: Date.now() } })
    await paintBadge(worstStatus(payload.services))
  } catch (err) {
    console.warn('[aiwatch] poll failed:', err instanceof Error ? err.message : err)
    await paintBadge('unknown')
  }
}

// Always-visible color dot: a solid color chip (the '●' glyph painted in the same
// color as the background reads as a filled dot). On a Chrome build lacking
// setBadgeTextColor the glyph keeps the default white text over the colored chip —
// still a visible colored badge, just not a clean monochrome dot (acceptable fallback).
async function paintBadge(status) {
  const { color, text } = badgeFor(status)
  try {
    await chrome.action.setBadgeBackgroundColor({ color })
    if (chrome.action.setBadgeTextColor) await chrome.action.setBadgeTextColor({ color })
    await chrome.action.setBadgeText({ text })
  } catch (err) {
    console.warn('[aiwatch] badge update failed:', err instanceof Error ? err.message : err)
  }
}

// Ensure the recurring alarm exists and do an immediate first poll. Called on install
// and on browser startup (the SW may be cold each time).
async function init() {
  await chrome.alarms.create(ALARM_NAME, { periodInMinutes: POLL_PERIOD_MINUTES })
  await poll()
}

chrome.runtime.onInstalled.addListener(() => { init() })
chrome.runtime.onStartup.addListener(() => { init() })

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) poll()
})

// The popup asks for an immediate refresh when it opens (fresh data regardless of the
// 2-min cadence). Respond with the just-fetched payload.
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message && message.type === 'refresh') {
    (async () => {
      await poll()
      const stored = await chrome.storage.local.get(STORAGE_KEY)
      sendResponse(stored[STORAGE_KEY] ?? null)
    })()
    return true // keep the channel open for the async response
  }
})
