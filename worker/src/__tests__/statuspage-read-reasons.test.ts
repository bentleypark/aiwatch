import { describe, expect, it, vi, afterEach } from 'vitest'
import { fetchService, SERVICES, sourceFetchFailureReason, statuspageSummaryFailureReason } from '../services'
import { parseParseFailDay } from '../parse-failure-log'
import { mockKV } from './helpers/unreadable-source'

const claudeai = SERVICES.find((service) => service.id === 'claudeai')!

afterEach(() => vi.unstubAllGlobals())

describe('#1470 Statuspage source-read reasons', () => {
  it('derives the daily-summary roster from current apiUrl config', () => {
    expect(SERVICES.filter((service) => service.apiUrl)).toHaveLength(30)
  })

  it('assigns a bounded reason to every fetch-dispatch source configuration', () => {
    const dispatched = SERVICES.filter((service) =>
      service.cloudflareStatusComponentIds || service.datadogStatusUrl || service.apiUrl || service.awsHealthApi ||
      service.azureRssUrl || service.rssFeedUrl || service.gcloudProduct || service.instatusUrl || service.betterStackUrl,
    )
    expect(dispatched.filter((service) => sourceFetchFailureReason(service) == null)).toEqual([])
  })

  it.each([
    ['text/html', 'statuspage-non-json'],
    ['application/json', 'statuspage-summary-unreadable'],
    [null, 'statuspage-non-json'],
  ] as const)('classifies a non-summary %s body by the recoverable reason', (contentType, expected) => {
    expect(statuspageSummaryFailureReason(contentType)).toBe(expected)
  })

  it('records the direct Statuspage summary failure that the daily summary can display', async () => {
    const kv = mockKV()
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('summary.json')) return new Response('<html>challenge</html>', { status: 200, headers: { 'content-type': 'text/html' } })
      return new Response(JSON.stringify({ incidents: [] }), { status: 200, headers: { 'content-type': 'application/json' } })
    }))

    await fetchService(claudeai, undefined, kv as never, {})

    const key = Object.keys(kv.store).find((candidate) => candidate.startsWith('instatus-parse-fail:'))!
    expect(parseParseFailDay(kv.store[key]).counts.claudeai).toEqual({ 'statuspage-non-json': 1 })
  })
})
