import { describe, it, expect, vi } from 'vitest'
import {
  recordDiscordSend,
  discordSendKey,
  clipTitle,
  DISCORD_SEND_PREFIX,
  DISCORD_SEND_TTL_S,
} from '../discord-send-log'

const makeKV = () => {
  const puts: Array<{ key: string; value: string; opts?: { expirationTtl?: number; metadata?: unknown } }> = []
  return {
    puts,
    get: vi.fn(async () => null),
    put: vi.fn(async (key: string, value: string, opts?: { expirationTtl?: number; metadata?: unknown }) => { puts.push({ key, value, opts }) }),
    delete: vi.fn(async () => {}),
  }
}

describe('recordDiscordSend', () => {
  const T = Date.UTC(2026, 9, 14, 13, 25, 38, 123)

  it('writes one key per send, listable by day, carrying the title and outcome as metadata', async () => {
    const kv = makeKV()
    await recordDiscordSend(kv, { title: '⚠️ Mistral — status source unreadable 1h+', ok: true }, T, 'ab12')
    expect(kv.puts).toHaveLength(1)
    expect(kv.puts[0].key).toBe(`${DISCORD_SEND_PREFIX}2026-10-14T13:25:38.123Z:ab12`)
    expect(kv.puts[0].opts).toEqual({
      expirationTtl: DISCORD_SEND_TTL_S,
      metadata: { title: '⚠️ Mistral — status source unreadable 1h+', ok: true },
    })
  })

  it('records a FAILED send as ok:false — the case the dedup markers hide', async () => {
    const kv = makeKV()
    await recordDiscordSend(kv, { title: 'x', ok: false }, T, 'ab12')
    expect((kv.puts[0].opts?.metadata as { ok: boolean }).ok).toBe(false)
  })

  it('two sends in the same millisecond do not overwrite each other', () => {
    expect(discordSendKey(T, 'aaaa')).not.toBe(discordSendKey(T, 'bbbb'))
  })

  it('keeps the 30-day retention', () => {
    expect(DISCORD_SEND_TTL_S).toBe(2_592_000)
  })

  it('is a no-op without a KV, and never throws when the write fails', async () => {
    await expect(recordDiscordSend(undefined, { title: 'x', ok: true })).resolves.toBeUndefined()
    const broken = { ...makeKV(), put: vi.fn(async () => { throw new Error('kv down') }) }
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await expect(recordDiscordSend(broken, { title: 'x', ok: true })).resolves.toBeUndefined()
    warn.mockRestore()
  })

  it('clips a long title to 140 characters', () => {
    const clipped = clipTitle('x'.repeat(500))
    expect(clipped).toHaveLength(140)
    expect(clipped.endsWith('…')).toBe(true)
  })
})
