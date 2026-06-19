import { describe, it, expect, vi } from 'vitest'
import { checkPersistentFetchFailures } from '../persistent-failure'

type DiscordSend = (
  webhookUrl: string,
  embed: { title: string; description: string; color: number },
) => Promise<boolean>

const NOW = Date.parse('2026-06-02T12:00:00.000Z')
const twoHoursAgo = new Date(NOW - 2 * 3_600_000).toISOString()
const tenMinAgo = new Date(NOW - 10 * 60_000).toISOString()
const DISCORD = 'https://discord.com/api/webhooks/1/abc'

function mockKV(store: Record<string, string> = {}) {
  return {
    store,
    list: vi.fn(async ({ prefix }: { prefix: string }) => ({
      keys: Object.keys(store).filter((k) => k.startsWith(prefix)).map((name) => ({ name })),
    })),
    get: vi.fn(async (k: string) => store[k] ?? null),
    put: vi.fn(async (k: string, v: string) => { store[k] = v }),
    delete: vi.fn(async (k: string) => { delete store[k] }), // unused by the sweep; satisfies KVSweep
  }
}

const svcs = [{ id: 'deepseek', name: 'DeepSeek API' }, { id: 'mistral', name: 'Mistral API' }]

describe('checkPersistentFetchFailures (#500)', () => {
  it('alerts the operator + writes the 24h dedup when a service has been unreachable >= 1h', async () => {
    const kv = mockKV({ 'fetch-fail:since:deepseek': twoHoursAgo })
    const send = vi.fn<DiscordSend>(async () => true)
    await checkPersistentFetchFailures(kv, DISCORD, svcs, NOW, send)
    expect(send).toHaveBeenCalledOnce()
    const [url, embed] = send.mock.calls[0]
    expect(url).toBe(DISCORD) // operator webhook
    expect(embed.title).toContain('DeepSeek API')
    expect(embed.description).toContain('2h+')
    expect(kv.store['alerted:fetch-persistent:deepseek']).toBe('1') // dedup written
  })

  it('does NOT alert when the failure is younger than 1h', async () => {
    const kv = mockKV({ 'fetch-fail:since:deepseek': tenMinAgo })
    const send = vi.fn<DiscordSend>(async () => true)
    await checkPersistentFetchFailures(kv, DISCORD, svcs, NOW, send)
    expect(send).not.toHaveBeenCalled()
    expect(kv.store['alerted:fetch-persistent:deepseek']).toBeUndefined()
  })

  it('skips a service already alerted this 24h (dedup)', async () => {
    const kv = mockKV({
      'fetch-fail:since:deepseek': twoHoursAgo,
      'alerted:fetch-persistent:deepseek': '1',
    })
    const send = vi.fn<DiscordSend>(async () => true)
    await checkPersistentFetchFailures(kv, DISCORD, svcs, NOW, send)
    expect(send).not.toHaveBeenCalled()
  })

  it('does NOT write the dedup marker when the send fails (so it retries next cron)', async () => {
    const kv = mockKV({ 'fetch-fail:since:deepseek': twoHoursAgo })
    const send = vi.fn<DiscordSend>(async () => false) // Discord POST failed
    await checkPersistentFetchFailures(kv, DISCORD, svcs, NOW, send)
    expect(send).toHaveBeenCalledOnce()
    expect(kv.store['alerted:fetch-persistent:deepseek']).toBeUndefined()
  })

  it('falls back to the svcId when the service is not in the name map', async () => {
    const kv = mockKV({ 'fetch-fail:since:ghost': twoHoursAgo })
    const send = vi.fn<DiscordSend>(async () => true)
    await checkPersistentFetchFailures(kv, DISCORD, svcs, NOW, send)
    expect(send.mock.calls[0][1].title).toContain('ghost')
  })

  it('no-ops when kv or discord url is absent', async () => {
    const send = vi.fn<DiscordSend>(async () => true)
    await checkPersistentFetchFailures(undefined, DISCORD, svcs, NOW, send)
    await checkPersistentFetchFailures(mockKV({ 'fetch-fail:since:deepseek': twoHoursAgo }), undefined, svcs, NOW, send)
    expect(send).not.toHaveBeenCalled()
  })

  it('handles multiple blocked services in one sweep', async () => {
    const kv = mockKV({
      'fetch-fail:since:deepseek': twoHoursAgo,
      'fetch-fail:since:mistral': twoHoursAgo,
    })
    const send = vi.fn<DiscordSend>(async () => true)
    await checkPersistentFetchFailures(kv, DISCORD, svcs, NOW, send)
    expect(send).toHaveBeenCalledTimes(2)
  })

  it('never throws — a KV list failure is swallowed (best-effort, cron-safe)', async () => {
    const kv = { list: vi.fn(async () => { throw new Error('KV down') }), get: vi.fn(), put: vi.fn(), delete: vi.fn() }
    const send = vi.fn<DiscordSend>(async () => true)
    await expect(checkPersistentFetchFailures(kv, DISCORD, svcs, NOW, send)).resolves.toBeUndefined()
    expect(send).not.toHaveBeenCalled()
  })
})
