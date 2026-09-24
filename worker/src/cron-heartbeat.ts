// #1501 — a stopped `*/5` cron cannot report its own absence.
//
// On 2026-09-23 Cloudflare stopped dispatching the schedule for ~3h with the trigger still registered
// and `fetch` serving normally. Every cron-side check (incident alerts, #1389 uptime-liveness, the #500
// daily section) went silent with it; it was noticed only because the daily summary never arrived.
//
// So the watchdog lives on the one path that stayed alive: the cron writes a heartbeat as the FIRST thing
// it does, and `fetch` reads its age at a throttled rate. Writing first matters — the failure is "no
// invocation at all", so a heartbeat placed after the work would also stop when the work throws or times
// out and would page about the wrong thing.
//
// One key carries both the heartbeat and the alert state (`alertedAt`). The cron is the reader of that
// state on the way back up: it sees `alertedAt`, clears it by stamping, and
// posts the recovery notice.

import { kvPut, type KVLike } from './utils'

type DiscordSend = (
  webhookUrl: string,
  embed: { title: string; description: string; color: number },
) => Promise<boolean>

export const CRON_HEARTBEAT_KEY = 'cron:heartbeat'

/** Three missed five-minute slots, plus the one due now. */
export const CRON_STALE_MS = 20 * 60_000

/** A stall that outlives its first alert is repeated hourly, not once: one missed Discord message must
 *  not leave a dead cron unreported for the rest of the outage. */
export const STALL_REALERT_MS = 60 * 60_000

/** Per-isolate check interval — bounds the added KV reads to one per isolate per interval, not per request. */
export const WATCHDOG_INTERVAL_MS = 3 * 60_000

export interface CronHeartbeat {
  /** Wall-clock ms of the last cron run — or, when `seeded`, of the fetch check that started watching. */
  at: number
  /** Wall-clock ms of the last stall alert; present only between an alert and the cron's recovery. */
  alertedAt?: number
  /** Written by `fetch` when the key was absent: `at` is then not a cron run. The cron's overwrite clears it. */
  seeded?: true
}

export function parseHeartbeat(raw: string | null): CronHeartbeat | null {
  if (raw === null) return null
  try {
    const v = JSON.parse(raw) as { at?: unknown; alertedAt?: unknown; seeded?: unknown } | null
    if (!v || typeof v.at !== 'number' || !Number.isFinite(v.at)) return null
    const hb: CronHeartbeat = { at: v.at }
    if (typeof v.alertedAt === 'number' && Number.isFinite(v.alertedAt)) hb.alertedAt = v.alertedAt
    if (v.seeded === true) hb.seeded = true
    return hb
  } catch {
    return null
  }
}

export type StallVerdict = 'fresh' | 'stalled' | 'already-alerted'

export function stallVerdict(hb: CronHeartbeat, nowMs: number): StallVerdict {
  // A heartbeat written by a clock ahead of ours has a negative age; that is fresh, not stalled.
  if (nowMs - hb.at < CRON_STALE_MS) return 'fresh'
  if (hb.alertedAt !== undefined && nowMs - hb.alertedAt < STALL_REALERT_MS) return 'already-alerted'
  return 'stalled'
}

const minutes = (ms: number) => Math.round(ms / 60_000)

export function formatStallAlert(hb: CronHeartbeat, nowMs: number): string {
  const age = nowMs - hb.at
  return [
    `The \`*/5\` cron has not run for **${minutes(age)} min** (~${Math.floor(age / 300_000) - 1} missed slots). ${hb.seeded ? 'No cron run has been recorded since the watchdog started watching at' : 'Last run:'} ${new Date(hb.at).toISOString()}.`,
    '',
    'While it is down there are **no incident alerts, no AI analysis, no probing, and no daily summary**. `fetch` (dashboard, is-down pages) is still serving.',
    '',
    'Recovery: `npx wrangler triggers deploy --config worker/wrangler.toml`, then confirm the next slot with `workersInvocationsScheduled` (Cloudflare GraphQL).',
  ].join('\n')
}

export function formatRecoveryAlert(hb: CronHeartbeat, nowMs: number): string {
  return `The \`*/5\` cron is running again after **${minutes(nowMs - hb.at)} min** without a run (${hb.seeded ? 'no cron run had been recorded since the watchdog started watching at' : 'last run before the stall:'} ${new Date(hb.at).toISOString()}).`
}

/** Called by the cron, first thing each cycle: stamp the run, then report a recovery if one is owed.
 *  Never throws; the stamp is attempted even when the state read fails. */
export async function recordCronHeartbeat(
  kv: KVLike | undefined,
  discordUrl: string | undefined,
  nowMs: number,
  send: DiscordSend,
): Promise<void> {
  if (!kv || !discordUrl) return
  try {
    let prev: CronHeartbeat | null = null
    try {
      prev = parseHeartbeat(await kv.get(CRON_HEARTBEAT_KEY))
    } catch (err) {
      console.warn('[cron] #1501 heartbeat read failed — a pending recovery notice may be skipped:', err instanceof Error ? err.message : err)
    }
    const stamped = await kvPut(kv, CRON_HEARTBEAT_KEY, JSON.stringify({ at: nowMs } satisfies CronHeartbeat))
    if (stamped && prev?.alertedAt !== undefined) {
      const ok = await send(discordUrl, {
        title: '✅ Cron resumed',
        description: formatRecoveryAlert(prev, nowMs),
        color: 0x2ecc71,
      })
      if (!ok) console.warn('[cron] #1501 recovery notice was not delivered')
    }
  } catch (err) {
    console.error('[cron] #1501 heartbeat failed:', err instanceof Error ? err.message : err)
  }
}

export type WatchdogResult = 'skipped' | 'seeded' | 'fresh' | 'alerted' | 'deduped' | 'send-failed' | 'unreadable'

/** Called from `fetch`: alert when the heartbeat is stale. Never throws.
 *
 *  An absent key is seeded rather than ignored — otherwise a stall that begins before the first cron run
 *  after this ships would leave no key for the check to age, which is the exact case it exists for. An
 *  unreadable read or value alerts nobody: the input is gone, and the cron's next run rewrites it. */
export async function checkCronHeartbeat(
  kv: KVLike | undefined,
  discordUrl: string | undefined,
  nowMs: number,
  send: DiscordSend,
): Promise<WatchdogResult> {
  if (!kv || !discordUrl) return 'skipped'
  try {
    const raw = await kv.get(CRON_HEARTBEAT_KEY)
    if (raw === null) {
      await kvPut(kv, CRON_HEARTBEAT_KEY, JSON.stringify({ at: nowMs, seeded: true } satisfies CronHeartbeat))
      return 'seeded'
    }
    const hb = parseHeartbeat(raw)
    if (!hb) {
      console.warn('[watchdog] #1501 heartbeat value is unparseable — waiting for the cron to rewrite it')
      return 'unreadable'
    }
    const verdict = stallVerdict(hb, nowMs)
    if (verdict === 'fresh') return 'fresh'
    if (verdict === 'already-alerted') return 'deduped'
    const ok = await send(discordUrl, {
      title: '🚨 Cron stalled',
      description: formatStallAlert(hb, nowMs),
      color: 0xe74c3c,
    })
    // The dedup write follows a successful send only, so a failed webhook retries at the next check
    // instead of being swallowed by its own marker (#500/#992).
    if (!ok) return 'send-failed'
    await kvPut(kv, CRON_HEARTBEAT_KEY, JSON.stringify({ ...hb, alertedAt: nowMs } satisfies CronHeartbeat))
    return 'alerted'
  } catch (err) {
    console.warn('[watchdog] #1501 heartbeat check failed:', err instanceof Error ? err.message : err)
    return 'unreadable'
  }
}

/** Per-isolate rate limit. `claim` takes the slot synchronously, so concurrent requests in one isolate
 *  cannot each start a check before the first has finished. */
export function createWatchdogThrottle(intervalMs: number) {
  let last = -Infinity
  return {
    claim(nowMs: number): boolean {
      if (nowMs - last < intervalMs) return false
      last = nowMs
      return true
    },
  }
}
