// #1489 — the `/uptime_showcase` read-through: what is stored, what is retried, and that a broken KV
// never costs the read itself.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { readThroughUptimeShowcase, showcaseCacheKey, SHOWCASE_CACHE_TTL_S } from '../uptime-showcase'
import { createFetchTracker } from '../utils'
import { mockKV } from './helpers/unreadable-source'

const PAGE = 'https://status.example.com'
const CODES = ['bbb', 'aaa']
const TIMELINES = { aaa: { days: [{ date: '2026-10-27', outages: {} }] } }
const KEY = 'uptime-showcase:status.example.com:aaa,bbb'

function stubShowcase(res: () => Response) {
  const fetchMock = vi.fn(async () => res())
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}
const ok = () => new Response(JSON.stringify({ timelines: TIMELINES, values: [] }), { status: 200 })
const read = (kv: unknown) => readThroughUptimeShowcase(kv as KVNamespace, PAGE, CODES, 3000, createFetchTracker())

describe('readThroughUptimeShowcase (#1489)', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

  it('keys by host and the sorted codes, so the same scope in another order shares one entry', () => {
    expect(showcaseCacheKey(PAGE, CODES)).toBe(KEY)
    expect(showcaseCacheKey(`${PAGE}/`, ['aaa', 'bbb'])).toBe(KEY)
  })
  it('gives up the key past KV\'s 512-byte limit', () => {
    expect(showcaseCacheKey(PAGE, Array.from({ length: 60 }, (_, i) => `component${i}`))).toBeNull()
  })

  it('a miss fetches and stores the read for SHOWCASE_CACHE_TTL_S', async () => {
    const fetchMock = stubShowcase(ok)
    const kv = mockKV()
    expect(await read(kv)).toEqual(TIMELINES)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(kv.put).toHaveBeenCalledWith(KEY, JSON.stringify(TIMELINES), { expirationTtl: SHOWCASE_CACHE_TTL_S })
  })
  it('a hit answers from KV with no request', async () => {
    const fetchMock = stubShowcase(ok)
    expect(await read(mockKV({ [KEY]: JSON.stringify(TIMELINES) }))).toEqual(TIMELINES)
    expect(fetchMock).not.toHaveBeenCalled()
  })
  it('a failed read is not stored, so the next run asks again', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    stubShowcase(() => new Response('nope', { status: 503 }))
    const kv = mockKV()
    expect(await read(kv)).toBeNull()
    expect(kv.put).not.toHaveBeenCalled()
  })
  it.each(['not json', '[1,2]'])('an entry that is not a timelines object (%s) is refetched', async (stored) => {
    const fetchMock = stubShowcase(ok)
    expect(await read(mockKV({ [KEY]: stored }))).toEqual(TIMELINES)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
  it('a KV read that throws, or a write that rejects, still returns the fetched read', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    stubShowcase(ok)
    const kv = mockKV()
    kv.get.mockRejectedValueOnce(new Error('kv down'))
    kv.put.mockRejectedValueOnce(new Error('kv down'))
    expect(await read(kv)).toEqual(TIMELINES)
  })
  it('without a KV binding it is the plain fetch', async () => {
    const fetchMock = stubShowcase(ok)
    expect(await read(undefined)).toEqual(TIMELINES)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
