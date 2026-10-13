import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createElement, act } from 'react'
import { createRoot } from 'react-dom/client'
import { PollingProvider } from '../usePolling'
import { _resetApiTiming } from '../../utils/apiTiming'

// #1686 — the timing rules are unit-tested in utils/__tests__/apiTiming.test.js; this pins the CALL
// SITES in usePolling: what each poll outcome turns into, through the real provider.

const STATUS = { services: [{ id: 'claude', name: 'Claude API', category: 'api', status: 'operational', incidents: [] }] }
const statusResponse = () => new Response(JSON.stringify(STATUS), { status: 200, headers: { 'Content-Type': 'application/json', 'Server-Timing': 'worker;dur=42' } })

let root
let container
let rumBatches

const hide = () => {
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(true)
  document.dispatchEvent(new Event('visibilitychange'))
}
const show = () => {
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(false)
  document.dispatchEvent(new Event('visibilitychange'))
}

/** status(url, init) answers /api/status*; /api/rum is recorded. */
function mockFetch(status) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input)
    if (url.endsWith('/api/rum')) {
      rumBatches.push(JSON.parse(init.body).samples)
      return new Response(null, { status: 204 })
    }
    return status(url, init)
  })
}

/** A status fetch that never settles until its signal aborts — and, like fetch, rejects at once on an
 *  already-aborted signal. */
const hanging = (_url, init) => new Promise((_, reject) => {
  const abort = () => reject(new DOMException('aborted', 'AbortError'))
  if (init.signal.aborted) abort()
  else init.signal.addEventListener('abort', abort)
})

async function mount() {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => { root.render(createElement(PollingProvider, null, null)) })
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  _resetApiTiming()
  rumBatches = []
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(false)
})

afterEach(async () => {
  if (root) await act(async () => root.unmount())
  container?.remove()
  root = undefined
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('#1686 usePolling records each poll', () => {
  it('a completed poll is an ok sample carrying the worker time', async () => {
    mockFetch(async () => statusResponse())
    await mount()
    await act(async () => { await new Promise((r) => setTimeout(r, 50)) })
    hide()
    expect(rumBatches).toEqual([[expect.objectContaining({ outcome: 'ok', serverMs: 42 })]])
  })

  it('an error response is an error sample that keeps the worker time', async () => {
    mockFetch(async () => new Response('fail', { status: 503, headers: { 'Server-Timing': 'worker;dur=4200' } }))
    await mount()
    await act(async () => { await new Promise((r) => setTimeout(r, 1100)) })
    hide()
    expect(rumBatches).toEqual([[expect.objectContaining({ outcome: 'error', serverMs: 4200 })]])
  })

  it('a poll the 15s timer aborts is a timeout sample', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'requestAnimationFrame', 'cancelAnimationFrame', 'performance'] })
    mockFetch(hanging)
    await mount()
    await act(async () => { await vi.advanceTimersByTimeAsync(15_100) })
    hide()
    expect(rumBatches.flat()).toEqual([expect.objectContaining({ outcome: 'timeout' })])
  })

  it('a poll still loading when the tab is hidden is a pending sample', async () => {
    mockFetch(hanging)
    await mount()
    await act(async () => { await new Promise((r) => setTimeout(r, 20)) })
    hide()
    expect(rumBatches).toEqual([[expect.objectContaining({ outcome: 'pending' })]])
  })

  it('a poll replaced while its body was still loading keeps the worker time its headers carried', async () => {
    let firstPoll
    mockFetch(async (url, init) => {
      firstPoll ??= init.signal
      if (init.signal !== firstPoll) return statusResponse()
      return {
        ok: true,
        status: 200,
        headers: new Headers({ 'Server-Timing': 'worker;dur=180' }),
        json: () => hanging(url, init),
      }
    })
    await mount()
    await act(async () => { await new Promise((r) => setTimeout(r, 20)) })
    await act(async () => { show() })
    await act(async () => { await new Promise((r) => setTimeout(r, 50)) })
    hide()
    expect(rumBatches.flat()).toContainEqual(expect.objectContaining({ outcome: 'pending', serverMs: 180 }))
  })

  it('a poll a newer one replaced is recorded as pending with its elapsed time, not dropped', async () => {
    let firstPoll
    mockFetch(async (url, init) => {
      firstPoll ??= init.signal
      return init.signal === firstPoll ? hanging(url, init) : statusResponse()
    })
    await mount()
    await act(async () => { await new Promise((r) => setTimeout(r, 20)) })
    await act(async () => { show() })
    await act(async () => { await new Promise((r) => setTimeout(r, 50)) })
    hide()
    expect(rumBatches.flat().map((s) => s.outcome).sort()).toEqual(['ok', 'pending'])
  })
})
