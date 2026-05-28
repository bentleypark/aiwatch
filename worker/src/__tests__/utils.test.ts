import { describe, it, expect, vi } from 'vitest'
import { formatDuration, trackFetchFailure, resetFetchFailure, trackComponentMiss, resetComponentMiss, isAllowedAlertWebhook, type KVLike } from '../utils'

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

describe('trackFetchFailure', () => {
  it('returns false on first failure (count=1, threshold=3)', async () => {
    const kv = mockKV()
    expect(await trackFetchFailure(kv, 'azure')).toBe(false)
    expect(kv.put).toHaveBeenCalledWith('fetch-fail:azure', '1', { expirationTtl: 1800 })
  })

  it('returns false on second failure (count=2, threshold=3)', async () => {
    const kv = mockKV({ 'fetch-fail:azure': '1' })
    expect(await trackFetchFailure(kv, 'azure')).toBe(false)
  })

  it('returns true on third failure (count=3, threshold=3)', async () => {
    const kv = mockKV({ 'fetch-fail:azure': '2' })
    expect(await trackFetchFailure(kv, 'azure')).toBe(true)
  })

  it('returns true when already above threshold and skips write', async () => {
    const kv = mockKV({ 'fetch-fail:azure': '5' })
    expect(await trackFetchFailure(kv, 'azure')).toBe(true)
    expect(kv.put).not.toHaveBeenCalled() // already above, skip write
  })

  it('handles corrupted (non-numeric) KV value gracefully', async () => {
    const kv = mockKV({ 'fetch-fail:azure': 'NaN' })
    expect(await trackFetchFailure(kv, 'azure')).toBe(false) // treats as 0+1=1 < 3
  })

  it('returns false when kv is undefined', async () => {
    expect(await trackFetchFailure(undefined, 'azure')).toBe(false)
  })

  it('supports custom threshold', async () => {
    const kv = mockKV({ 'fetch-fail:azure': '3' })
    expect(await trackFetchFailure(kv, 'azure', 5)).toBe(false) // 3+1=4 < 5
    const kv2 = mockKV({ 'fetch-fail:azure': '4' })
    expect(await trackFetchFailure(kv2, 'azure', 5)).toBe(true) // 4+1=5 >= 5
  })
})

describe('resetFetchFailure', () => {
  it('deletes the fail counter key when it exists', async () => {
    const store: Record<string, string> = { 'fetch-fail:azure': '3' }
    const kv = mockKV(store)
    await resetFetchFailure(kv, 'azure')
    expect(store['fetch-fail:azure']).toBeUndefined()
    expect(kv.delete).toHaveBeenCalled()
  })

  it('skips delete when key does not exist (saves KV write)', async () => {
    const kv = mockKV()
    await resetFetchFailure(kv, 'azure')
    expect(kv.delete).not.toHaveBeenCalled()
  })

  it('does nothing when kv is undefined', async () => {
    await resetFetchFailure(undefined, 'azure') // no throw
  })
})

describe('trackComponentMiss', () => {
  it('returns false on first miss (count=1, threshold=3)', async () => {
    const kv = mockKV()
    expect(await trackComponentMiss(kv, 'openai')).toBe(false)
    expect(kv.put).toHaveBeenCalledWith('component-missing:openai', '1', { expirationTtl: 1800 })
  })

  it('returns false on second miss (count=2, threshold=3)', async () => {
    const kv = mockKV({ 'component-missing:openai': '1' })
    expect(await trackComponentMiss(kv, 'openai')).toBe(false)
  })

  it('returns true on third miss (count=3, threshold=3)', async () => {
    const kv = mockKV({ 'component-missing:openai': '2' })
    expect(await trackComponentMiss(kv, 'openai')).toBe(true)
  })

  it('returns true when already above threshold and skips write', async () => {
    const kv = mockKV({ 'component-missing:openai': '5' })
    expect(await trackComponentMiss(kv, 'openai')).toBe(true)
    expect(kv.put).not.toHaveBeenCalled()
  })

  it('handles corrupted (non-numeric) KV value gracefully', async () => {
    const kv = mockKV({ 'component-missing:openai': 'NaN' })
    expect(await trackComponentMiss(kv, 'openai')).toBe(false) // treats as 0+1=1 < 3
  })

  it('returns false when kv is undefined', async () => {
    expect(await trackComponentMiss(undefined, 'openai')).toBe(false)
  })

  it('supports custom threshold', async () => {
    const kv = mockKV({ 'component-missing:openai': '3' })
    expect(await trackComponentMiss(kv, 'openai', 5)).toBe(false) // 3+1=4 < 5
    const kv2 = mockKV({ 'component-missing:openai': '4' })
    expect(await trackComponentMiss(kv2, 'openai', 5)).toBe(true) // 4+1=5 >= 5
  })
})

describe('resetComponentMiss', () => {
  it('deletes the miss counter key when it exists', async () => {
    const store: Record<string, string> = { 'component-missing:openai': '3' }
    const kv = mockKV(store)
    await resetComponentMiss(kv, 'openai')
    expect(store['component-missing:openai']).toBeUndefined()
    expect(kv.delete).toHaveBeenCalled()
  })

  it('skips delete when key does not exist (saves KV write)', async () => {
    const kv = mockKV()
    await resetComponentMiss(kv, 'openai')
    expect(kv.delete).not.toHaveBeenCalled()
  })

  it('does nothing when kv is undefined', async () => {
    await resetComponentMiss(undefined, 'openai') // no throw
  })
})
