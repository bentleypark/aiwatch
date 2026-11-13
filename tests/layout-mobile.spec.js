import { test, expect } from './fixtures.js'
import { waitForDataLoad } from './helpers.js'

// #1988 — layout invariants checked across every route below at the narrow widths, instead of one
// hand-written assertion per element. 320px is the WCAG 2.2 SC 1.4.10 Reflow width.
const WIDTHS = [320, 360, 375]
const ROUTES = ['/', '/#bfl', '/#openai', '/#replicate', '/#incidents', '/#uptime', '/#latency', '/#ranking']

const now = Date.now()
const iso = (minAgo) => new Date(now - minAgo * 60_000).toISOString()
const incident = (id, title, minAgo, status = 'investigating') => ({
  id, title, startedAt: iso(minAgo), duration: null, status, impact: 'minor',
  timeline: [{ stage: status, text: title, at: iso(minAgo) }],
})
// The longest service name (24 chars, tied with Windsurf), several open incidents on one service, and down/degraded side by side.
const STRESS = { json: { services: [
  { id: 'bfl', category: 'api', name: 'Black Forest Labs (FLUX)', provider: 'Black Forest Labs', status: 'degraded',
    latency: 700, uptime30d: 99.1, incidents: [incident('bfl-1', 'Europe reduced model set', 3 * 24 * 60, 'monitoring')] },
  { id: 'replicate', category: 'api', name: 'Replicate', provider: 'Replicate', status: 'degraded', latency: 400, uptime30d: 98.7,
    incidents: [incident('rep-1', 'Replicate Model Registry Unavailable', 60), incident('rep-2', 'Elevated prediction latency for community models', 30)] },
  { id: 'openai', category: 'api', name: 'OpenAI API', provider: 'OpenAI', status: 'down', latency: 900, uptime30d: 99.5,
    incidents: [incident('oa-1', 'GPT-image-2.5 High error rate', 20)] },
], lastUpdated: new Date().toISOString() } }

// Runs in the page. Returns every violation as a readable string, so a failure names the element.
function layoutViolations() {
  const out = []
  const visible = (e) => e.getClientRects().length > 0 && e.getBoundingClientRect().width > 0
  const label = (e) => `${e.tagName.toLowerCase()} "${(e.innerText || '').trim().slice(0, 40)}"`

  // (a) WCAG 1.4.10 — no horizontal page scroll.
  const pageOverflow = document.documentElement.scrollWidth - document.documentElement.clientWidth
  if (pageOverflow > 0) out.push(`page overflows horizontally by ${pageOverflow}px`)

  // (b) nothing pokes out of its nearest bordered card, unless an ancestor in between clips it.
  for (const e of document.querySelectorAll('main *')) {
    if (!visible(e)) continue
    let p = e.parentElement
    let clipped = false
    while (p && p.tagName !== 'MAIN') {
      const cs = getComputedStyle(p)
      if (cs.overflowX !== 'visible') { clipped = true; break }
      if (cs.borderRightWidth !== '0px') break
      p = p.parentElement
    }
    if (clipped || !p || p.tagName === 'MAIN') continue
    const over = e.getBoundingClientRect().right - p.getBoundingClientRect().right
    if (over > 1) out.push(`${label(e)} escapes its card by ${Math.round(over)}px`)
  }

  // (c) a short one-line control (button / link) keeps one line.
  for (const e of document.querySelectorAll('main button, main a')) {
    if (!visible(e)) continue
    const text = (e.innerText || '').trim()
    if (!text || text.length > 40 || text.includes('\n')) continue
    const cs = getComputedStyle(e)
    const lineHeight = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.5
    const content = e.getBoundingClientRect().height
      - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom)
      - parseFloat(cs.borderTopWidth) - parseFloat(cs.borderBottomWidth)
    if (content > lineHeight * 1.6) out.push(`${label(e)} wraps (${Math.round(content)}px tall, line ${Math.round(lineHeight)}px)`)
  }
  return out
}

test.describe('#1988 — layout invariants at narrow widths', () => {
  test.beforeEach(async ({ page }) => {
    await page.route('**/api/status**', (route) => route.fulfill(STRESS))
    await page.route('**/api/status/cached', (route) => route.fulfill(STRESS))
  })

  for (const route of ROUTES) {
    test(`${route} — no page overflow, nothing escapes a card, short controls stay on one line`, async ({ page }) => {
      await page.setViewportSize({ width: WIDTHS[0], height: 800 })
      await page.goto('/')
      await waitForDataLoad(page)
      if (route !== '/') {
        await page.goto(route)
        await expect(page.locator('main h1, main h2').first()).toBeVisible()
        await page.waitForLoadState('networkidle')
      }
      const found = []
      for (const width of WIDTHS) {
        await page.setViewportSize({ width, height: 800 })
        await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))
        for (const v of await page.evaluate(layoutViolations)) found.push(`${width}px: ${v}`)
      }
      expect(found).toEqual([])
    })
  }

  test('/ — an affected row keeps its status pill at the right edge even when the button does not stretch its children', async ({ page }) => {
    await page.setViewportSize({ width: WIDTHS[0], height: 800 })
    await page.goto('/')
    await waitForDataLoad(page)
    await page.addStyleTag({ content: '[data-testid="affected-member"] { align-items: flex-start !important; }' })
    const rows = page.getByTestId('affected-member')
    await expect(rows.first()).toBeVisible()
    const gaps = await rows.evaluateAll((buttons) => buttons.map((b) => {
      const pill = b.firstElementChild.lastElementChild.getBoundingClientRect()
      const cs = getComputedStyle(b)
      return Math.round(b.getBoundingClientRect().right - parseFloat(cs.paddingRight) - pill.right)
    }))
    expect(gaps.length).toBeGreaterThan(1)
    expect(gaps.filter((g) => Math.abs(g) > 1)).toEqual([])
  })

  test('/ — an affected row lines its name and status pill up with its card content edges', async ({ page }) => {
    await page.setViewportSize({ width: WIDTHS[0], height: 800 })
    await page.goto('/')
    await waitForDataLoad(page)
    const rows = page.getByTestId('affected-member')
    await expect(rows.first()).toBeVisible()
    const offsets = await rows.evaluateAll((buttons) => buttons.map((b) => {
      let card = b.parentElement
      while (getComputedStyle(card).borderRightWidth === '0px') card = card.parentElement
      const c = card.getBoundingClientRect()
      const cs = getComputedStyle(card)
      const left = c.left + parseFloat(cs.borderLeftWidth) + parseFloat(cs.paddingLeft)
      const right = c.right - parseFloat(cs.borderRightWidth) - parseFloat(cs.paddingRight)
      const row = b.firstElementChild
      return [Math.round(row.firstElementChild.getBoundingClientRect().left - left), Math.round(right - row.lastElementChild.getBoundingClientRect().right)]
    }))
    expect(offsets.length).toBeGreaterThan(1)
    expect(offsets.filter(([l, r]) => Math.abs(l) > 1 || Math.abs(r) > 1)).toEqual([])
  })
})
