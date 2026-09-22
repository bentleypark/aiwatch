import { describe, expect, it, vi, afterEach } from 'vitest'
import { fetchService, SERVICES, statuspageSummaryFailureReason } from '../services'
import { parseParseFailDay, reasonsFor } from '../parse-failure-log'
import { mockKV } from './helpers/unreadable-source'

const claudeai = SERVICES.find((service) => service.id === 'claudeai')!
const langsmith = SERVICES.find((service) => service.id === 'langsmith')!

afterEach(() => vi.unstubAllGlobals())

const CHALLENGE = '<html>challenge</html>'
const NOT_A_SUMMARY = JSON.stringify({ message: 'Not Found' })

/** Drive the direct (non-prefetched) Statuspage path with a chosen outcome per endpoint. */
function stubStatuspage(summary: () => Response | never, incidents: () => Response | never) {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) =>
    String(input).includes('summary.json') ? summary() : incidents()))
}

function bookedReasons(kv: ReturnType<typeof mockKV>, svcId: string): string[] {
  const key = Object.keys(kv.store).find((candidate) => candidate.startsWith('instatus-parse-fail:'))
  return key ? reasonsFor(parseParseFailDay(kv.store[key]), svcId) : []
}

const json = (body: string) => new Response(body, { status: 200, headers: { 'content-type': 'application/json' } })
const html = (body: string) => new Response(body, { status: 200, headers: { 'content-type': 'text/html' } })

describe('#1470 Statuspage source-read reasons', () => {
  it('separates a non-JSON body from a JSON body outside the Statuspage schema', () => {
    expect(statuspageSummaryFailureReason(null)).toBe('statuspage-non-json')
    expect(statuspageSummaryFailureReason({ message: 'Not Found' })).toBe('statuspage-summary-unreadable')
    expect(statuspageSummaryFailureReason([])).toBe('statuspage-summary-unreadable')
  })

  it('books the summary body reason, not the content-type, when a JSON header carries an interstitial', async () => {
    const kv = mockKV()
    stubStatuspage(() => json(CHALLENGE), () => json('{"incidents":[]}'))

    await fetchService(claudeai, undefined, kv as never, {})

    expect(bookedReasons(kv, 'claudeai')).toEqual(['statuspage-non-json'])
  })

  it('books the Statuspage-schema reason for a valid JSON body that is not a summary', async () => {
    const kv = mockKV()
    stubStatuspage(() => json(NOT_A_SUMMARY), () => json('{"incidents":[]}'))

    await fetchService(claudeai, undefined, kv as never, {})

    expect(bookedReasons(kv, 'claudeai')).toEqual(['statuspage-summary-unreadable'])
  })

  it('books the summary reason when the secondary incidents feed fails in the SAME slot', async () => {
    const kv = mockKV()
    stubStatuspage(() => html(CHALLENGE), () => { throw new Error('ECONNRESET') })

    await fetchService(claudeai, undefined, kv as never, {})

    expect(bookedReasons(kv, 'claudeai')).toEqual(['statuspage-non-json'])
  })

  it('books the summary reason when the whole host is unreachable', async () => {
    const kv = mockKV()
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ENOTFOUND') }))

    await fetchService(claudeai, undefined, kv as never, {})

    expect(bookedReasons(kv, 'claudeai')).toEqual(['statuspage-fetch-unreadable'])
  })

  it('books the summary reason on a non-4xx HTTP failure', async () => {
    const kv = mockKV()
    stubStatuspage(() => new Response('upstream error', { status: 503 }), () => json('{"incidents":[]}'))

    await fetchService(claudeai, undefined, kv as never, {})

    expect(bookedReasons(kv, 'claudeai')).toEqual(['statuspage-fetch-unreadable'])
  })

  it('books nothing on a 4xx, which is classified dead-source instead', async () => {
    const kv = mockKV()
    stubStatuspage(() => new Response('page inactive', { status: 401 }), () => json('{"incidents":[]}'))

    await fetchService(claudeai, undefined, kv as never, {})

    expect(bookedReasons(kv, 'claudeai')).toEqual([])
  })

  it('books the summary reason when its body cannot be read', async () => {
    const kv = mockKV()
    const erroring = new ReadableStream({ start: (controller) => controller.error(new Error('stream reset')) })
    stubStatuspage(
      () => new Response(erroring, { status: 200, headers: { 'content-type': 'application/json' } }),
      () => json('{"incidents":[]}'),
    )

    await fetchService(claudeai, undefined, kv as never, {})

    expect(bookedReasons(kv, 'claudeai')).toEqual(['statuspage-fetch-unreadable'])
  })

  it('books the incident.io global-page reason when the page HTML cannot be rebuilt', async () => {
    const kv = mockKV()
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('summary.json')) return json(JSON.stringify({ status: { indicator: 'none', description: 'ok' }, components: [], incidents: [], scheduled_maintenances: [] }))
      if (url.includes('incidents.json')) return json('{"incidents":[]}')
      return html('<html><body>no RSC payload</body></html>')
    }))

    await fetchService(langsmith, undefined, kv as never, {})

    expect(bookedReasons(kv, 'langsmith')).toEqual(['incidentio-global-unreadable'])
  })

  it('books the secondary feed only when it is the leg that failed', async () => {
    const kv = mockKV()
    stubStatuspage(
      () => json(JSON.stringify({ status: { indicator: 'none', description: 'All Systems Operational' }, components: [], incidents: [], scheduled_maintenances: [] })),
      () => { throw new Error('ECONNRESET') },
    )

    await fetchService(claudeai, undefined, kv as never, {})

    expect(bookedReasons(kv, 'claudeai')).toEqual(['statuspage-incidents-unreadable'])
  })
})

describe('#1470 booking a reason stays out of the published latency', () => {
  const claude = SERVICES.find((service) => service.id === 'claude')!
  const HEALTHY = JSON.stringify({ status: { indicator: 'none', description: 'ok' }, components: [], incidents: [], scheduled_maintenances: [] })

  function pacedKV(delayMs: number) {
    const store: Record<string, string> = {}
    const wait = () => new Promise((resolve) => setTimeout(resolve, delayMs))
    return {
      store,
      get: vi.fn(async (k: string) => { await wait(); return store[k] ?? null }),
      put: vi.fn(async (k: string, v: string) => { await wait(); store[k] = v }),
      delete: vi.fn(async () => {}),
      list: vi.fn(async () => ({ keys: [], list_complete: true, cursor: undefined })),
    }
  }

  async function latencyWithKvPaced(delayMs: number): Promise<number> {
    stubStatuspage(() => json(HEALTHY), () => { throw new Error('ECONNRESET') })
    const result = await fetchService(claude, undefined, pacedKV(delayMs) as never, {})
    return result.latency!
  }

  it('does not grow with the KV round-trip it performs', async () => {
    const fast = await latencyWithKvPaced(0)
    const slow = await latencyWithKvPaced(400)
    expect(Math.abs(slow - fast)).toBeLessThan(250)
  })
})
