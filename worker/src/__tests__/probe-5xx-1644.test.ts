import { describe, it, expect } from 'vitest'
import { measuredRtt, probeFailureKind, applyProbeLatency, detectConsecutiveSpikes, isProbeFailing, type ProbeSnapshot, type ProbeResult } from '../probe'
import { aggregateProbeDaily } from '../probe-archival'
import { computeMonthlyLatencyStats } from '../monthly-archive'
import { buildDailySummary, formatProbeFailureLine } from '../daily-summary'
import type { ServiceStatus } from '../types'

// Shapes taken from prod `probe:24h` (2026-10-03 → 10-08): helicone answered 502 at a normal-looking
// RTT; deepgram timed out (`failedProbe()` → status 0, rtt -1); openai's 429 came back in a few ms.
const ok = (rtt: number, status = 401): ProbeResult => ({ status, rtt })
const e502 = (rtt: number): ProbeResult => ({ status: 502, rtt })
const timeout: ProbeResult = { status: 0, rtt: -1 }

function snaps(series: ProbeResult[], id = 'helicone'): ProbeSnapshot[] {
  return series.map((r, i) => ({ t: new Date(Date.UTC(2026, 9, 5, 0, i * 5)).toISOString(), data: { [id]: r } }))
}

describe('#1644 measuredRtt — a 5xx or a timeout measured no RTT', () => {
  it.each([
    [ok(1800, 200), 1800], [ok(140, 401), 140], [ok(90, 403), 90], [ok(120, 405), 120], [ok(300, 422), 300],
    [ok(3, 429), 3], // recorded, not judged — #576
  ])('%o → %s', (r, expected) => expect(measuredRtt(r)).toBe(expected))

  it.each([[e502(1584)], [{ status: 503, rtt: 380 }], [{ status: 500, rtt: 20 }], [timeout], [undefined]])('%o → null', (r) => {
    expect(measuredRtt(r)).toBeNull()
  })

  it('probeFailureKind classifies each failure and leaves a live answer unclassified', () => {
    expect(probeFailureKind(timeout)).toBe('timeout')
    expect(probeFailureKind(e502(1584))).toBe('http5xx')
    expect(probeFailureKind(ok(3, 429))).toBe('http429')
    expect(probeFailureKind(ok(140, 401))).toBeNull()
    expect(probeFailureKind(ok(1800, 200))).toBeNull()
  })
})

describe('#1644 applyProbeLatency — a 5xx publishes no latency', () => {
  it('nulls the 502 service and keeps the 4xx one', () => {
    const services = [{ id: 'helicone', latency: 999 as number | null }, { id: 'claude', latency: null as number | null }]
    applyProbeLatency(services, [{ t: '2026-10-08T06:55:00Z', data: { helicone: e502(1436), claude: ok(193) } }])
    expect(services.map((s) => s.latency)).toEqual([null, 193])
  })
})

describe('#1644 detectConsecutiveSpikes — a 5xx counts toward the streak', () => {
  it('a 502 tail at a normal RTT is a streak; the same tail answered 200 is not', () => {
    const base = Array.from({ length: 20 }, (_, i) => ok(1800 + (i % 4) * 100, 200))
    const tail = [1500, 1600, 1550]
    expect(detectConsecutiveSpikes(snaps([...base, ...tail.map(e502)]), ['helicone'])).toEqual([
      expect.objectContaining({ serviceId: 'helicone', consecutiveCount: 3 }),
    ])
    expect(detectConsecutiveSpikes(snaps([...base, ...tail.map((r) => ok(r, 200))]), ['helicone'])).toEqual([])
  })

  it('a window of nothing but 502s is a streak', () => {
    const spikes = detectConsecutiveSpikes(snaps(Array.from({ length: 6 }, () => e502(1500))), ['helicone'])
    expect(spikes).toEqual([expect.objectContaining({ consecutiveCount: 6, avgRtt: 0 })])
  })

  it('isProbeFailing — the status-verdict path #576 owns — reads a mixed 502/200 window as before', () => {
    const now = Date.now()
    const series = Array.from({ length: 40 }, (_, i) => (i % 2 === 0 || i >= 37 ? e502(1500) : ok(200, 200)))
    const window = series.map((r, i) => ({ t: new Date(now - (39 - i) * 60_000).toISOString(), data: { helicone: r } }))
    expect(isProbeFailing(window, 'helicone')).toBe(false)
  })
})

describe('#1644 aggregateProbeDaily — failures by kind, percentiles from measured RTTs only', () => {
  it('a day of 502s has no percentiles, and counts every sample as a failed spike', () => {
    const day = aggregateProbeDaily(snaps(Array.from({ length: 288 }, (_, i) => e502(1400 + (i % 9) * 100))))
    expect(day.helicone).toEqual({ p50: 0, p75: 0, p95: 0, min: 0, max: 0, count: 288, spikes: 288, failures: { timeout: 0, http5xx: 288, http429: 0 } })
  })

  it('a mixed day takes p50 from the 200s only and records each failure kind', () => {
    const series = [
      ...Array.from({ length: 10 }, (_, i) => ok(2000 + i * 10, 200)),
      e502(100), e502(110), e502(120), e502(130),
      timeout, timeout,
      ok(5, 429),
    ]
    const stat = aggregateProbeDaily(snaps(series)).helicone
    expect(stat.failures).toEqual({ timeout: 2, http5xx: 4, http429: 1 })
    expect(stat.count).toBe(17)
    expect(stat.min).toBe(5) // the 429 is still a measured RTT (#576 owns its verdict)
    expect(stat.p50).toBe(2030) // from [5, 2000…2090] — with the 100–130ms 502s inside, it reads 2010
    expect(stat.spikes).toBe(6 + 0) // 2 timeouts + 4 5xx; nothing in the measured set is >3× median
  })
})

describe('#1644 computeMonthlyLatencyStats — failures summed into the archive', () => {
  it('sums the days that recorded failures and is null when none did', () => {
    const f = (timeout: number, http5xx: number, http429: number) => ({ timeout, http5xx, http429 })
    const stats = computeMonthlyLatencyStats({
      '2026-10-03': { helicone: { p50: 1800, p75: 2000, p95: 2300, min: 900, max: 2500, count: 288, spikes: 198, failures: f(0, 198, 0) }, claude: { p50: 190, p75: 210, p95: 250, min: 50, max: 300, count: 288, spikes: 1 } },
      '2026-10-04': { helicone: { p50: 0, p75: 0, p95: 0, min: 0, max: 0, count: 288, spikes: 288, failures: f(1, 287, 0) }, claude: { p50: 190, p75: 210, p95: 250, min: 50, max: 300, count: 288, spikes: 0 } },
    })
    expect(stats.helicone.failures).toEqual(f(1, 485, 0))
    expect(stats.claude.failures).toBeNull() // pre-#1644 days carry no breakdown — not "zero failures"
  })
})

describe('#1644 daily report — a Probe failures line, and Spikes counts slow responses only', () => {
  const services = [
    { id: 'helicone', name: 'Helicone' }, { id: 'deepgram', name: 'Deepgram' }, { id: 'claude', name: 'Claude' },
    { id: 'openai', name: 'OpenAI' }, { id: 'gemini', name: 'Gemini' },
  ].map((s) => ({ ...s, status: 'operational', category: 'api', incidents: [] })) as unknown as ServiceStatus[]

  it('names a kind at or above the ratio floor and omits one below it', () => {
    const line = formatProbeFailureLine({
      helicone: { p50: 0, p75: 0, p95: 0, min: 0, max: 0, count: 288, spikes: 288, failures: { timeout: 0, http5xx: 288, http429: 0 } },
      deepgram: { p50: 300, p75: 320, p95: 400, min: 200, max: 500, count: 288, spikes: 48, failures: { timeout: 48, http5xx: 0, http429: 0 } },
      openai: { p50: 150, p75: 160, p95: 200, min: 3, max: 300, count: 288, spikes: 0, failures: { timeout: 0, http5xx: 0, http429: 3 } },
    }, new Map(services.map((s) => [s.id, s.name])))
    expect(line).toContain('Helicone 5xx 288/288')
    expect(line).toContain('Deepgram timeout 48/288')
    expect(line).not.toContain('OpenAI')
  })

  it('names a 429 rate at or above the floor', () => {
    const line = formatProbeFailureLine({
      openai: { p50: 150, p75: 160, p95: 200, min: 3, max: 300, count: 288, spikes: 0, failures: { timeout: 0, http5xx: 0, http429: 15 } },
    }, new Map([['openai', 'OpenAI']]))
    expect(line).toContain('OpenAI 429 15/288')
  })

  it('counts the last 24h of the 7-day probe window only', () => {
    const at = (h: number) => new Date(Date.UTC(2026, 9, 7, 0) + h * 3_600_000).toISOString()
    const probeSnapshots: ProbeSnapshot[] = Array.from({ length: 48 }, (_, h) => ({
      t: at(h),
      data: { helicone: h < 24 ? e502(1500) : ok(1800, 200), claude: ok(190), openai: ok(150), gemini: ok(80) },
    }))
    const text = buildDailySummary({ services, probeSnapshots, aiUsage: null, incidentCountToday: { newCount: 0, resolvedCount: 0 }, redditCount: 0 })
    expect(text).not.toContain('Probe failures')
    probeSnapshots[46].data.helicone = e502(1500)
    probeSnapshots[47].data.helicone = e502(1500)
    expect(buildDailySummary({ services, probeSnapshots, aiUsage: null, incidentCountToday: { newCount: 0, resolvedCount: 0 }, redditCount: 0 }))
      .toContain('Helicone 5xx 2/24')
  })

  it('wires both into the summary from the real probe window', () => {
    const t = (i: number) => new Date(Date.UTC(2026, 9, 7, 0, i * 5)).toISOString()
    const probeSnapshots: ProbeSnapshot[] = Array.from({ length: 40 }, (_, i) => ({
      t: t(i),
      data: {
        helicone: e502(1500 + (i % 5) * 50),
        claude: ok(i === 39 ? 5000 : 190 + (i % 3) * 10),
        openai: ok(150 + (i % 4) * 5),
        gemini: ok(80 + (i % 2) * 10),
        deepgram: i % 10 === 0 ? timeout : ok(300),
      },
    }))
    const text = buildDailySummary({ services, probeSnapshots, aiUsage: null, incidentCountToday: { newCount: 0, resolvedCount: 0 }, redditCount: 0 })
    expect(text).toContain('Probe failures (24h)')
    expect(text).toContain('Helicone 5xx 40/40')
    expect(text).toContain('Deepgram timeout 4/40')
    expect(text).toMatch(/Spikes: Claude \(1\)/) // the one slow sample
    expect(text).not.toMatch(/Spikes:[^\n]*Deepgram/) // its timeouts are failures, not slow responses
    expect(text).not.toMatch(/Fastest:[^\n]*Helicone|Slowest:[^\n]*Helicone/)
  })
})
