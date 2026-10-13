import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { parseServerTiming, startApiTiming, noteHeaders, finishApiTiming, BATCH_SIZE, _resetApiTiming } from '../apiTiming'

const headers = (v) => ({ headers: { get: (k) => (k === 'Server-Timing' ? v : null) } })

describe('#1686 parseServerTiming', () => {
  it('reads the worker entry', () => {
    expect(parseServerTiming('worker;dur=123')).toBe(123)
    expect(parseServerTiming('cfExtPri, worker;dur=45.6')).toBe(46)
  })
  it('is null when absent or malformed', () => {
    expect(parseServerTiming(null)).toBeNull()
    expect(parseServerTiming('cache;dur=10')).toBeNull()
    expect(parseServerTiming('worker')).toBeNull()
  })
})

describe('#1686 api timing batches', () => {
  let fetchSpy
  let now
  beforeEach(() => {
    _resetApiTiming()
    now = 0
    vi.spyOn(performance, 'now').mockImplementation(() => now)
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 204 }))
  })
  afterEach(() => vi.restoreAllMocks())

  const sent = () => fetchSpy.mock.calls.map(([, init]) => JSON.parse(init.body).samples)

  it('sends one batch of five, with total and worker time', () => {
    for (let i = 0; i < BATCH_SIZE; i++) {
      const t = startApiTiming()
      now += 1000
      noteHeaders(t, headers('worker;dur=40'))
      finishApiTiming(t, { outcome: 'ok' })
    }
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(String(fetchSpy.mock.calls[0][0])).toMatch(/\/api\/rum$/)
    expect(sent()[0]).toHaveLength(BATCH_SIZE)
    expect(sent()[0][0]).toEqual({ totalMs: 1000, serverMs: 40, outcome: 'ok' })
  })

  it('counts a poll once even if it is finished twice', () => {
    for (let i = 0; i < BATCH_SIZE; i++) {
      const t = startApiTiming()
      finishApiTiming(t, { outcome: 'error' })
      finishApiTiming(t, { outcome: 'error' })
    }
    expect(sent()[0]).toHaveLength(BATCH_SIZE)
  })

  it('a poll sent as pending on hide is not counted again when it completes', () => {
    const t = startApiTiming()
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
    document.dispatchEvent(new Event('visibilitychange'))
    finishApiTiming(t, { outcome: 'ok' })
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
    for (let i = 0; i < BATCH_SIZE - 1; i++) finishApiTiming(startApiTiming(), { outcome: 'ok' })
    expect(sent()).toEqual([[{ totalMs: 0, serverMs: null, outcome: 'pending' }]])
  })

  it('a poll that starts while the tab is hidden is not a sample', () => {
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
    for (let i = 0; i < BATCH_SIZE; i++) {
      const t = startApiTiming()
      now += 20_000
      finishApiTiming(t, { outcome: 'timeout' })
    }
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('on hide, sends what it has plus the in-flight poll as a lower bound', () => {
    const first = startApiTiming()
    finishApiTiming(first, { outcome: 'ok' })
    startApiTiming()
    now += 12_000
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
    document.dispatchEvent(new Event('visibilitychange'))
    expect(sent()[0]).toEqual([
      { totalMs: 0, serverMs: null, outcome: 'ok' },
      { totalMs: 12_000, serverMs: null, outcome: 'pending' },
    ])
  })
})
