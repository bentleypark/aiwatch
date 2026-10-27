import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { LAST_CHECKED_CLIENT_JS, lastCheckedTime, timeAgo } from '../html-template'

// #1531 Part 6 — the server writes "Last checked" at render time, and a `stale-if-error` copy served
// by the CDN keeps that text. The page re-ages it with LAST_CHECKED_CLIENT_JS, a browser copy of
// timeAgo. This runs the shipped string against the server function over the same ages.

const NOW = Date.parse('2026-10-27T12:00:00.000Z')
const AGES_MS = [0, 30_000, 60_000, 59 * 60_000, 60 * 60_000, 23 * 3_600_000 + 59 * 60_000, 24 * 3_600_000, 5 * 86_400_000]

function runClient(): void {
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  new Function(LAST_CHECKED_CLIENT_JS)()
  document.dispatchEvent(new Event('DOMContentLoaded'))
}

describe('LAST_CHECKED_CLIENT_JS (#1531)', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(NOW) })
  afterEach(() => { vi.useRealTimers(); document.body.innerHTML = '' })

  it.each(AGES_MS)('matches timeAgo for an age of %i ms', (age) => {
    const iso = new Date(NOW - age).toISOString()
    document.body.innerHTML = `<p>${lastCheckedTime(iso)}</p>`
    document.querySelector('time')!.textContent = 'stale label'
    runClient()
    expect(document.querySelector('time')!.textContent).toBe(timeAgo(iso))
  })

  it('re-ages a label rendered earlier, as on a CDN copy served after the render', () => {
    const iso = new Date(NOW - 60_000).toISOString()
    document.body.innerHTML = `<p>${lastCheckedTime(iso)}</p>`
    expect(document.querySelector('time')!.textContent).toBe('1m ago')
    vi.setSystemTime(NOW + 9 * 60_000)
    runClient()
    expect(document.querySelector('time')!.textContent).toBe('10m ago')
  })

  it('leaves the server label when the timestamp does not parse', () => {
    document.body.innerHTML = `<p>${lastCheckedTime('not-a-date')}</p>`
    runClient()
    expect(document.querySelector('time')!.textContent).toBe('unknown')
  })
})
