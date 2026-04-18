import { describe, it, expect, vi } from 'vitest'
import { appendDetectionLead, readDetectionLeadEntries, formatDetectionLeadSection, detectionLeadKey, computeLeadMs, type DetectionLeadEntry } from '../detection-lead-log'

function mockKV(store: Record<string, string> = {}) {
  return {
    get: vi.fn(async (k: string) => store[k] ?? null),
    put: vi.fn(async (k: string, v: string) => { store[k] = v }),
  } as unknown as KVNamespace
}

const fixedDate = new Date('2026-04-18T12:00:00Z')
const sampleEntry: DetectionLeadEntry = {
  svcId: 'together',
  incId: 'inc-123',
  leadMs: 7 * 60_000, // 7m
  detectedAt: '2026-04-18T11:53:00Z',
  officialAt: '2026-04-18T12:00:00Z',
}

describe('detectionLeadKey', () => {
  it('produces YYYY-MM-DD scoped key', () => {
    expect(detectionLeadKey(fixedDate)).toBe('detection:lead:2026-04-18')
  })
})

describe('computeLeadMs', () => {
  it('returns positive ms when probe detected at least 1m before official', () => {
    expect(computeLeadMs('2026-04-18T11:53:00Z', '2026-04-18T12:00:00Z')).toBe(7 * 60_000)
  })

  it('returns null for sub-minute leads (audit + Discord both skip)', () => {
    // 30s — too short to display as ≥1m, dropped
    expect(computeLeadMs('2026-04-18T11:59:30Z', '2026-04-18T12:00:00Z')).toBeNull()
    // 59s — same
    expect(computeLeadMs('2026-04-18T11:59:01Z', '2026-04-18T12:00:00Z')).toBeNull()
  })

  it('accepts exactly 1m (boundary)', () => {
    expect(computeLeadMs('2026-04-18T11:59:00Z', '2026-04-18T12:00:00Z')).toBe(60_000)
  })

  it('returns null when detection is at or after official (no positive lead)', () => {
    expect(computeLeadMs('2026-04-18T12:00:00Z', '2026-04-18T12:00:00Z')).toBeNull() // tie
    expect(computeLeadMs('2026-04-18T12:05:00Z', '2026-04-18T12:00:00Z')).toBeNull() // late
  })

  it('returns null when lead >= 60min (filters stale `detected:` KV entries)', () => {
    // exactly 60min — excluded
    expect(computeLeadMs('2026-04-18T11:00:00Z', '2026-04-18T12:00:00Z')).toBeNull()
    // 59:59 — included
    expect(computeLeadMs('2026-04-18T11:00:01Z', '2026-04-18T12:00:00Z')).toBe(59 * 60_000 + 59_000)
  })

  it('returns null on invalid ISO strings', () => {
    expect(computeLeadMs('not-a-date', '2026-04-18T12:00:00Z')).toBeNull()
    expect(computeLeadMs('2026-04-18T12:00:00Z', '')).toBeNull()
  })
})

describe('appendDetectionLead', () => {
  it('returns "persisted" + writes new entry to today key with 7d TTL', async () => {
    const store: Record<string, string> = {}
    const kv = mockKV(store)
    const result = await appendDetectionLead(kv, sampleEntry, fixedDate)
    expect(result).toBe('persisted')
    expect(kv.put).toHaveBeenCalledWith(
      'detection:lead:2026-04-18',
      expect.stringContaining('inc-123'),
      { expirationTtl: 7 * 86400 },
    )
    const stored = JSON.parse(store['detection:lead:2026-04-18'])
    expect(stored).toHaveLength(1)
    expect(stored[0]).toEqual(sampleEntry)
  })

  it('appends to existing array preserving order', async () => {
    // Use timestamps consistent with leadMs (12 * 60_000) so isValidEntry doesn't drop the prior entry
    const earlier: DetectionLeadEntry = {
      svcId: 'openai', incId: 'inc-001', leadMs: 12 * 60_000,
      detectedAt: '2026-04-18T11:48:00Z', officialAt: '2026-04-18T12:00:00Z',
    }
    const store: Record<string, string> = {
      'detection:lead:2026-04-18': JSON.stringify([earlier]),
    }
    const kv = mockKV(store)
    await appendDetectionLead(kv, sampleEntry, fixedDate)
    const stored = JSON.parse(store['detection:lead:2026-04-18'])
    expect(stored).toHaveLength(2)
    expect(stored[0].svcId).toBe('openai')
    expect(stored[1].svcId).toBe('together')
  })

  it('idempotent — first returns "persisted", second returns "duplicate" (not failed — benign re-run)', async () => {
    const store: Record<string, string> = {}
    const kv = mockKV(store)
    const first = await appendDetectionLead(kv, sampleEntry, fixedDate)
    const second = await appendDetectionLead(kv, sampleEntry, fixedDate)
    expect(first).toBe('persisted')
    expect(second).toBe('duplicate')
    const stored = JSON.parse(store['detection:lead:2026-04-18'])
    expect(stored).toHaveLength(1)
  })

  it('rejects entry with leadMs < 1m as "failed"', async () => {
    const kv = mockKV({})
    expect(await appendDetectionLead(kv, { ...sampleEntry, leadMs: 0 }, fixedDate)).toBe('failed')
    expect(await appendDetectionLead(kv, { ...sampleEntry, leadMs: 30_000 }, fixedDate)).toBe('failed')
    expect(await appendDetectionLead(kv, { ...sampleEntry, leadMs: -1000 }, fixedDate)).toBe('failed')
    expect(kv.put).not.toHaveBeenCalled()
  })

  it('rejects entry with leadMs >= 60min as "failed"', async () => {
    const kv = mockKV({})
    expect(await appendDetectionLead(kv, { ...sampleEntry, leadMs: 60 * 60_000 }, fixedDate)).toBe('failed')
    expect(await appendDetectionLead(kv, { ...sampleEntry, leadMs: 90 * 60_000 }, fixedDate)).toBe('failed')
    expect(kv.put).not.toHaveBeenCalled()
  })

  it('aborts on persistent KV read failure as "failed" — does NOT overwrite prior data', async () => {
    const kv = {
      get: vi.fn(async () => { throw new Error('KV persistent failure') }),
      put: vi.fn(),
    } as unknown as KVNamespace
    const result = await appendDetectionLead(kv, sampleEntry, fixedDate)
    expect(result).toBe('failed')
    expect(kv.get).toHaveBeenCalledTimes(2) // initial + 1 retry
    expect(kv.put).not.toHaveBeenCalled()
  })

  it('aborts on JSON.parse failure as "failed" — preserves corrupt data for manual recovery', async () => {
    const store: Record<string, string> = { 'detection:lead:2026-04-18': '{not-valid-json' }
    const kv = mockKV(store)
    const result = await appendDetectionLead(kv, sampleEntry, fixedDate)
    expect(result).toBe('failed')
    expect(kv.put).not.toHaveBeenCalled()
    expect(store['detection:lead:2026-04-18']).toBe('{not-valid-json')
  })

  it('aborts on non-array JSON as "failed" — preserve for inspection', async () => {
    const store: Record<string, string> = { 'detection:lead:2026-04-18': '{"foo":"bar"}' }
    const kv = mockKV(store)
    const result = await appendDetectionLead(kv, sampleEntry, fixedDate)
    expect(result).toBe('failed')
    expect(kv.put).not.toHaveBeenCalled()
    expect(store['detection:lead:2026-04-18']).toBe('{"foo":"bar"}')
  })

  it('drops malformed entries from existing array before append', async () => {
    const store: Record<string, string> = {
      'detection:lead:2026-04-18': JSON.stringify([
        { svcId: 'old', incId: 'old-1', leadMs: 5 * 60_000, detectedAt: '2026-04-18T11:00:00Z', officialAt: '2026-04-18T11:05:00Z' },
        { foo: 'bar' },
        { svcId: '', incId: 'x', leadMs: 1, detectedAt: 'a', officialAt: 'b' },
      ]),
    }
    const kv = mockKV(store)
    await appendDetectionLead(kv, sampleEntry, fixedDate)
    const stored = JSON.parse(store['detection:lead:2026-04-18'])
    expect(stored).toHaveLength(2)
    expect(stored.map((e: DetectionLeadEntry) => e.svcId)).toEqual(['old', 'together'])
  })

  it('returns "failed" when kvPut throws', async () => {
    const kv = {
      get: vi.fn(async () => null),
      put: vi.fn(async () => { throw new Error('KV write failed') }),
    } as unknown as KVNamespace
    const result = await appendDetectionLead(kv, sampleEntry, fixedDate)
    expect(result).toBe('failed')
  })

  it('rejects entry where leadMs disagrees with timestamp diff (consistency invariant)', async () => {
    const kv = mockKV({})
    // detectedAt → officialAt diff = 7m, but leadMs claims 5m → inconsistent → drop on read
    const inconsistent: DetectionLeadEntry = {
      svcId: 'svc', incId: 'i', leadMs: 5 * 60_000, // claims 5m
      detectedAt: '2026-04-18T11:53:00Z', officialAt: '2026-04-18T12:00:00Z', // actual 7m
    }
    // The defensive guard at top accepts this (leadMs is in window) — but downstream isValidEntry
    // catches the inconsistency on read in the same call. We test by reading via readDetectionLeadEntries.
    // For the append path, this entry would still write since leadMs alone is in [1m, 60m).
    // Real defense is on the READ path (isValidEntry filter). Test that:
    const store = { 'detection:lead:2026-04-18': JSON.stringify([inconsistent, sampleEntry]) }
    const readKv = mockKV(store)
    const entries = await readDetectionLeadEntries(readKv, fixedDate)
    expect(entries).toEqual([sampleEntry]) // inconsistent dropped
  })

  it('rejects entry with future officialAt beyond skew tolerance (clock-skew defense)', async () => {
    // officialAt 10min in the future from `now` (fixedDate) — beyond 5min skew tolerance
    const future: DetectionLeadEntry = {
      svcId: 'skewed', incId: 'i', leadMs: 5 * 60_000,
      detectedAt: '2026-04-18T12:05:00Z', officialAt: '2026-04-18T12:10:00Z', // both > now
    }
    const store = { 'detection:lead:2026-04-18': JSON.stringify([future, sampleEntry]) }
    const kv = mockKV(store)
    const entries = await readDetectionLeadEntries(kv, fixedDate)
    expect(entries).toEqual([sampleEntry]) // future entry dropped
  })
})

describe('readDetectionLeadEntries', () => {
  it('returns entries from today by default', async () => {
    const store = {
      'detection:lead:2026-04-18': JSON.stringify([sampleEntry]),
    }
    const kv = mockKV(store)
    const entries = await readDetectionLeadEntries(kv, fixedDate)
    expect(entries).toEqual([sampleEntry])
  })

  it('returns empty array when key missing', async () => {
    const kv = mockKV({})
    const entries = await readDetectionLeadEntries(kv, fixedDate)
    expect(entries).toEqual([])
  })

  it('returns empty array when value is malformed JSON (logs error)', async () => {
    const kv = mockKV({ 'detection:lead:2026-04-18': 'not-json' })
    const entries = await readDetectionLeadEntries(kv, fixedDate)
    expect(entries).toEqual([])
  })

  it('reads multiple days when {days: 2} and dedups by (svcId, incId)', async () => {
    // Day boundary fix: daily summary at UTC 09:00 reads today + yesterday so leads from
    // yesterday's 09:00-24:00 window aren't lost. Timestamps internally consistent with leadMs.
    const yesterdayEntry: DetectionLeadEntry = {
      svcId: 'openai', incId: 'inc-y', leadMs: 5 * 60_000,
      detectedAt: '2026-04-17T19:55:00Z', officialAt: '2026-04-17T20:00:00Z',
    }
    const todayEntry: DetectionLeadEntry = sampleEntry
    const overlap: DetectionLeadEntry = { ...todayEntry } // duplicate across day-keys
    const store = {
      'detection:lead:2026-04-17': JSON.stringify([yesterdayEntry, overlap]),
      'detection:lead:2026-04-18': JSON.stringify([todayEntry]),
    }
    const kv = mockKV(store)
    const entries = await readDetectionLeadEntries(kv, fixedDate, { days: 2 })
    expect(entries).toHaveLength(2) // yesterday's + today's, overlap deduped
    const ids = entries.map(e => `${e.svcId}::${e.incId}`).sort()
    expect(ids).toEqual(['openai::inc-y', 'together::inc-123'])
  })

  it('clamps days to [1, 7] (defends against NaN/Infinity/negative/unbounded)', async () => {
    const kv = mockKV({ 'detection:lead:2026-04-18': JSON.stringify([sampleEntry]) })
    // Each call should hit exactly 1 KV read (today only) since all clamp to 1
    for (const days of [0, -5, NaN, Infinity]) {
      vi.mocked(kv.get).mockClear()
      const entries = await readDetectionLeadEntries(kv, fixedDate, { days })
      expect(entries).toEqual([sampleEntry])
      expect(kv.get).toHaveBeenCalledTimes(1) // proves clamp executed (not e.g. 0 iterations)
    }
    // days=10 clamped to 7
    vi.mocked(kv.get).mockClear()
    await readDetectionLeadEntries(kv, fixedDate, { days: 10 })
    expect(kv.get).toHaveBeenCalledTimes(7)
  })

  it('windowMs filter excludes entries with officialAt older than windowStart (prevents cross-day re-reporting)', async () => {
    // Daily summary at UTC 09:00 with windowMs=24h: yesterday's pre-09:00 entries already reported should be excluded
    const lead = 5 * 60_000
    const old: DetectionLeadEntry = {
      svcId: 'old', incId: 'old', leadMs: lead,
      detectedAt: '2026-04-17T07:55:00Z', officialAt: '2026-04-17T08:00:00Z', // 28h ago
    }
    const recent: DetectionLeadEntry = {
      svcId: 'recent', incId: 'recent', leadMs: lead,
      detectedAt: '2026-04-17T19:55:00Z', officialAt: '2026-04-17T20:00:00Z', // 16h ago
    }
    const today: DetectionLeadEntry = {
      svcId: 'today', incId: 'today', leadMs: lead,
      detectedAt: '2026-04-18T04:55:00Z', officialAt: '2026-04-18T05:00:00Z', // 7h ago
    }
    const store = {
      'detection:lead:2026-04-17': JSON.stringify([old, recent]),
      'detection:lead:2026-04-18': JSON.stringify([today]),
    }
    const kv = mockKV(store)
    const entries = await readDetectionLeadEntries(kv, fixedDate, { days: 2, windowMs: 24 * 3_600_000 })
    expect(entries.map(e => e.svcId).sort()).toEqual(['recent', 'today'])
  })

  it('filters out malformed entries on read (no NaNm in Discord)', async () => {
    const store = {
      'detection:lead:2026-04-18': JSON.stringify([
        sampleEntry,
        { svcId: 'bad', leadMs: 'not-a-number' }, // malformed
        null,
        { svcId: '', incId: '', leadMs: 0, detectedAt: '', officialAt: '' }, // empty fields
        { ...sampleEntry, incId: 'bad-iso', detectedAt: 'not-a-date' }, // unparseable detectedAt
        { ...sampleEntry, incId: 'bad-iso2', officialAt: 'garbage' }, // unparseable officialAt
      ]),
    }
    const kv = mockKV(store)
    const entries = await readDetectionLeadEntries(kv, fixedDate)
    expect(entries).toEqual([sampleEntry]) // only valid one returned
  })
})

describe('getWithRetry (transient KV failure handling)', () => {
  it('retries once on transient kv.get throw — succeeds on second attempt', async () => {
    let calls = 0
    const kv = {
      get: vi.fn(async () => {
        calls++
        if (calls === 1) throw new Error('transient KV blip')
        return JSON.stringify([sampleEntry])
      }),
      put: vi.fn(),
    } as unknown as KVNamespace
    // Successful retry → entry already in array → idempotent "duplicate" return (not "failed")
    const result = await appendDetectionLead(kv, sampleEntry, fixedDate)
    expect(calls).toBe(2)
    expect(result).toBe('duplicate')
    expect(kv.put).not.toHaveBeenCalled()
  })

  it('isolates retry-success from idempotency: different entry → "persisted" via retry', async () => {
    // Locks the retry-success behavior independently from the idempotent skip path
    let calls = 0
    const store: Record<string, string> = {}
    const kv = {
      get: vi.fn(async (k: string) => {
        calls++
        if (calls === 1) throw new Error('transient KV blip')
        return store[k] ?? null
      }),
      put: vi.fn(async (k: string, v: string) => { store[k] = v }),
    } as unknown as KVNamespace
    const result = await appendDetectionLead(kv, sampleEntry, fixedDate)
    expect(calls).toBe(2)
    expect(result).toBe('persisted')
    expect(kv.put).toHaveBeenCalled()
  })

  it('aborts after both attempts fail as "failed"', async () => {
    const kv = {
      get: vi.fn(async () => { throw new Error('persistent KV failure') }),
      put: vi.fn(),
    } as unknown as KVNamespace
    const result = await appendDetectionLead(kv, sampleEntry, fixedDate)
    expect(kv.get).toHaveBeenCalledTimes(2)
    expect(result).toBe('failed')
    expect(kv.put).not.toHaveBeenCalled()
  })
})

describe('formatDetectionLeadSection', () => {
  it('returns empty string when no entries (caller skips section)', () => {
    expect(formatDetectionLeadSection([], new Map())).toBe('')
  })

  it('renders single event with service name + lead in minutes', () => {
    const nameMap = new Map([['together', 'Together AI']])
    const out = formatDetectionLeadSection([sampleEntry], nameMap)
    expect(out).toContain('Detection Lead (last 24h)')
    expect(out).toContain('1 event')
    expect(out).toContain('Together AI: 7m lead')
  })

  it('renders multiple events sorted by lead descending (biggest first)', () => {
    const small: DetectionLeadEntry = { ...sampleEntry, svcId: 'openai', incId: 'i2', leadMs: 3 * 60_000 }
    const large: DetectionLeadEntry = { ...sampleEntry, svcId: 'gemini', incId: 'i3', leadMs: 25 * 60_000 }
    const nameMap = new Map([['together', 'Together AI'], ['openai', 'OpenAI'], ['gemini', 'Gemini']])
    const out = formatDetectionLeadSection([sampleEntry, small, large], nameMap)
    // Order: 25m → 7m → 3m
    const geminiIdx = out.indexOf('Gemini')
    const togetherIdx = out.indexOf('Together AI')
    const openaiIdx = out.indexOf('OpenAI')
    expect(geminiIdx).toBeLessThan(togetherIdx)
    expect(togetherIdx).toBeLessThan(openaiIdx)
    expect(out).toContain('3 events')
  })

  it('falls back to svcId when service name missing from map', () => {
    const out = formatDetectionLeadSection([sampleEntry], new Map())
    expect(out).toContain('together: 7m lead')
  })

  it('floors lead milliseconds (never displays 60m for [59m30s, 60m) inputs)', () => {
    // Math.floor — 7m 31s → 7m (not 8m); 59m 59s → 59m (not 60m which would violate the cap)
    const entry7m31s = { ...sampleEntry, leadMs: 7 * 60_000 + 31_000 }
    expect(formatDetectionLeadSection([entry7m31s], new Map([['together', 'Together AI']]))).toContain('Together AI: 7m lead')

    const entry59m59s = { ...sampleEntry, leadMs: 59 * 60_000 + 59_000 }
    const out = formatDetectionLeadSection([entry59m59s], new Map([['together', 'Together AI']]))
    expect(out).toContain('Together AI: 59m lead')
    expect(out).not.toContain('60m')
  })
})
