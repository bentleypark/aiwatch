import { describe, it, expect, vi } from 'vitest'
import { formatDuration, trackFetchFailure, resetFetchFailure, trackComponentMiss, resetComponentMiss, readTrackingState, writeTrackingStateIfChanged, diffPageComponents, formatNewComponentAlert, isAllowedAlertWebhook, shouldAlertPersistentFailure, formatPersistentFailureAlert, appendStatusHint, appendUtm, worstUnresolvedImpact, countsAsUptimeOk, isNonReliabilityAdvisory, parseSnapshotWindow, PERSISTENT_FAILURE_THRESHOLD_MS, type KVLike, type TrackingStateBlob } from '../utils'
import type { Incident } from '../types'

describe('appendStatusHint (#539)', () => {
  it('uses ? when the URL has no query, & when it already has one', () => {
    expect(appendStatusHint('https://ai-watch.dev/is-claude-down', 'resolved')).toBe('https://ai-watch.dev/is-claude-down?e=resolved')
    expect(appendStatusHint('https://ai-watch.dev/is-claude-down?ref=x', 'down')).toBe('https://ai-watch.dev/is-claude-down?ref=x&e=down')
  })

  it('url-encodes the hint value', () => {
    expect(appendStatusHint('https://x.dev/p', 'a b')).toBe('https://x.dev/p?e=a%20b')
  })
})

describe('appendUtm (#548)', () => {
  it('appends channel-specific utm (rss → medium=feed, reddit → medium=social), campaign=outage', () => {
    expect(appendUtm('https://ai-watch.dev/is-claude-down', 'rss')).toBe('https://ai-watch.dev/is-claude-down?utm_source=rss&utm_medium=feed&utm_campaign=outage')
    expect(appendUtm('https://ai-watch.dev/is-claude-down', 'reddit')).toBe('https://ai-watch.dev/is-claude-down?utm_source=reddit&utm_medium=social&utm_campaign=outage')
  })

  it('uses & when the URL already has a query (e.g. after the ?e= status hint)', () => {
    expect(appendUtm(appendStatusHint('https://ai-watch.dev/is-openai-down', 'down'), 'rss'))
      .toBe('https://ai-watch.dev/is-openai-down?e=down&utm_source=rss&utm_medium=feed&utm_campaign=outage')
  })

  // #936 — discord (notification) keeps campaign=outage; statusline (always-on nav) drops the campaign.
  it('tags the discord alert channel with medium=notification & campaign=outage', () => {
    expect(appendUtm('https://ai-watch.dev/is-claude-down', 'discord'))
      .toBe('https://ai-watch.dev/is-claude-down?utm_source=discord&utm_medium=notification&utm_campaign=outage')
  })

  it('tags statusline with medium=referral and NO outage campaign', () => {
    expect(appendUtm('https://ai-watch.dev', 'statusline'))
      .toBe('https://ai-watch.dev?utm_source=statusline&utm_medium=referral')
  })

  // #936 — a hash-routed dashboard link (ai-watch.dev/#claude) needs the query BEFORE the '#' so GA4
  // (which reads location.search) sees it. The fragment must stay last.
  it('inserts the query before the fragment on a hash-routed dashboard link', () => {
    expect(appendUtm('https://ai-watch.dev/#claude', 'discord'))
      .toBe('https://ai-watch.dev/?utm_source=discord&utm_medium=notification&utm_campaign=outage#claude')
    expect(appendUtm('https://ai-watch.dev/#openai', 'statusline'))
      .toBe('https://ai-watch.dev/?utm_source=statusline&utm_medium=referral#openai')
  })
})

function mockKV(store: Record<string, string> = {}): KVLike {
  return {
    get: vi.fn(async (key: string) => store[key] ?? null),
    put: vi.fn(async (key: string, value: string) => { store[key] = value }),
    delete: vi.fn(async (key: string) => { delete store[key] }),
  }
}

describe('isAllowedAlertWebhook (SSRF allow-list, #467 + #468)', () => {
  it('accepts an HTTPS discord.com webhook URL', () => {
    expect(isAllowedAlertWebhook('https://discord.com/api/webhooks/123456789/abcDEF-token')).toBe(true)
  })

  it('accepts the legacy + beta Discord hosts (#468)', () => {
    expect(isAllowedAlertWebhook('https://discordapp.com/api/webhooks/123/abc')).toBe(true)
    expect(isAllowedAlertWebhook('https://canary.discord.com/api/webhooks/123/abc')).toBe(true)
    expect(isAllowedAlertWebhook('https://ptb.discord.com/api/webhooks/123/abc')).toBe(true)
  })

  it('accepts any real *.discord.com subdomain (the wildcard is intentional — Discord owns the zone)', () => {
    expect(isAllowedAlertWebhook('https://foo.discord.com/api/webhooks/123/abc')).toBe(true)
    expect(isAllowedAlertWebhook('https://a.b.discord.com/api/webhooks/123/abc')).toBe(true)
  })

  it('normalizes host via the URL parser (uppercase host still matches)', () => {
    // URL.hostname lowercases — guards against a future hand-rolled case-sensitive host check.
    expect(isAllowedAlertWebhook('https://DISCORD.COM/api/webhooks/123/abc')).toBe(true)
  })

  it('rejects authority-confusion / userinfo bypass (the canonical SSRF allow-list trick)', () => {
    // URL.hostname resolves to evil.tld here; a string-match on the raw URL would wrongly allow it.
    expect(isAllowedAlertWebhook('https://discord.com@evil.tld/api/webhooks/123/abc')).toBe(false)
    expect(isAllowedAlertWebhook('https://evil.tld/#@discord.com/api/webhooks/123/abc')).toBe(false)
  })

  it('accepts version-prefixed webhook paths (#468)', () => {
    expect(isAllowedAlertWebhook('https://discord.com/api/v10/webhooks/123/abc')).toBe(true)
    expect(isAllowedAlertWebhook('https://discord.com/api/v9/webhooks/123/abc')).toBe(true)
  })

  it('rejects non-HTTPS schemes', () => {
    expect(isAllowedAlertWebhook('http://discord.com/api/webhooks/123/abc')).toBe(false)
    expect(isAllowedAlertWebhook('ftp://discord.com/api/webhooks/123/abc')).toBe(false)
  })

  it('rejects look-alike hosts (the leading-dot guard blocks suffix/substring bypass)', () => {
    expect(isAllowedAlertWebhook('https://evildiscord.com/api/webhooks/123/abc')).toBe(false)       // no leading dot
    expect(isAllowedAlertWebhook('https://discord.com.evil.tld/api/webhooks/123/abc')).toBe(false)  // ends in .evil.tld
    expect(isAllowedAlertWebhook('https://notdiscord.com/api/webhooks/123/abc')).toBe(false)
    expect(isAllowedAlertWebhook('https://discordapp.com.evil.tld/api/webhooks/123/abc')).toBe(false)
    expect(isAllowedAlertWebhook('https://hooks.slack.com/services/T/B/x')).toBe(false)
    // Label-less / trailing-dot host edges — the regex requires real labels + exact suffix.
    expect(isAllowedAlertWebhook('https://.discord.com/api/webhooks/123/abc')).toBe(false)
    expect(isAllowedAlertWebhook('https://discord.com./api/webhooks/123/abc')).toBe(false)
  })

  it('rejects Discord hosts whose path is not a webhook path', () => {
    expect(isAllowedAlertWebhook('https://discord.com/api/users/@me')).toBe(false)
    expect(isAllowedAlertWebhook('https://discord.com/api/v10/users/@me')).toBe(false)
    expect(isAllowedAlertWebhook('https://discord.com/webhooks/123/abc')).toBe(false) // missing /api/ prefix
    expect(isAllowedAlertWebhook('https://discord.com/')).toBe(false)
  })

  it('rejects unparseable input instead of throwing', () => {
    expect(isAllowedAlertWebhook('not a url')).toBe(false)
    expect(isAllowedAlertWebhook('')).toBe(false)
  })
})

describe('formatDuration', () => {
  it('returns 1m for durations under 60 seconds (ceil to 1m)', () => {
    const start = new Date('2026-03-23T10:00:00Z')
    const end = new Date('2026-03-23T10:00:30Z') // 30s
    expect(formatDuration(start, end)).toBe('1m')
  })

  it('returns 1m for 0 second duration', () => {
    const d = new Date('2026-03-23T10:00:00Z')
    expect(formatDuration(d, d)).toBe('1m')
  })

  it('returns 1m for exactly 60 seconds', () => {
    const start = new Date('2026-03-23T10:00:00Z')
    const end = new Date('2026-03-23T10:01:00Z')
    expect(formatDuration(start, end)).toBe('1m')
  })

  it('returns minutes for sub-hour durations', () => {
    const start = new Date('2026-03-23T10:00:00Z')
    const end = new Date('2026-03-23T10:45:00Z')
    expect(formatDuration(start, end)).toBe('45m')
  })

  it('returns hours and minutes for longer durations', () => {
    const start = new Date('2026-03-23T10:00:00Z')
    const end = new Date('2026-03-23T12:30:00Z')
    expect(formatDuration(start, end)).toBe('2h 30m')
  })

  it('returns Xh 0m when minutes are exactly zero', () => {
    const start = new Date('2026-03-23T10:00:00Z')
    const end = new Date('2026-03-23T13:00:00Z')
    expect(formatDuration(start, end)).toBe('3h 0m')
  })
})

describe('trackFetchFailure (#1224 — blob-based)', () => {
  it('returns false on first failure (count=1, threshold=3)', async () => {
    const store: TrackingStateBlob = {}
    expect(await trackFetchFailure(store, undefined, 'azure')).toBe(false)
    expect(store.azure?.failCount).toBe(1)
  })

  it('returns false on second failure (count=2, threshold=3)', async () => {
    const store: TrackingStateBlob = { azure: { failCount: 1 } }
    expect(await trackFetchFailure(store, undefined, 'azure')).toBe(false)
  })

  it('returns true on third failure (count=3, threshold=3)', async () => {
    const store: TrackingStateBlob = { azure: { failCount: 2 } }
    expect(await trackFetchFailure(store, undefined, 'azure')).toBe(true)
  })

  it('writes the daily accumulator via KV when threshold is reached (still a real key — #1224 kept this one out of the blob)', async () => {
    const dailyStore: Record<string, string> = {}
    const kv = mockKV(dailyStore)
    const store: TrackingStateBlob = { azure: { failCount: 2 } }
    expect(await trackFetchFailure(store, kv, 'azure')).toBe(true)
    const today = new Date().toISOString().split('T')[0]
    expect(dailyStore[`fetch-fail:daily:azure:${today}`]).toBe('1')
  })

  it('accumulates the daily counter across multiple threshold hits', async () => {
    const today = new Date().toISOString().split('T')[0]
    const dailyStore: Record<string, string> = { [`fetch-fail:daily:azure:${today}`]: '3' }
    const kv = mockKV(dailyStore)
    const store: TrackingStateBlob = { azure: { failCount: 2 } }
    await trackFetchFailure(store, kv, 'azure')
    expect(dailyStore[`fetch-fail:daily:azure:${today}`]).toBe('4')
  })

  it('does not write the daily accumulator when threshold is not yet reached', async () => {
    const dailyStore: Record<string, string> = {}
    const kv = mockKV(dailyStore)
    const store: TrackingStateBlob = { azure: { failCount: 1 } }
    expect(await trackFetchFailure(store, kv, 'azure')).toBe(false) // count=2, below threshold
    const today = new Date().toISOString().split('T')[0]
    expect(dailyStore[`fetch-fail:daily:azure:${today}`]).toBeUndefined()
  })

  it('returns true when already above threshold, but does NOT write the daily key again (not a rising edge)', async () => {
    // count=5 → next=6 ≥ threshold, so shouldDegrade=true, but 6 ≠ threshold(3) → no daily write.
    // This prevents double-counting cycles where the failure is sustained above threshold.
    const kv = mockKV()
    const store: TrackingStateBlob = { azure: { failCount: 5 } }
    expect(await trackFetchFailure(store, kv, 'azure')).toBe(true)
    expect(kv.put).not.toHaveBeenCalled()
  })

  it('treats a missing failCount as 0', async () => {
    const store: TrackingStateBlob = { azure: {} }
    expect(await trackFetchFailure(store, undefined, 'azure')).toBe(false)
    expect(store.azure?.failCount).toBe(1)
  })

  it('works with no KV at all — the daily accumulator write is simply skipped', async () => {
    const store: TrackingStateBlob = { azure: { failCount: 2 } }
    expect(await trackFetchFailure(store, undefined, 'azure')).toBe(true)
  })

  it('supports custom threshold', async () => {
    const store: TrackingStateBlob = { azure: { failCount: 3 } }
    expect(await trackFetchFailure(store, undefined, 'azure', 5)).toBe(false) // 3+1=4 < 5
    const store2: TrackingStateBlob = { azure: { failCount: 4 } }
    expect(await trackFetchFailure(store2, undefined, 'azure', 5)).toBe(true) // 4+1=5 >= 5
  })

  it('sets failSince on the rising edge when absent (#500)', async () => {
    const store: TrackingStateBlob = { azure: { failCount: 2 } }
    await trackFetchFailure(store, undefined, 'azure') // next=3 = threshold → rising edge
    expect(store.azure?.failSince).toBeDefined()
    expect(Number.isNaN(Date.parse(store.azure!.failSince!))).toBe(false) // valid ISO
  })

  it('does NOT overwrite an existing failSince (preserves first-failure time across re-climbs)', async () => {
    const original = '2026-06-01T00:00:00.000Z'
    const store: TrackingStateBlob = { azure: { failCount: 2, failSince: original } }
    await trackFetchFailure(store, undefined, 'azure') // rising edge again, but since already set
    expect(store.azure?.failSince).toBe(original)
  })

  it('does not set failSince below the rising edge', async () => {
    const store: TrackingStateBlob = { azure: { failCount: 0 } }
    await trackFetchFailure(store, undefined, 'azure') // next=1, below threshold
    expect(store.azure?.failSince).toBeUndefined()
  })

  describe('30-min decay (#1224 — mirrors the pre-consolidation fetch-fail:{id} KV key\'s expirationTtl)', () => {
    it('does NOT decay a count refreshed less than 30 min ago', async () => {
      const t0 = Date.parse('2026-08-01T00:00:00.000Z')
      const store: TrackingStateBlob = { azure: { failCount: 1, failCountAt: new Date(t0).toISOString() } }
      const next = t0 + 29 * 60_000 // 29 min later — still within the window
      expect(await trackFetchFailure(store, undefined, 'azure', 3, next)).toBe(false) // 1+1=2, not decayed
      expect(store.azure?.failCount).toBe(2)
    })

    it('decays a count last refreshed 30+ min ago back to 0 before incrementing', async () => {
      const t0 = Date.parse('2026-08-01T00:00:00.000Z')
      const store: TrackingStateBlob = { azure: { failCount: 3, failCountAt: new Date(t0).toISOString() } }
      const next = t0 + 31 * 60_000 // 31 min later — decay window elapsed
      expect(await trackFetchFailure(store, undefined, 'azure', 3, next)).toBe(false) // restarts at 0+1=1
      expect(store.azure?.failCount).toBe(1)
    })

    it('a decayed-then-restarted streak reaches the threshold again after 3 more failures, recreating the ~45-min re-climb cadence', async () => {
      const t0 = Date.parse('2026-08-01T00:00:00.000Z')
      const store: TrackingStateBlob = { azure: { failCount: 3, failCountAt: new Date(t0).toISOString() } }
      let t = t0 + 31 * 60_000
      expect(await trackFetchFailure(store, undefined, 'azure', 3, t)).toBe(false) // restarts at 1
      t += 60_000
      expect(await trackFetchFailure(store, undefined, 'azure', 3, t)).toBe(false) // 2
      t += 60_000
      expect(await trackFetchFailure(store, undefined, 'azure', 3, t)).toBe(true) // 3 — crosses again
    })

    it('treats an unparseable failCountAt as decayed (fails open rather than sticking forever)', async () => {
      const store: TrackingStateBlob = { azure: { failCount: 5, failCountAt: 'not-a-date' } }
      expect(await trackFetchFailure(store, undefined, 'azure')).toBe(false) // restarts at 0+1=1
      expect(store.azure?.failCount).toBe(1)
    })

    it('does not decay an entry with no failCountAt at all (trusts the stored count as-is)', async () => {
      // failCount/failCountAt are always written together by trackFetchFailure and always cleared
      // together by resetFetchFailure, and sanitizeTrackingState now rejects a failCount read from KV
      // whose paired failCountAt didn't survive — so a bare `{failCount: N}` with no timestamp can
      // only arise from a directly-constructed in-memory object (as in this test), never a real KV
      // round trip. Trusting the count here is what keeps that constructor-shorthand usable elsewhere
      // in this file without every fixture needing a timestamp.
      const store: TrackingStateBlob = { azure: { failCount: 2 } }
      expect(await trackFetchFailure(store, undefined, 'azure')).toBe(true) // 2+1=3, uses the stored count as-is
    })
  })

  describe('#1232 — the decayed count no longer withdraws the degraded verdict', () => {
    // The decay tests above seed a count at or past the threshold with no `failSince` — a shape a
    // crossing cannot leave behind, since every crossing sets it. Seeded as it really looks mid-outage,
    // the same decayed count must NOT read as a first failure.
    const midOutage = (t0: number): TrackingStateBlob => ({
      azure: {
        failCount: 3,
        failCountAt: new Date(t0).toISOString(),
        failSince: new Date(t0 - 3_600_000).toISOString(),
      },
    })

    it('stays degraded across the decay boundary while failSince is still set', async () => {
      const t0 = Date.parse('2026-08-01T00:00:00.000Z')
      const store = midOutage(t0)
      expect(await trackFetchFailure(store, undefined, 'azure', 3, t0 + 31 * 60_000)).toBe(true)
    })

    it('still decays the COUNT itself, so fetch-fail:daily keeps counting episodes', async () => {
      const t0 = Date.parse('2026-08-01T00:00:00.000Z')
      const store = midOutage(t0)
      const kv = mockKV()
      await trackFetchFailure(store, kv, 'azure', 3, t0 + 31 * 60_000)
      expect(store.azure?.failCount).toBe(1) // restarted — the episode accounting is untouched
      expect(kv.put).not.toHaveBeenCalled() // next=1 is not a rising edge
    })

    it('does not degrade a service that has never crossed (failSince absent → three-strike ramp intact)', async () => {
      const store: TrackingStateBlob = {}
      expect(await trackFetchFailure(store, undefined, 'azure')).toBe(false)
    })

    it('goes back to ramping after resetFetchFailure clears failSince', async () => {
      const t0 = Date.parse('2026-08-01T00:00:00.000Z')
      const store = midOutage(t0)
      resetFetchFailure(store, 'azure')
      expect(await trackFetchFailure(store, undefined, 'azure', 3, t0 + 31 * 60_000)).toBe(false)
    })

    // The liveness gate. `failSince` has no expiry of its own, and the paths that stop calling
    // trackFetchFailure/resetFetchFailure entirely (#689 dead-source, the flashduty early return)
    // freeze it — so presence alone would disarm the three-strike ramp for the rest of that source's
    // life. `isFailSinceLive` is the rule the #500 alert already applies to this same field.
    it('ramps again when failCountAt has gone stale — a frozen failSince is not an ongoing block', async () => {
      const t0 = Date.parse('2026-08-01T00:00:00.000Z')
      const store = midOutage(t0)
      // 61 min: past TRACKING_ALERT_STALE_MS (60 min), i.e. no write for longer than one full
      // decay-and-reclimb cycle, which is what a source that stopped being polled at all looks like.
      expect(await trackFetchFailure(store, undefined, 'azure', 3, t0 + 61 * 60_000)).toBe(false)
    })

    it('stays degraded at the last minute inside the liveness window (59 min)', async () => {
      const t0 = Date.parse('2026-08-01T00:00:00.000Z')
      const store = midOutage(t0)
      expect(await trackFetchFailure(store, undefined, 'azure', 3, t0 + 59 * 60_000)).toBe(true)
    })

    it('re-crossing still books exactly one fetch-fail:daily episode, and keeps the original failSince', async () => {
      const t0 = Date.parse('2026-08-01T00:00:00.000Z')
      const store = midOutage(t0)
      const originalSince = store.azure!.failSince
      const kv = mockKV()
      let t = t0 + 31 * 60_000
      // The verdict must hold through the whole decay-and-reclimb cycle, not just at its edges — this
      // is the loop the issue is named for, driven by the function rather than hand-seeded.
      expect(await trackFetchFailure(store, kv, 'azure', 3, t)).toBe(true)                // decayed → 1
      expect(await trackFetchFailure(store, kv, 'azure', 3, t += 60_000)).toBe(true)      // 2
      expect(await trackFetchFailure(store, kv, 'azure', 3, t += 60_000)).toBe(true)      // 3 — crosses
      expect(kv.put).toHaveBeenCalledTimes(1)
      expect(store.azure?.failSince).toBe(originalSince)
    })
  })

})

describe('resetFetchFailure (#1224 — blob-based, synchronous)', () => {
  it('clears the fail counter and failSince, pruning the now-empty entry', () => {
    const store: TrackingStateBlob = { azure: { failCount: 3 } }
    resetFetchFailure(store, 'azure')
    expect(store.azure).toBeUndefined()
  })

  it('does nothing when the service has no entry', () => {
    const store: TrackingStateBlob = {}
    resetFetchFailure(store, 'azure') // no throw
    expect(store.azure).toBeUndefined()
  })

  it('also clears failSince on recovery (#500)', () => {
    const store: TrackingStateBlob = { azure: { failCount: 3, failSince: '2026-06-01T00:00:00.000Z' } }
    resetFetchFailure(store, 'azure')
    expect(store.azure).toBeUndefined()
  })

  it('preserves a sibling componentMissCount instead of deleting the whole entry', () => {
    const store: TrackingStateBlob = { azure: { failCount: 3, componentMissCount: 2 } }
    resetFetchFailure(store, 'azure')
    expect(store.azure).toEqual({ componentMissCount: 2 })
  })

  it('also clears failCountAt — a recovery must not leave a decay timestamp with no count behind', () => {
    const store: TrackingStateBlob = { azure: { failCount: 3, failCountAt: '2026-06-01T00:00:00.000Z', componentMissCount: 1 } }
    resetFetchFailure(store, 'azure')
    expect(store.azure).toEqual({ componentMissCount: 1 })
  })
})

describe('shouldAlertPersistentFailure (#500)', () => {
  const now = Date.parse('2026-06-02T12:00:00.000Z')

  it('false when no since timestamp', () => {
    expect(shouldAlertPersistentFailure(null, now)).toBe(false)
    expect(shouldAlertPersistentFailure(undefined, now)).toBe(false)
  })

  it('false when unreachable < 1h', () => {
    const since = new Date(now - 59 * 60_000).toISOString() // 59 min ago
    expect(shouldAlertPersistentFailure(since, now)).toBe(false)
  })

  it('true at exactly the 1h threshold', () => {
    const since = new Date(now - PERSISTENT_FAILURE_THRESHOLD_MS).toISOString()
    expect(shouldAlertPersistentFailure(since, now)).toBe(true)
  })

  it('true when unreachable well over 1h', () => {
    const since = new Date(now - 5 * 3_600_000).toISOString()
    expect(shouldAlertPersistentFailure(since, now)).toBe(true)
  })

  it('false on an unparseable timestamp (no false alert)', () => {
    expect(shouldAlertPersistentFailure('not-a-date', now)).toBe(false)
  })

  it('respects a custom threshold', () => {
    const since = new Date(now - 90 * 60_000).toISOString() // 90 min ago
    expect(shouldAlertPersistentFailure(since, now, 2 * 3_600_000)).toBe(false) // < 2h
  })
})

describe('formatPersistentFailureAlert (#500)', () => {
  it('reports the elapsed whole hours and names the service', () => {
    const now = Date.parse('2026-06-02T12:00:00.000Z')
    const since = new Date(now - 3 * 3_600_000 - 20 * 60_000).toISOString() // 3h 20m ago
    const out = formatPersistentFailureAlert('DeepSeek API', since, now)
    expect(out).toContain('DeepSeek API')
    expect(out).toContain('3h+') // floor of 3h20m
    expect(out).toContain('structural block')
  })
})

describe('trackComponentMiss (#1224 — blob-based, synchronous)', () => {
  it('returns false on first miss (count=1, threshold=3)', () => {
    const store: TrackingStateBlob = {}
    expect(trackComponentMiss(store, 'openai')).toBe(false)
    expect(store.openai?.componentMissCount).toBe(1)
  })

  it('returns false on second miss (count=2, threshold=3)', () => {
    const store: TrackingStateBlob = { openai: { componentMissCount: 1 } }
    expect(trackComponentMiss(store, 'openai')).toBe(false)
  })

  it('returns true on third miss (count=3, threshold=3)', () => {
    const store: TrackingStateBlob = { openai: { componentMissCount: 2 } }
    expect(trackComponentMiss(store, 'openai')).toBe(true)
  })

  it('returns true when already above threshold and does not increment further', () => {
    const store: TrackingStateBlob = { openai: { componentMissCount: 5 } }
    expect(trackComponentMiss(store, 'openai')).toBe(true)
    expect(store.openai?.componentMissCount).toBe(5)
  })

  it('treats a missing componentMissCount as 0', () => {
    const store: TrackingStateBlob = { openai: {} }
    expect(trackComponentMiss(store, 'openai')).toBe(false)
    expect(store.openai?.componentMissCount).toBe(1)
  })

  it('supports custom threshold', () => {
    const store: TrackingStateBlob = { openai: { componentMissCount: 3 } }
    expect(trackComponentMiss(store, 'openai', 5)).toBe(false) // 3+1=4 < 5
    const store2: TrackingStateBlob = { openai: { componentMissCount: 4 } }
    expect(trackComponentMiss(store2, 'openai', 5)).toBe(true) // 4+1=5 >= 5
  })
})

describe('resetComponentMiss (#1224 — blob-based, synchronous)', () => {
  it('clears the miss counter, pruning the now-empty entry', () => {
    const store: TrackingStateBlob = { openai: { componentMissCount: 3 } }
    resetComponentMiss(store, 'openai')
    expect(store.openai).toBeUndefined()
  })

  it('does nothing when the service has no entry', () => {
    const store: TrackingStateBlob = {}
    resetComponentMiss(store, 'openai') // no throw
  })

  it('preserves a sibling failCount instead of deleting the whole entry', () => {
    const store: TrackingStateBlob = { openai: { componentMissCount: 3, failCount: 1 } }
    resetComponentMiss(store, 'openai')
    expect(store.openai).toEqual({ failCount: 1 })
  })
})

describe('readTrackingState / writeTrackingStateIfChanged (#1224 — the consolidated blob\'s only 2 real KV ops)', () => {
  it('returns {} when kv is undefined', async () => {
    expect(await readTrackingState(undefined)).toEqual({})
  })

  it('returns {} when the key is absent', async () => {
    const kv = mockKV()
    expect(await readTrackingState(kv)).toEqual({})
  })

  it('parses a stored blob', async () => {
    const stored: TrackingStateBlob = { azure: { failCount: 2, failCountAt: '2026-08-01T00:00:00.000Z' } }
    const kv = mockKV({ 'tracking:state': JSON.stringify(stored) })
    expect(await readTrackingState(kv)).toEqual(stored)
  })

  it('fails open to {} on corrupt JSON', async () => {
    const kv = mockKV({ 'tracking:state': 'not json{' })
    expect(await readTrackingState(kv)).toEqual({})
  })

  it('fails open to {} on a wrong-shape value (e.g. an array)', async () => {
    const kv = mockKV({ 'tracking:state': '[1,2,3]' })
    expect(await readTrackingState(kv)).toEqual({})
  })

  it('fails open to {} when kv.get throws', async () => {
    const kv = mockKV()
    ;(kv.get as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('KV unavailable'))
    expect(await readTrackingState(kv)).toEqual({})
  })

  describe('per-entry field sanitization (#1224 — a wrong TYPE must not silently corrupt arithmetic)', () => {
    const AT = '2026-08-01T00:00:00.000Z'

    it('drops a non-numeric failCount instead of letting it string-concatenate ("3"+1="31")', async () => {
      const kv = mockKV({ 'tracking:state': JSON.stringify({ azure: { failCount: '3', failCountAt: AT } }) })
      expect(await readTrackingState(kv)).toEqual({})
    })

    it('drops a non-numeric componentMissCount the same way', async () => {
      const kv = mockKV({ 'tracking:state': JSON.stringify({ openai: { componentMissCount: 'five', componentMissAt: AT } }) })
      expect(await readTrackingState(kv)).toEqual({})
    })

    it('drops failCount when its paired failCountAt is missing — the pair is written/cleared together, so a mismatch is itself evidence of corruption', async () => {
      const kv = mockKV({ 'tracking:state': JSON.stringify({ azure: { failCount: 3 } }) })
      expect(await readTrackingState(kv)).toEqual({})
    })

    it('drops failCount when its paired failCountAt has the wrong type', async () => {
      const kv = mockKV({ 'tracking:state': JSON.stringify({ azure: { failCount: 3, failCountAt: 12345 } }) })
      expect(await readTrackingState(kv)).toEqual({})
    })

    it('drops componentMissCount when its paired componentMissAt is missing', async () => {
      const kv = mockKV({ 'tracking:state': JSON.stringify({ openai: { componentMissCount: 3 } }) })
      expect(await readTrackingState(kv)).toEqual({})
    })

    it('keeps a valid (count, *At) pair alongside a rejected sibling field on the SAME entry', async () => {
      const kv = mockKV({ 'tracking:state': JSON.stringify({ azure: { failCount: 2, failCountAt: AT, componentMissCount: 'bad' } }) })
      expect(await readTrackingState(kv)).toEqual({ azure: { failCount: 2, failCountAt: AT } })
    })

    it('drops a non-string failSince', async () => {
      const kv = mockKV({ 'tracking:state': JSON.stringify({ azure: { failCount: 1, failCountAt: AT, failSince: 12345 } }) })
      expect(await readTrackingState(kv)).toEqual({ azure: { failCount: 1, failCountAt: AT } })
    })

    it('drops a non-object entry (e.g. a service id mapped straight to a number)', async () => {
      const kv = mockKV({ 'tracking:state': JSON.stringify({ azure: 3, openai: { failCount: 1, failCountAt: AT } }) })
      expect(await readTrackingState(kv)).toEqual({ openai: { failCount: 1, failCountAt: AT } })
    })

    it('keeps other services intact when one entry is entirely malformed', async () => {
      const kv = mockKV({ 'tracking:state': JSON.stringify({ azure: { failCount: 'bad' }, openai: { componentMissCount: 3, componentMissAt: AT } }) })
      expect(await readTrackingState(kv)).toEqual({ openai: { componentMissCount: 3, componentMissAt: AT } })
    })
  })

  it('skips the write when nothing changed', async () => {
    const kv = mockKV()
    const before: TrackingStateBlob = { azure: { failCount: 1 } }
    const after: TrackingStateBlob = { azure: { failCount: 1 } }
    await writeTrackingStateIfChanged(kv, before, after)
    expect(kv.put).not.toHaveBeenCalled()
  })

  it('writes when the blob changed', async () => {
    const store: Record<string, string> = {}
    const kv = mockKV(store)
    const before: TrackingStateBlob = { azure: { failCount: 1 } }
    const after: TrackingStateBlob = { azure: { failCount: 2 } }
    await writeTrackingStateIfChanged(kv, before, after)
    expect(store['tracking:state']).toBe(JSON.stringify(after))
  })

  it('does nothing when kv is undefined', async () => {
    await writeTrackingStateIfChanged(undefined, {}, { azure: { failCount: 1 } }) // no throw
  })
})

describe('worstUnresolvedImpact (#733)', () => {
  const inc = (impact: Incident['impact'], status: Incident['status'] = 'investigating'): Incident =>
    ({ id: 'x', title: 't', status, impact, startedAt: '2026-06-17T00:00:00Z', resolvedAt: null, duration: null, timeline: [] }) as Incident

  it('returns null for no incidents / empty / undefined', () => {
    expect(worstUnresolvedImpact(undefined)).toBeNull()
    expect(worstUnresolvedImpact([])).toBeNull()
  })

  it('ignores resolved incidents', () => {
    expect(worstUnresolvedImpact([inc('major', 'resolved')])).toBeNull()
  })

  it('ignores null-impact incidents', () => {
    expect(worstUnresolvedImpact([inc(null)])).toBeNull()
  })

  it('returns the worst (critical > major > minor) among unresolved', () => {
    expect(worstUnresolvedImpact([inc('minor'), inc('major')])).toBe('major')
    expect(worstUnresolvedImpact([inc('minor'), inc('major'), inc('critical')])).toBe('critical')
    expect(worstUnresolvedImpact([inc('minor')])).toBe('minor')
  })
})

describe('countsAsUptimeOk (#733)', () => {
  // #1233 — LOAD-BEARING, and it reads like an oversight, so it is pinned with its reason.
  //
  // An unreadable source books an `ok` uptime sample. That is not because it is right — the poll
  // observed nothing, so neither answer is — but because the alternative was implemented during this
  // change's review and had to be reverted: recording no sample makes `total === 0` reachable, and
  // `computeMonthlyUptime` publishes a zero-sample service as **0%** into the permanent monthly
  // archive. Trading an invented 100% for an invented 0% moves the fabrication from silence to a
  // public accusation about a provider whose page we never read.
  //
  // `countsAsUptimeOk` contains no `'unknown'` literal — it reaches `true` by falling through the
  // `degraded` path, and its signature is `status: string`, so it gets no exhaustiveness pressure from
  // `status-verdict.ts`. Without this case, re-introducing the revert is green across the whole suite.
  it('an unreadable source counts as an UP sample — deliberate; see the note at cacheWrite', () => {
    expect(countsAsUptimeOk('unknown', [])).toBe(true)
    expect(countsAsUptimeOk('unknown', undefined)).toBe(true)
  })

  const inc = (impact: Incident['impact']): Incident =>
    ({ id: 'x', title: 't', status: 'investigating', impact, startedAt: '2026-06-17T00:00:00Z', resolvedAt: null, duration: null, timeline: [] }) as Incident

  it('operational always counts as up', () => {
    expect(countsAsUptimeOk('operational', undefined)).toBe(true)
    expect(countsAsUptimeOk('operational', [inc('major')])).toBe(true) // status wins
  })

  it('down always counts as down', () => {
    expect(countsAsUptimeOk('down', undefined)).toBe(false)
    expect(countsAsUptimeOk('down', [inc('minor')])).toBe(false)
  })

  it('degraded with a minor incident counts as UP (the OpenAI FedRAMP / Deepgram case)', () => {
    expect(countsAsUptimeOk('degraded', [inc('minor')])).toBe(true)
  })

  it('degraded with NO incident counts as up (transient fetch hiccup is not a real outage)', () => {
    expect(countsAsUptimeOk('degraded', [])).toBe(true)
    expect(countsAsUptimeOk('degraded', undefined)).toBe(true)
  })

  it('degraded with a major/critical incident counts as DOWN', () => {
    expect(countsAsUptimeOk('degraded', [inc('major')])).toBe(false)
    expect(countsAsUptimeOk('degraded', [inc('critical')])).toBe(false)
    expect(countsAsUptimeOk('degraded', [inc('minor'), inc('major')])).toBe(false) // worst wins
  })
})

describe('isNonReliabilityAdvisory (#707/#811/#1021)', () => {
  it('TRUE for non-reliability advisories (compliance / access revoke|suspend / deprecation)', () => {
    expect(isNonReliabilityAdvisory("We've suspended access to Claude Mythos 5 and Claude Fable 5")).toBe(true) // #811 live case
    expect(isNonReliabilityAdvisory('export control directive — Anthropic asked us to revoke access')).toBe(true) // #707 AWS case
    expect(isNonReliabilityAdvisory('Model deprecation: gpt-4-0314 retired')).toBe(true)
    expect(isNonReliabilityAdvisory('Scheduled maintenance window')).toBe(true)
  })
  it('TRUE for usage-limits / quota / billing advisories (#1021)', () => {
    expect(isNonReliabilityAdvisory('Codex Usage Limits Depleting Faster Than Expected')).toBe(true) // the #1021 live case
    expect(isNonReliabilityAdvisory('Increased quota for all Pro tiers')).toBe(true)
    expect(isNonReliabilityAdvisory('Billing system reconciliation delay')).toBe(true)
    expect(isNonReliabilityAdvisory('Invoice generation running late this cycle')).toBe(true)
  })
  it('FALSE when an OUTAGE signal is present — never down-classify a real fault', () => {
    expect(isNonReliabilityAdvisory('Access suspended due to elevated error rates')).toBe(false) // outage wins over suspend
    expect(isNonReliabilityAdvisory('Partial outage — API timeouts')).toBe(false)
    expect(isNonReliabilityAdvisory('Elevated 5xx errors — customers hitting quota limits')).toBe(false) // #1021 outage wins over quota
    expect(isNonReliabilityAdvisory('Billing API returning 5xx failures')).toBe(false) // #1021 outage wins over billing
    expect(isNonReliabilityAdvisory('Quota errors returned to customers')).toBe(false) // #1021 `errors?` guard — quota fault, not advisory
    expect(isNonReliabilityAdvisory('Billing errors on checkout')).toBe(false)          // #1021 `errors?` guard — billing fault
  })
  it('FALSE for empty/ordinary text', () => {
    expect(isNonReliabilityAdvisory('')).toBe(false)
    expect(isNonReliabilityAdvisory('Elevated 5xx on the Messages API')).toBe(false)
  })
})

describe('diffPageComponents (#992 — new-component change detection)', () => {
  const c = (id: string, name = id) => ({ id, name })

  it('bootstraps silently on first sight (seen=null): records ids, flags NOTHING new', () => {
    const r = diffPageComponents([c('a'), c('b')], null)
    expect(r.bootstrap).toBe(true)
    expect(r.newComponents).toEqual([])
    expect(r.nextSeen.sort()).toEqual(['a', 'b'])
  })

  it('flags a component whose id was never seen', () => {
    const r = diffPageComponents([c('a'), c('gemma', 'Gemma4-31B-Multimodal')], ['a'])
    expect(r.bootstrap).toBe(false)
    expect(r.newComponents).toEqual([{ id: 'gemma', name: 'Gemma4-31B-Multimodal' }])
    expect(r.nextSeen.sort()).toEqual(['a', 'gemma'])
  })

  it('flags nothing when every current id is already seen (no re-alert, snapshot unchanged)', () => {
    const r = diffPageComponents([c('a'), c('b')], ['a', 'b'])
    expect(r.newComponents).toEqual([])
    expect(r.nextSeen.sort()).toEqual(['a', 'b'])
  })

  it('seen UNIONS current ids (never shrinks) — a removed-then-readded component does not re-alert', () => {
    // 'b' was seen before but is absent now; it must remain in nextSeen so its later return is silent.
    const r = diffPageComponents([c('a')], ['a', 'b'])
    expect(r.newComponents).toEqual([])
    expect(r.nextSeen.sort()).toEqual(['a', 'b'])
    // ...and when 'b' comes back, still no alert:
    const r2 = diffPageComponents([c('a'), c('b')], r.nextSeen)
    expect(r2.newComponents).toEqual([])
  })

  it('reports multiple new components at once', () => {
    const r = diffPageComponents([c('a'), c('x'), c('y')], ['a'])
    expect(r.newComponents.map((n) => n.id).sort()).toEqual(['x', 'y'])
  })

  it('empty current + prior seen → nothing new, seen preserved', () => {
    const r = diffPageComponents([], ['a', 'b'])
    expect(r.newComponents).toEqual([])
    expect(r.nextSeen.sort()).toEqual(['a', 'b'])
  })
})

describe('formatNewComponentAlert (#992)', () => {
  it('curated page → actionable "add the id" guidance', () => {
    const body = formatNewComponentAlert(['OpenAI API', 'Codex'], [{ id: 'z1', name: 'New Model' }], false)
    expect(body).toContain('OpenAI API, Codex')
    expect(body).toContain('`New Model`')
    expect(body).toContain('`z1`')
    expect(body).toContain('statusComponentIds')
    expect(body).not.toContain('already auto-tracked')
  })

  it('dynamic page → heads-up only, no action', () => {
    const body = formatNewComponentAlert(['Cerebras Inference'], [{ id: 'g', name: 'Gemma4-31B-Multimodal' }], true)
    expect(body).toContain('already auto-tracked')
    expect(body).toContain('1 new component')
  })

  it('pluralizes correctly', () => {
    const one = formatNewComponentAlert(['X'], [{ id: 'a', name: 'A' }], false)
    const two = formatNewComponentAlert(['X'], [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }], false)
    expect(one).toContain('1 new component:')
    expect(two).toContain('2 new components:')
  })
})

describe('parseSnapshotWindow (#1256)', () => {
  it('returns [] for an absent key, so the window bootstraps', () => {
    expect(parseSnapshotWindow(null)).toEqual([])
  })

  it('returns the stored snapshots when the value is well-formed', () => {
    const snapshots = [{ t: '2026-08-19T00:00:00Z', data: {} }]
    expect(parseSnapshotWindow(JSON.stringify({ snapshots }))).toEqual(snapshots)
  })

  it('returns [] for a stored-but-empty window, which is usable', () => {
    expect(parseSnapshotWindow('{"snapshots":[]}')).toEqual([])
  })

  it('returns null for unparseable JSON', () => {
    expect(parseSnapshotWindow('{"snapshots":[{"t":"2026-08')).toBeNull()
    expect(parseSnapshotWindow('not json at all')).toBeNull()
    // An empty stored value is present-and-unusable, not absent.
    expect(parseSnapshotWindow('')).toBeNull()
  })

  it('returns null when an element is not a snapshot', () => {
    expect(parseSnapshotWindow('{"snapshots":["garbage"]}')).toBeNull()
    expect(parseSnapshotWindow('{"snapshots":[1,2,3]}')).toBeNull()
    expect(parseSnapshotWindow('{"snapshots":[null]}')).toBeNull()
    expect(parseSnapshotWindow('{"snapshots":[{"t":"ok"},{"data":{}}]}')).toBeNull()
    // `t` alone is not enough — every reader dereferences `.data`.
    expect(parseSnapshotWindow('{"snapshots":[{"t":"2026-08-19T00:00:00Z"}]}')).toBeNull()
    expect(parseSnapshotWindow('{"snapshots":[{"t":"a","data":"garbage"}]}')).toBeNull()
  })

  it('returns null when the value parses but carries no snapshots array', () => {
    expect(parseSnapshotWindow('{}')).toBeNull()
    expect(parseSnapshotWindow('{"snapshots":null}')).toBeNull()
    expect(parseSnapshotWindow('{"snapshots":{"t":"x"}}')).toBeNull()
    expect(parseSnapshotWindow('null')).toBeNull()
  })
})
