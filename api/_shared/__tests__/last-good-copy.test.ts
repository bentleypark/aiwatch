import { describe, it, expect, vi, afterEach } from 'vitest'
import { lastGoodView, LAST_GOOD_MAX_AGE_MS } from '../last-good-copy'

const STATUS_URL = 'https://worker.test/api/status/cached?series=0&view=is-down&id=claude'
const COPY_URL = 'https://blob.test/is-down/status.json'
const NOW = Date.parse('2026-10-28T12:00:00Z')
const payload = (lastUpdated: string | undefined) => ({
  services: [
    { id: 'claude', name: 'Claude API', category: 'api', status: 'operational', incidents: [] },
    { id: 'openai', name: 'OpenAI API', category: 'api', status: 'operational', incidents: [] },
  ],
  ...(lastUpdated ? { lastUpdated } : {}),
})
const serve = (body: unknown) => vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify(body), { status: 200 }))
const read = () => lastGoodView<{ services: Array<{ id: string }> }>(STATUS_URL, COPY_URL, () => NOW)(new AbortController().signal)

describe('lastGoodView (#1531 Part 7)', () => {
  afterEach(() => { vi.restoreAllMocks() })

  it('cuts the page\'s view from a copy inside the age bound', async () => {
    serve(payload(new Date(NOW - LAST_GOOD_MAX_AGE_MS).toISOString()))
    expect((await read())?.services.map((s) => s.id)).toEqual(['claude'])
  })

  it('refuses a copy older than the bound, and one with no age', async () => {
    serve(payload(new Date(NOW - LAST_GOOD_MAX_AGE_MS - 1).toISOString()))
    expect(await read()).toBeNull()
    vi.restoreAllMocks()
    serve(payload(undefined))
    expect(await read()).toBeNull()
  })

  it('a missing blob is no copy', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 404 }))
    expect(await read()).toBeNull()
  })
})
