import { describe, it, expect, vi } from 'vitest'
import { buildIndexNowBody, indexNowUrlsFor, pingIndexNow, INDEXNOW_KEY } from '../indexnow'

describe('buildIndexNowBody', () => {
  it('builds the IndexNow payload with host, key, and keyLocation', () => {
    const body = buildIndexNowBody(['https://ai-watch.dev/is-claude-api-down'])
    expect(body).toEqual({
      host: 'ai-watch.dev',
      key: INDEXNOW_KEY,
      keyLocation: `https://ai-watch.dev/${INDEXNOW_KEY}.txt`,
      urlList: ['https://ai-watch.dev/is-claude-api-down'],
    })
  })
})

describe('indexNowUrlsFor', () => {
  it('maps service ids to canonical is-down URLs', () => {
    expect(indexNowUrlsFor(['claude'])).toEqual(['https://ai-watch.dev/is-claude-api-down'])
  })
  it('uses the feed-slug override (claudecode → is-claude-code-down)', () => {
    expect(indexNowUrlsFor(['claudecode'])).toEqual(['https://ai-watch.dev/is-claude-code-down'])
  })
  it('dedups repeated ids', () => {
    expect(indexNowUrlsFor(['claude', 'claude'])).toEqual(['https://ai-watch.dev/is-claude-api-down'])
  })
  it('excludes no-is-down-page services (bedrock → dashboard hash, dropped)', () => {
    expect(indexNowUrlsFor(['bedrock'])).toEqual([])
    expect(indexNowUrlsFor(['claude', 'bedrock'])).toEqual(['https://ai-watch.dev/is-claude-api-down'])
  })
})

describe('pingIndexNow', () => {
  it('POSTs the payload and returns true on an OK response', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 200 } as Response)
    const ok = await pingIndexNow(['claude'], fetchImpl)
    expect(ok).toBe(true)
    expect(fetchImpl).toHaveBeenCalledOnce()
    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toBe('https://api.indexnow.org/IndexNow')
    expect(init.method).toBe('POST')
    const sent = JSON.parse(init.body as string)
    expect(sent.urlList).toEqual(['https://ai-watch.dev/is-claude-api-down'])
    expect(sent.keyLocation).toBe(`https://ai-watch.dev/${INDEXNOW_KEY}.txt`)
  })

  it('no-ops (returns false, no fetch) when no id maps to an is-down page', async () => {
    const fetchImpl = vi.fn()
    const ok = await pingIndexNow(['bedrock', 'azureopenai'], fetchImpl)
    expect(ok).toBe(false)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('never throws — a fetch rejection resolves to false', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('network'))
    await expect(pingIndexNow(['claude'], fetchImpl)).resolves.toBe(false)
  })

  it('returns false on a non-OK response', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 429 } as Response)
    await expect(pingIndexNow(['claude'], fetchImpl)).resolves.toBe(false)
  })
})
