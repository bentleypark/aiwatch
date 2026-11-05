import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { recordDrop, buildDropSql, parseDropResponse, queryDrops, formatDropLine, DROP_SITES, DROP_ACTIONS, type DropReason } from '../drop-log'
import { getStaleSources, readStaleSourcesCounted } from '../changelog'
import { buildDailySummary } from '../daily-summary'

const wae = () => ({ writeDataPoint: vi.fn() })

describe('#1257 recordDrop', () => {
  it('a drop writes exactly one point, indexed by its site', () => {
    const a = wae()
    recordDrop(a as unknown as AnalyticsEngineDataset, 'probe-snapshot', 'read-failed')
    expect(a.writeDataPoint).toHaveBeenCalledTimes(1)
    expect(a.writeDataPoint).toHaveBeenCalledWith({ blobs: ['probe-snapshot', 'read-failed'], doubles: [1], indexes: ['drop:probe-snapshot'] })
  })

  it('records nothing with no binding', () => {
    expect(() => recordDrop(undefined, 'probe-snapshot', 'read-failed')).not.toThrow()
  })

  it('a throwing binding never reaches the caller', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const a = { writeDataPoint: vi.fn(() => { throw new Error('quota') }) }
    expect(() => recordDrop(a as unknown as AnalyticsEngineDataset, 'probe-snapshot', 'read-failed')).not.toThrow()
    vi.restoreAllMocks()
  })
})

describe('#1257 reading drops back', () => {
  it('the query reads every site\'s index, weighted by the sample interval', () => {
    const sql = buildDropSql()
    for (const s of DROP_SITES) expect(sql).toContain(`'drop:${s}'`)
    expect(sql).toContain('SUM(_sample_interval * double1)')
    expect(sql).toContain("INTERVAL '1' DAY")
  })

  it('an unreadable response is null, not an empty list', () => {
    expect(parseDropResponse({})).toBeNull()
    expect(parseDropResponse(null)).toBeNull()
    expect(parseDropResponse({ data: [] })).toEqual([])
  })

  it('keeps valid rows, largest first', () => {
    expect(parseDropResponse({ data: [
      { site: 'stale-sources', reason: 'source-read-failed', n: '2' },
      { site: 'probe-snapshot', reason: 'read-failed', n: 22 },
      { site: 'probe-snapshot', reason: 'x', n: 0 },
      { site: 7, reason: 'x', n: 1 },
    ] })).toEqual([
      { site: 'probe-snapshot', reason: 'read-failed', n: 22 },
      { site: 'stale-sources', reason: 'source-read-failed', n: 2 },
    ])
  })

  it('queryDrops: no credentials or a failed HTTP call is null; a good response is parsed', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(await queryDrops(undefined, 't')).toBeNull()
    expect(await queryDrops('a', 't', vi.fn(async () => new Response('x', { status: 500 })) as unknown as typeof fetch)).toBeNull()
    const ok = vi.fn(async () => new Response(JSON.stringify({ data: [{ site: 'probe-snapshot', reason: 'read-failed', n: 1 }] })))
    expect(await queryDrops('a', 't', ok as unknown as typeof fetch)).toEqual([{ site: 'probe-snapshot', reason: 'read-failed', n: 1 }])
    vi.restoreAllMocks()
  })

  it('queryDrops: a rejected fetch or a non-JSON 200 is null, never a throw into the daily summary', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const rejected = vi.fn(async () => { throw new TypeError('network') })
    expect(await queryDrops('a', 't', rejected as unknown as typeof fetch)).toBeNull()
    const html = vi.fn(async () => new Response('<html>', { status: 200 }))
    expect(await queryDrops('a', 't', html as unknown as typeof fetch)).toBeNull()
    vi.restoreAllMocks()
  })

  it('queryDrops: a missing token sends no request', async () => {
    const f = vi.fn()
    expect(await queryDrops('a', undefined, f as unknown as typeof fetch)).toBeNull()
    expect(f).not.toHaveBeenCalled()
  })

  it('the line tells unreadable, none and some apart', () => {
    expect(formatDropLine(null).split('\n')[0]).toBe('🧮 **Silent drops** (24h): unreadable')
    expect(formatDropLine(undefined).split('\n')[0]).toBe('🧮 **Silent drops** (24h): unreadable')
    expect(formatDropLine([])).toBe('🧮 **Silent drops** (24h): none')
    expect(formatDropLine([{ site: 'probe-snapshot', reason: 'read-failed', n: 22 }, { site: 'stale-sources', reason: 'read-failed', n: 1 }]).split('\n')[0])
      .toBe('🧮 **Silent drops** (24h): probe-snapshot · read-failed ×22, stale-sources · read-failed ×1')
  })

  it.each(Object.keys(DROP_ACTIONS) as DropReason[])('a %s drop carries its action, once', (reason) => {
    const lines = formatDropLine([{ site: 'probe-snapshot', reason, n: 2 }, { site: 'stale-sources', reason, n: 1 }]).split('\n')
    expect(lines.slice(1)).toEqual([`   ↳ ${reason}: ${DROP_ACTIONS[reason]}`])
  })

  it('each reason in the line gets its own action; an unknown reason gets none', () => {
    const lines = formatDropLine([
      { site: 'probe-snapshot', reason: 'window-unreadable', n: 22 },
      { site: 'probe-snapshot', reason: 'from-an-older-deploy', n: 3 },
      { site: 'stale-sources', reason: 'source-read-failed', n: 1 },
    ]).split('\n')
    expect(lines[0]).toContain('stale-sources · source-read-failed ×1')
    expect(lines.slice(1)).toEqual([
      `   ↳ window-unreadable: ${DROP_ACTIONS['window-unreadable']}`,
      `   ↳ source-read-failed: ${DROP_ACTIONS['source-read-failed']}`,
    ])
    expect(formatDropLine([{ site: 'probe-snapshot', reason: 'toString', n: 1 }]).split('\n')).toHaveLength(1)
  })

  it('a drop that names its source shows it, and the source survives the read-back', () => {
    const rows = parseDropResponse({ data: [
      { site: 'stale-sources', reason: 'source-read-failed', detail: 'openai', n: 1 },
      { site: 'stale-sources', reason: 'source-read-failed', detail: 'google', n: 1 },
      { site: 'probe-snapshot', reason: 'read-failed', detail: '', n: 2 },
    ] })
    expect(formatDropLine(rows).split('\n')[0]).toBe('🧮 **Silent drops** (24h): probe-snapshot · read-failed ×2, stale-sources · source-read-failed (google) ×1, stale-sources · source-read-failed (openai) ×1')
    expect(buildDropSql()).toContain('GROUP BY blob1, blob2, blob3')
  })

  it('unreadable says where to look; none needs no action', () => {
    expect(formatDropLine(null).split('\n')[1]).toMatch(/^ {3}↳ .*CF_ANALYTICS_TOKEN/)
    expect(formatDropLine([]).split('\n')).toHaveLength(1)
  })

  it('reaches the posted daily summary in every state, including when the caller passed nothing', () => {
    const base = { services: [], aiUsage: null, incidentCountToday: { newCount: 0, resolvedCount: 0 }, redditCount: 0 }
    expect(buildDailySummary({ ...base, drops: [] } as never)).toContain('Silent drops** (24h): none')
    expect(buildDailySummary({ ...base, drops: null } as never)).toContain('Silent drops** (24h): unreadable')
    expect(buildDailySummary(base as never)).toContain('Silent drops** (24h): unreadable')
  })
})

describe('#1257 consumers', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('ok', { status: 200 })))
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

  const loadWriter = async () => { vi.resetModules(); return await import('../index') }
  const kvWith = (get: () => Promise<string | null>, put: () => Promise<void> = async () => undefined) => ({ get: vi.fn(get), put: vi.fn(put) })
  const reasons = (a: ReturnType<typeof wae>) => a.writeDataPoint.mock.calls.map((c) => (c[0] as { blobs: string[] }).blobs.join('/'))

  it('a probe slot skipped on a failed read is counted', async () => {
    const { writeProbeSnapshot } = await loadWriter()
    const a = wae()
    await writeProbeSnapshot(kvWith(async () => { throw new Error('KV down') }) as unknown as KVNamespace, a as unknown as AnalyticsEngineDataset)
    expect(reasons(a)).toEqual(['probe-snapshot/read-failed'])
  })

  it('a probe slot skipped on an unreadable window is counted', async () => {
    const { writeProbeSnapshot } = await loadWriter()
    const a = wae()
    await writeProbeSnapshot(kvWith(async () => '{}') as unknown as KVNamespace, a as unknown as AnalyticsEngineDataset)
    expect(reasons(a)).toEqual(['probe-snapshot/window-unreadable'])
  })

  it('a probe slot whose write is rejected is counted', async () => {
    const { writeProbeSnapshot } = await loadWriter()
    const a = wae()
    await writeProbeSnapshot(kvWith(async () => null, async () => { throw new Error('put rejected') }) as unknown as KVNamespace, a as unknown as AnalyticsEngineDataset)
    expect(reasons(a)).toEqual(['probe-snapshot/write-rejected'])
  })

  it('a probe slot that is written records nothing', async () => {
    const { writeProbeSnapshot } = await loadWriter()
    const a = wae()
    const kv = kvWith(async () => null)
    await writeProbeSnapshot(kv as unknown as KVNamespace, a as unknown as AnalyticsEngineDataset)
    expect(kv.put).toHaveBeenCalledTimes(1)
    expect(a.writeDataPoint).not.toHaveBeenCalled()
  })

  it('getStaleSources reports each source it could not read, and none it could', async () => {
    const failed: string[] = []
    let calls = 0
    const kv = { get: vi.fn(async () => { if (calls++ === 0) throw new Error('KV down'); return new Date().toISOString() }) }
    await getStaleSources(kv as unknown as KVNamespace, undefined, (id) => failed.push(id))
    expect(failed).toHaveLength(1)
    const none: string[] = []
    await getStaleSources({ get: vi.fn(async () => new Date().toISOString()) } as unknown as KVNamespace, undefined, (id) => none.push(id))
    expect(none).toEqual([])
  })

  it('the weekly read counts each unreadable source, and nothing when every read succeeds', async () => {
    let calls = 0
    const a = wae()
    await readStaleSourcesCounted({ get: vi.fn(async () => { if (calls++ < 2) throw new Error('KV down'); return new Date().toISOString() }) } as unknown as KVNamespace, a as unknown as AnalyticsEngineDataset)
    expect(reasons(a)).toEqual(['stale-sources/source-read-failed/openai', 'stale-sources/source-read-failed/google'])
    const quiet = wae()
    await readStaleSourcesCounted({ get: vi.fn(async () => new Date().toISOString()) } as unknown as KVNamespace, quiet as unknown as AnalyticsEngineDataset)
    expect(quiet.writeDataPoint).not.toHaveBeenCalled()
  })
})
