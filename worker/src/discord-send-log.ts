import type { KVLike } from './utils'
import { kvPut } from './utils'

export const DISCORD_SEND_PREFIX = 'discord-sent:'
export const DISCORD_SEND_TTL_S = 30 * 86_400
const TITLE_MAX = 140

export interface DiscordSendRecord {
  title: string
  ok: boolean
}

export function discordSendKey(nowMs: number, rand: string): string {
  return `${DISCORD_SEND_PREFIX}${new Date(nowMs).toISOString()}:${rand}`
}

export function clipTitle(raw: string): string {
  return raw.length <= TITLE_MAX ? raw : `${raw.slice(0, TITLE_MAX - 1)}…`
}

export async function recordDiscordSend(
  kv: KVLike | undefined,
  rec: DiscordSendRecord,
  nowMs: number = Date.now(),
  rand: string = Math.random().toString(36).slice(2, 6),
): Promise<void> {
  if (!kv) return
  const meta: DiscordSendRecord = { title: clipTitle(rec.title), ok: rec.ok }
  await kvPut(kv, discordSendKey(nowMs, rand), '1', { expirationTtl: DISCORD_SEND_TTL_S, metadata: meta })
}
