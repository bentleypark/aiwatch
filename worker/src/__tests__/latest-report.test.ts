import { describe, it, expect, vi } from 'vitest'
import {
  reportCandidates,
  buildLatestReportSummary,
  readLatestReportSummary,
  refreshLatestReportSummary,
  isReportPublished,
  LATEST_REPORT_KEY,
} from '../latest-report'
import type { KVLike } from '../utils'

const IDS = ['claude', 'claudeai', 'claudecode'] as const
const NOW = new Date('2026-10-16T05:00:00Z')

function makeKV(initial?: Record<string, string>) {
  const store = new Map<string, string>(Object.entries(initial ?? {}))
  return {
    get: vi.fn(async (k: string) => store.get(k) ?? null),
    put: vi.fn(async (k: string, v: string) => { store.set(k, v) }),
    delete: vi.fn(async (k: string) => { store.delete(k) }),
    _store: store,
  } as unknown as KVLike & { _store: Map<string, string>; put: ReturnType<typeof vi.fn> }
}

const archive = (n: number) => JSON.stringify({ services: {
  claude: { incidents: n, totalDowntimeMin: 687 },
  claudeai: { incidents: 9, totalDowntimeMin: 635 },
  claudecode: { incidents: 7 },
  openai: { incidents: 3, totalDowntimeMin: 1 },
} })

const stored = (month: string) => JSON.stringify(buildLatestReportSummary(JSON.parse(archive(18)), month, IDS))

const published = (months: string[]) => async (url: string) => months.some((m) => url.endsWith(`/${m}/`))

describe('reportCandidates', () => {
  it('lists the last two closed months, newest first, across a year boundary', () => {
    expect(reportCandidates(NOW)).toEqual(['2026-09', '2026-08'])
    expect(reportCandidates(new Date('2027-01-03T00:00:00Z'))).toEqual(['2026-12', '2026-11'])
  })
})

describe('buildLatestReportSummary', () => {
  it('takes the report\'s incidents and total downtime for the requested surfaces only', () => {
    expect(buildLatestReportSummary(JSON.parse(archive(9)), '2026-09', IDS)).toEqual({
      month: '2026-09',
      url: 'https://ai-watch.dev/reports/2026-09/',
      services: [
        { id: 'claude', incidents: 9, downtimeMin: 687 },
        { id: 'claudeai', incidents: 9, downtimeMin: 635 },
        { id: 'claudecode', incidents: 7, downtimeMin: null },
      ],
    })
  })

  it('returns null for an archive without the surfaces', () => {
    expect(buildLatestReportSummary({ services: {} }, '2026-09', IDS)).toBeNull()
    expect(buildLatestReportSummary(null, '2026-09', IDS)).toBeNull()
  })
})

describe('refreshLatestReportSummary', () => {
  it('skips an unpublished month and writes the newest published one', async () => {
    const kv = makeKV({ 'archive:monthly:2026-09': archive(9), 'archive:monthly:2026-08': archive(18) })
    expect(await refreshLatestReportSummary(kv, NOW, IDS, published(['2026-08']))).toBe('written')
    expect(JSON.parse(kv._store.get(LATEST_REPORT_KEY)!).month).toBe('2026-08')
  })

  it('moves to the new month once it is published', async () => {
    const kv = makeKV({ 'archive:monthly:2026-09': archive(9), [LATEST_REPORT_KEY]: stored('2026-08') })
    expect(await refreshLatestReportSummary(kv, NOW, IDS, published(['2026-09', '2026-08']))).toBe('written')
    expect(JSON.parse(kv._store.get(LATEST_REPORT_KEY)!).services[0].incidents).toBe(9)
  })

  it('does not fetch again or write when the newest published month is already stored', async () => {
    const kv = makeKV({ [LATEST_REPORT_KEY]: stored('2026-08') })
    const check = vi.fn(published(['2026-08']))
    expect(await refreshLatestReportSummary(kv, NOW, IDS, check)).toBe('current')
    expect(check).toHaveBeenCalledTimes(1)
    expect(kv.put).not.toHaveBeenCalled()
  })

  it('stops at an unanswerable page check instead of falling back to the older month', async () => {
    const previous = stored('2026-07')
    const kv = makeKV({ [LATEST_REPORT_KEY]: previous, 'archive:monthly:2026-08': archive(18) })
    const check = async (url: string) => (url.endsWith('/2026-09/') ? null : true)
    expect(await refreshLatestReportSummary(kv, NOW, IDS, check)).toBe('unreadable')
    expect(kv._store.get(LATEST_REPORT_KEY)).toBe(previous)
  })

  it('stops when a published month\'s archive cannot be read, instead of falling back to the older month', async () => {
    const kv = makeKV({ 'archive:monthly:2026-08': archive(18) })
    const get = kv.get
    kv.get = vi.fn(async (k: string) => { if (k === 'archive:monthly:2026-09') throw new Error('kv down'); return get(k) })
    expect(await refreshLatestReportSummary(kv, NOW, IDS, published(['2026-09', '2026-08']))).toBe('unreadable')
    expect(kv.put).not.toHaveBeenCalled()
  })

  it('rewrites a stored value the reader would reject', async () => {
    const kv = makeKV({ [LATEST_REPORT_KEY]: JSON.stringify({ month: '2026-08' }), 'archive:monthly:2026-08': archive(18) })
    expect(await refreshLatestReportSummary(kv, NOW, IDS, published(['2026-08']))).toBe('written')
    expect(await readLatestReportSummary(kv)).not.toBeNull()
  })

  it('leaves the stored value when it cannot be read', async () => {
    const kv = makeKV({ [LATEST_REPORT_KEY]: 'not json', 'archive:monthly:2026-08': archive(18) })
    expect(await refreshLatestReportSummary(kv, NOW, IDS, published(['2026-08']))).toBe('unreadable')
    expect(kv._store.get(LATEST_REPORT_KEY)).toBe('not json')
  })

  it('reports none-published and writes nothing when neither month is out', async () => {
    const kv = makeKV({ 'archive:monthly:2026-09': archive(9) })
    expect(await refreshLatestReportSummary(kv, NOW, IDS, published([]))).toBe('none-published')
    expect(kv.put).not.toHaveBeenCalled()
  })
})

describe('isReportPublished', () => {
  const answering = (status: number) => async () => new Response('', { status })

  it('reads 200 as published, 404 as not yet, and anything else or no answer as unknown', async () => {
    expect(await isReportPublished('u', answering(200))).toBe(true)
    expect(await isReportPublished('u', answering(404))).toBe(false)
    for (const status of [403, 429, 500, 503]) expect(await isReportPublished('u', answering(status))).toBeNull()
    expect(await isReportPublished('u', async () => { throw new Error('timeout') })).toBeNull()
  })
})

describe('readLatestReportSummary', () => {
  it('round-trips a written summary and rejects a malformed one', async () => {
    const kv = makeKV({ 'archive:monthly:2026-08': archive(18) })
    await refreshLatestReportSummary(kv, NOW, IDS, published(['2026-08']))
    expect((await readLatestReportSummary(kv))!.month).toBe('2026-08')
    expect(await readLatestReportSummary(makeKV({ [LATEST_REPORT_KEY]: JSON.stringify({ month: '2026-08', url: 'https://evil.example/', services: [{}] }) }))).toBeNull()
    expect(await readLatestReportSummary(makeKV({ [LATEST_REPORT_KEY]: '{' }))).toBeNull()
  })
})
