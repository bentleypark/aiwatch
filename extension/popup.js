// Popup UI for the AIWatch Claude extension (#837). Reads the cached payload from
// chrome.storage for an instant first paint, then asks the service worker for a fresh
// fetch and re-renders. All DOM is built with createElement + textContent (never
// innerHTML) — CSP-clean and injection-safe even though the data is our own API.

import { REPORT_URL, SITE_BASE } from './config.js'
import {
  worstStatus,
  statusLabel,
  categoryLabel,
  formatScore,
  formatUptime,
  formatRelTime,
  reportCountLabel,
  fallbackText,
  shouldShowFallback,
  isDownPath,
} from './lib/render.js'

const STORAGE_KEY = 'aiwatch:status'

const $ = (id) => document.getElementById(id)

function el(tag, className, text) {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text != null) node.textContent = text
  return node
}

function incidentNode(inc) {
  const impact = inc.impact || ''
  const box = el('div', `incident ${impact}`)
  box.appendChild(el('div', 'incident-title', inc.title))
  const meta = [statusLabelForIncident(inc.status), impact].filter(Boolean).join(' · ')
  box.appendChild(el('div', 'incident-meta', meta))
  if (inc.aiSummary) box.appendChild(el('div', 'incident-ai', `🤖 ${inc.aiSummary}`))
  return box
}

// Incident phase words are lower-case from the API; show as-is (CSS capitalizes).
function statusLabelForIncident(s) {
  return s || ''
}

function reportsNode(reports, now) {
  const wrap = el('div', 'reports')
  wrap.appendChild(el('div', 'reports-head', `👥 ${reportCountLabel(reports.count)}`))
  for (const r of reports.recent || []) {
    const item = el('div', 'report-item')
    item.appendChild(el('span', 'report-meta', `${categoryLabel(r.cat)} · ${formatRelTime(r.ts, now)}`))
    // Free-text note when present — textContent (via el) keeps it injection-safe.
    if (r.desc) item.appendChild(el('span', 'report-desc', `“${r.desc}”`))
    wrap.appendChild(item)
  }
  return wrap
}

function fallbackNode(fallback) {
  const text = fallbackText(fallback)
  if (!text) return null
  const wrap = el('div', 'fallback')
  wrap.appendChild(el('span', null, 'Try instead: '))
  wrap.appendChild(el('b', null, text))
  return wrap
}

function cardNode(svc, now) {
  const card = el('div', 'card')
  const head = el('div', 'card-head')
  head.appendChild(el('span', `dot ${svc.status || 'unknown'}`))
  // The surface name deep-links to ITS OWN "Is X Down?" page (claude.ai → /is-claude-ai-down,
  // Claude Code → /is-claude-code-down), not a single fixed Claude-API page.
  const path = isDownPath(svc.id)
  if (path) {
    const link = el('a', 'card-name', svc.name)
    link.href = `${SITE_BASE}${path}`
    link.target = '_blank'
    link.rel = 'noopener'
    head.appendChild(link)
  } else {
    head.appendChild(el('span', 'card-name', svc.name))
  }
  // Headline = 30-day uptime (a concrete number first-time users grasp immediately),
  // with the Score demoted to the sub-line below. Tooltip clarifies the window.
  const upEl = el('span', 'card-uptime', formatUptime(svc.uptime30d))
  upEl.title = '30-day official uptime'
  head.appendChild(upEl)
  card.appendChild(head)

  // Sub-line: status + Score (secondary, tooltip-explained; the bottom legend reinforces both).
  const sub = el('div', 'card-sub')
  sub.appendChild(el('span', null, statusLabel(svc.status)))
  const scoreEl = el('span', 'card-score-inline', ` · Score ${formatScore(svc.score, svc.grade)}`)
  scoreEl.title = 'AIWatch reliability Score (0–100): uptime, incidents, recovery & responsiveness. Higher is better.'
  sub.appendChild(scoreEl)
  card.appendChild(sub)

  for (const inc of svc.incidents || []) card.appendChild(incidentNode(inc))
  if (svc.reports && svc.reports.count > 0) card.appendChild(reportsNode(svc.reports, now))

  // Fallback only when this surface is actually having trouble (matches the dashboard's
  // status-gated recommendation — no point suggesting alternatives when all is well).
  if (shouldShowFallback(svc.status)) {
    const fb = fallbackNode(svc.fallback)
    if (fb) card.appendChild(fb)
  }
  return card
}

function render(stored) {
  const main = $('surfaces')
  main.setAttribute('aria-busy', 'false')
  main.replaceChildren()

  const payload = stored && stored.payload
  const services = (payload && payload.services) || []
  const now = Date.now()

  const overall = worstStatus(services)
  const overallEl = $('overall')
  overallEl.textContent = services.length ? statusLabel(overall) : 'No data'
  overallEl.style.color =
    overall === 'down' ? 'var(--red)' : overall === 'degraded' ? 'var(--amber)' : overall === 'operational' ? 'var(--green)' : 'var(--text2)'

  if (!services.length) {
    main.appendChild(el('p', 'muted', 'Status unavailable — retrying…'))
  } else {
    for (const svc of services) main.appendChild(cardNode(svc, now))
  }

  // "Checked HH:MM" = when the extension last POLLED (client fetchedAt), local time. This is
  // what moves: it advances on every 2-min poll and every popup open. (cachedAt — the worker's
  // data-generation time — only moves every ~10 min, so it reads as stuck between updates;
  // fetchedAt reflects "we're actively monitoring" and stops advancing if polls start failing.)
  const updated = $('updated')
  updated.textContent = stored && stored.fetchedAt
    ? `Checked ${new Date(stored.fetchedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
    : ''
}

async function loadAndRefresh() {
  let stored = null
  let rendered = false
  // 1) instant paint from cache (a storage read can itself reject — quota / corruption /
  //    invalidated context — so guard it; a failure must NOT leave the popup stuck on the
  //    aria-busy skeleton).
  try {
    const cached = await chrome.storage.local.get(STORAGE_KEY)
    stored = cached[STORAGE_KEY] ?? null
    if (stored) { render(stored); rendered = true }
  } catch (err) {
    console.warn('[aiwatch] storage read failed:', err instanceof Error ? err.message : err)
  }
  // 2) ask the SW for a fresh fetch, then re-render
  try {
    const fresh = await chrome.runtime.sendMessage({ type: 'refresh' })
    if (fresh) { render(fresh); rendered = true }
  } catch (err) {
    console.warn('[aiwatch] refresh failed:', err instanceof Error ? err.message : err)
  }
  // 3) guarantee SOMETHING painted — on a cold install with the worker/network down, both
  //    paths above no-op; render the (empty) state so the user sees "Status unavailable —
  //    retrying…" instead of a permanently-busy blank popup.
  if (!rendered) render(stored)
}

async function submitReport(evt) {
  evt.preventDefault()
  const btn = $('report-submit')
  const statusEl = $('report-status')
  statusEl.className = 'report-status'
  statusEl.textContent = ''
  btn.disabled = true
  const body = {
    svcId: $('report-svc').value,
    category: $('report-cat').value,
    description: $('report-desc').value.trim(),
  }
  try {
    const res = await fetch(REPORT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    const data = await res.json().catch(() => ({}))
    if (res.ok) {
      statusEl.className = 'report-status ok'
      statusEl.textContent = data.message || 'Thanks — we factor this into our monitoring.'
      $('report-desc').value = ''
    } else if (res.status === 429) {
      statusEl.className = 'report-status err'
      statusEl.textContent = 'Too many reports — please try again later.'
    } else {
      statusEl.className = 'report-status err'
      statusEl.textContent = data.error || 'Could not send report.'
    }
  } catch (err) {
    statusEl.className = 'report-status err'
    statusEl.textContent = 'Network error — could not send report.'
    console.warn('[aiwatch] report failed:', err instanceof Error ? err.message : err)
  } finally {
    btn.disabled = false
  }
}

// Live-update a popup that stays open: when the service worker's 2-min poll writes fresh
// data to storage, re-render so the cards + the "Checked HH:MM" time refresh in place
// (otherwise the popup only paints once on open and looks frozen while kept open).
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes[STORAGE_KEY] && changes[STORAGE_KEY].newValue) {
    // try/catch to match the file's logging discipline (render does DOM work); cannot loop
    // since render never writes storage.
    try { render(changes[STORAGE_KEY].newValue) }
    catch (err) { console.warn('[aiwatch] onChanged render failed:', err instanceof Error ? err.message : err) }
  }
})

document.addEventListener('DOMContentLoaded', () => {
  // Footer → the AIWatch dashboard, reusing the landing page's CTA copy ("Open the
  // dashboard →"). Per-surface cards already deep-link to their own is-down pages.
  $('dashboard-link').href = SITE_BASE
  $('report-form').addEventListener('submit', submitReport)
  loadAndRefresh()
})
