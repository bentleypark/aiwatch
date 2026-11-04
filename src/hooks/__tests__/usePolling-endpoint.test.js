import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createElement, act, useEffect } from 'react'
import { createRoot } from 'react-dom/client'
import { PollingProvider, usePolling } from '../usePolling'
import { _resetApiTiming } from '../../utils/apiTiming'

// #1910 — which endpoint each poll reads, and which time the dashboard shows for it.

const NOW = new Date('2026-11-04T12:00:00.000Z')
const services = [{ id: 'claude', name: 'Claude API', category: 'api', status: 'operational', incidents: [] }]

let root
let container
let latest
let urls
let snapshotAgeMs
let servedAt
let cacheModes

function Probe() {
  const value = usePolling()
  useEffect(() => { latest = value })
  return null
}

async function mount(ageMs) {
  snapshotAgeMs = ageMs
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => { root.render(createElement(PollingProvider, null, createElement(Probe))) })
  await act(async () => { await vi.advanceTimersByTimeAsync(1_000) })
  urls.length = 0
  cacheModes.length = 0
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  _resetApiTiming()
  urls = []
  cacheModes = []
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(false)
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'requestAnimationFrame', 'cancelAnimationFrame', 'performance'] })
  vi.setSystemTime(NOW)
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input)
    if (url.endsWith('/api/rum')) return new Response(null, { status: 204 })
    urls.push(new URL(url).pathname)
    cacheModes.push(init?.cache)
    servedAt = new Date(Date.now() - snapshotAgeMs).toISOString()
    return new Response(JSON.stringify({ services, lastUpdated: servedAt, cached: true }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  })
})

afterEach(async () => {
  if (root) await act(async () => root.unmount())
  container?.remove()
  root = undefined
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('#1910 usePolling', () => {
  it('reads the cached endpoint on the background poll, not the live one', async () => {
    await mount(5_000)
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000) })
    expect(urls).toEqual(['/api/status/cached'])
    expect(cacheModes).toEqual(['no-cache'])
  })

  it('shows the snapshot time the response carries', async () => {
    await mount(5_000)
    expect(latest.lastUpdated.toISOString()).toBe(servedAt)
  })

  it('polls once more 20 s after a stale snapshot, and only once', async () => {
    await mount(90_000)
    await act(async () => { await vi.advanceTimersByTimeAsync(19_000) })
    expect(urls).toEqual([])
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000) })
    expect(urls).toEqual(['/api/status/cached'])
    expect(cacheModes).toEqual(['no-cache'])
    await act(async () => { await vi.advanceTimersByTimeAsync(37_000) })
    expect(urls).toEqual(['/api/status/cached'])
  })

  it('does not re-poll after a fresh snapshot', async () => {
    await mount(5_000)
    await act(async () => { await vi.advanceTimersByTimeAsync(58_000) })
    expect(urls).toEqual([])
  })

  it('a poll in between replaces the pending re-poll instead of adding one', async () => {
    await mount(90_000)
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000) })
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
    await act(async () => { await vi.advanceTimersByTimeAsync(15_000) })
    expect(urls).toEqual(['/api/status/cached'])
  })

  it('the refresh button asks the Worker, not the browser cache', async () => {
    await mount(5_000)
    await act(async () => { latest.refresh(); await vi.advanceTimersByTimeAsync(1_000) })
    expect(urls).toEqual(['/api/status/cached'])
    expect(cacheModes).toEqual(['no-cache'])
  })

  it('drops a pending re-poll on unmount', async () => {
    await mount(90_000)
    await act(async () => root.unmount())
    root = undefined
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000) })
    expect(urls).toEqual([])
  })
})
