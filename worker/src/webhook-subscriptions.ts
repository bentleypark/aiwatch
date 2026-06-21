// Server-side per-user Discord alert subscriptions (#486).
//
// Why this exists: per-user Discord alerts were delivered browser-side (#467, #475) — the worker
// only stored a hash of the URL and the browser did the POST. That meant alerts fired ONLY while a
// dashboard tab was open (and were exposed to SW-cache version drift, multi-tab dupes, etc.). #486
// moves delivery server-side: the worker stores the (encrypted) URL + filters and the cron fan-out
// POSTs directly, so alerts fire tab-independently.
//
// AIWatch is anonymous (no login). To stop anyone registering SOMEONE ELSE'S webhook (a spam
// vector), we prove **control of the channel**, not mere possession of the URL: subscribe sends a
// one-time code THROUGH the webhook channel; the user must read it there and confirm. This combines
// email double-opt-in with the webhook challenge-response pattern (webhooks.fyi). Channel control is
// the identity — no account, email, or PII.
//
// This module is pure logic + Web Crypto + KV-key helpers; HTTP wiring lives in index.ts. The cron
// fan-out (deliverToSubscribers) is wired into the scheduled handler as of #486 PR3, which also
// removed the old browser relay in the same release so the two paths never double-send.

import { kvPut, kvDel, isAllowedAlertWebhook } from './utils'
import { isDownUrl } from './rss'
import type { AlertFeedEntry, AlertKind } from './alert-feed'

// ── Types ────────────────────────────────────────────────────────────────

/** Per-user delivery filters — mirrors the SPA Settings shape (alertCondition/Target/Services/
 *  Incidents) so `shouldDeliver` stays byte-parity with the former client `shouldRelay` (#475). */
export interface SubscriptionFilters {
  alertCondition: 'down' | 'all'
  alertTarget: 'all' | 'custom'
  alertServices: string[]
  alertIncidents: boolean
}

/** A pending (unconfirmed) subscription — holds the encrypted URL + the one-time code until the
 *  user proves channel control via /confirm. TTL 15min (PENDING_TTL_S). */
export interface PendingSubscription {
  encUrl: string
  code: string
  filters: SubscriptionFilters
  createdAt: string
}

/** A confirmed subscription — permanent (no TTL); pruned only on user unsubscribe or dead-webhook
 *  detection. `failCount` tracks consecutive delivery failures for the prune rule. */
export interface ConfirmedSubscription {
  encUrl: string
  filters: SubscriptionFilters
  type: 'discord'
  registeredAt: string
  failCount: number
}

// ── Constants ──────────────────────────────────────────────────────────────

export const PENDING_PREFIX = 'webhook:pending:'
export const SUB_PREFIX = 'webhook:sub:'
export const SENT_PREFIX = 'webhook:sent:' // webhook:sent:{hash}:{alertKey} — per-sub delivery dedup
export const CONFIRM_BUDGET_PREFIX = 'webhook:confirm:budget:' // hourly global confirm-message cap

export const PENDING_TTL_S = 900 // 15 min — window to read the code in Discord and click confirm
export const SENT_TTL_S = 7200 // 2h — per-sub dedup across overlapping crons (mirrors the 2h status-alert dedup TTL)
export const CONFIRM_BUDGET_TTL_S = 7200 // 2h — covers the hourly bucket plus slack

/** Global cap on confirm-messages sent per hour (abuse backstop — subscribe POSTs to an arbitrary
 *  channel). Per-IP limits live in index.ts; this KV counter is the cross-isolate ceiling. */
export const CONFIRM_BUDGET_MAX = 5000

/** Consecutive delivery failures before a confirmed sub is pruned (~25min at the 5-min cron). 410/404
 *  bypass this and prune immediately (handled in deliverToSubscribers). */
export const MAX_FAIL_COUNT = 5

// ── Hashing + code generation ───────────────────────────────────────────────

/** SHA-256 hex of the webhook URL — the KV key suffix. Lets us dedup + delete without the raw URL
 *  ever appearing in a key (matches the #467 ping-hash construction). */
export async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input)
  const digest = await crypto.subtle.digest('SHA-256', data)
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** A 6-digit confirmation code (zero-padded). Uses crypto.getRandomValues — not Math.random — so
 *  the code isn't predictable from timing. ~10^6 space + the per-IP confirm rate limit (index.ts). */
export function generateCode(): string {
  const buf = new Uint32Array(1)
  crypto.getRandomValues(buf)
  return String(buf[0] % 1_000_000).padStart(6, '0')
}

// ── AES-GCM encryption of the webhook URL ───────────────────────────────────
//
// Format (string): `{keyId}.{ivB64}.{ctB64}` — keyId lets the secret rotate without orphaning old
// rows (decrypt picks the key by id). IV is a fresh 12-byte nonce per encryption (GCM requirement:
// never reuse an IV under the same key). The key material is the WEBHOOK_ENC_KEY secret as 64 hex
// chars (AES-256). Fail-closed: callers must treat a missing/short key as "subscriptions disabled".

const ENC_KEY_ID = 'v1'

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return out
}

function bytesToB64(bytes: Uint8Array): string {
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin)
}

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

/** True if the secret is a usable AES-256 key (64 hex chars). Used to fail-closed at the endpoint. */
export function isValidEncKey(keyHex: string | undefined): keyHex is string {
  return typeof keyHex === 'string' && /^[0-9a-fA-F]{64}$/.test(keyHex)
}

async function importKey(keyHex: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', hexToBytes(keyHex), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt'])
}

/** Encrypt a webhook URL → `{keyId}.{ivB64}.{ctB64}`. Throws if the key is invalid (caller fail-closes). */
export async function encryptUrl(plaintext: string, keyHex: string): Promise<string> {
  if (!isValidEncKey(keyHex)) throw new Error('WEBHOOK_ENC_KEY missing or invalid')
  const key = await importKey(keyHex)
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(plaintext))
  return `${ENC_KEY_ID}.${bytesToB64(iv)}.${bytesToB64(new Uint8Array(ct))}`
}

/** Decrypt `{keyId}.{ivB64}.{ctB64}` → URL. Returns null on any malformation / wrong key / tamper
 *  (GCM auth failure) so a single bad row never throws inside the fan-out loop. */
export async function decryptUrl(payload: string, keyHex: string): Promise<string | null> {
  if (!isValidEncKey(keyHex)) return null
  const parts = payload.split('.')
  if (parts.length !== 3 || parts[0] !== ENC_KEY_ID) return null
  try {
    const key = await importKey(keyHex)
    const iv = b64ToBytes(parts[1])
    const ct = b64ToBytes(parts[2])
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct)
    return new TextDecoder().decode(pt)
  } catch {
    return null
  }
}

// ── Filter validation + delivery decision ────────────────────────────────────

const VALID_CONDITIONS = new Set(['down', 'all'])
const VALID_TARGETS = new Set(['all', 'custom'])

/** Coerce untrusted JSON into a safe SubscriptionFilters, defaulting anything missing/invalid to the
 *  permissive baseline (all conditions, all services, incidents on) — the same defaults the SPA uses. */
export function normalizeFilters(raw: unknown): SubscriptionFilters {
  const r = (raw ?? {}) as Record<string, unknown>
  const alertCondition = VALID_CONDITIONS.has(r.alertCondition as string) ? (r.alertCondition as 'down' | 'all') : 'all'
  const alertTarget = VALID_TARGETS.has(r.alertTarget as string) ? (r.alertTarget as 'all' | 'custom') : 'all'
  const alertServices = Array.isArray(r.alertServices)
    ? r.alertServices.filter((s): s is string => typeof s === 'string').slice(0, 100)
    : []
  const alertIncidents = r.alertIncidents !== false // default on
  return { alertCondition, alertTarget, alertServices, alertIncidents }
}

const INCIDENT_KINDS = new Set<AlertKind>(['new', 'resolved'])
const STATUS_KINDS = new Set<AlertKind>(['down', 'degraded', 'recovered'])

/** Whether a feed entry should be delivered to a subscriber, given their filters. Ported verbatim
 *  from the former client `shouldRelay` (webhookAlerts.js) so server delivery matches what the
 *  browser relay did (pinned by a parity test):
 *   - alertTarget 'custom' → at least one covered service must be in alertServices.
 *   - incident kinds (new/resolved) → gated by alertIncidents (default on).
 *   - status kinds → alertCondition 'down' drops degraded; 'all' keeps everything. */
export function shouldDeliver(entry: AlertFeedEntry, filters: SubscriptionFilters): boolean {
  if (filters.alertTarget === 'custom' && !entry.svcIds?.some((id) => filters.alertServices.includes(id))) {
    return false
  }
  if (INCIDENT_KINDS.has(entry.kind)) return filters.alertIncidents !== false
  if (STATUS_KINDS.has(entry.kind)) {
    if (filters.alertCondition === 'down' && entry.kind === 'degraded') return false
    return true
  }
  return false // unknown kind — never deliver
}

// ── KV operations ────────────────────────────────────────────────────────────

/** Reserve one unit of the hourly confirm-message budget. Returns false if the bucket is exhausted
 *  (caller returns 503). Best-effort + APPROXIMATE: a KV read failure is treated as "allow" (see
 *  below), and the get-then-put is non-atomic (KV has no atomic increment), so under concurrency the
 *  cap can be slightly overshot and increments lost. That's acceptable — it's a coarse global
 *  backstop, not a precise quota; the per-IP limiter does the fine-grained work. */
export async function reserveConfirmBudget(kv: KVNamespace, hourBucket: string): Promise<boolean> {
  const key = `${CONFIRM_BUDGET_PREFIX}${hourBucket}`
  let count = 0
  try {
    const raw = await kv.get(key)
    count = raw ? parseInt(raw, 10) || 0 : 0
  } catch (err) {
    // KV read failed — fail OPEN (don't hard-block subscribes on a transient KV blip); the per-IP
    // limiter is still the first line of defense. Log loudly: this disables the global abuse cap, so
    // a persistent KV failure here is a real (if rare) weakening of the spam ceiling.
    console.warn('[webhook-budget] KV read failed, allowing (global cap disabled this call):', err instanceof Error ? err.message : err)
    return true
  }
  if (count >= CONFIRM_BUDGET_MAX) return false
  await kvPut(kv, key, String(count + 1), { expirationTtl: CONFIRM_BUDGET_TTL_S })
  return true
}

/** Store a pending subscription (15min TTL). Caller has already validated the URL + reserved budget. */
export async function putPending(kv: KVNamespace, hash: string, pending: PendingSubscription): Promise<boolean> {
  return kvPut(kv, `${PENDING_PREFIX}${hash}`, JSON.stringify(pending), { expirationTtl: PENDING_TTL_S })
}

export async function readPending(kv: KVNamespace, hash: string): Promise<PendingSubscription | null> {
  try {
    const raw = await kv.get(`${PENDING_PREFIX}${hash}`)
    return raw ? (JSON.parse(raw) as PendingSubscription) : null
  } catch {
    return null
  }
}

/** Promote a confirmed sub to permanent storage (no TTL). Metadata carries type for fast list reads. */
export async function putConfirmed(kv: KVNamespace, hash: string, sub: ConfirmedSubscription): Promise<boolean> {
  try {
    await kv.put(`${SUB_PREFIX}${hash}`, JSON.stringify(sub), { metadata: { type: sub.type } })
    return true
  } catch (err) {
    console.warn('[webhook-sub] putConfirmed failed:', err instanceof Error ? err.message : err)
    return false
  }
}

export async function readConfirmed(kv: KVNamespace, hash: string): Promise<ConfirmedSubscription | null> {
  try {
    const raw = await kv.get(`${SUB_PREFIX}${hash}`)
    return raw ? (JSON.parse(raw) as ConfirmedSubscription) : null
  } catch {
    return null
  }
}

export async function deletePending(kv: KVNamespace, hash: string): Promise<void> {
  await kvDel(kv, `${PENDING_PREFIX}${hash}`)
}

export async function deleteConfirmed(kv: KVNamespace, hash: string): Promise<void> {
  await kvDel(kv, `${SUB_PREFIX}${hash}`)
}

/** List all confirmed-sub hashes, paginating the KV `list` cursor until complete (1000 keys/page —
 *  never assume a single call; #486 acceptance criterion). Returns the bare hashes (key minus prefix). */
export async function listConfirmedHashes(kv: KVNamespace): Promise<string[]> {
  const hashes: string[] = []
  let cursor: string | undefined
  for (;;) {
    const res = await kv.list({ prefix: SUB_PREFIX, cursor })
    for (const k of res.keys) hashes.push(k.name.slice(SUB_PREFIX.length))
    if (res.list_complete) break
    cursor = res.cursor
    if (!cursor) break
  }
  return hashes
}

// ── Subscribe / confirm / update / unsubscribe (pure-ish orchestration) ──────
//
// These return a small result object the HTTP layer maps to a status code, keeping index.ts thin and
// the decision logic unit-testable.

export type SubscribeResult =
  | { ok: true; hash: string; status: 'confirmed' | 'pending' | 'sent' }
  | { ok: false; status: 400 | 403 | 500 | 502 | 503; error: string }

/** Validate URL → dedup → reserve budget → send the confirm message → store pending. The confirm
 *  message is posted to the webhook itself (the channel-control challenge). On a Discord POST failure
 *  we return 502 and store nothing (the user has no code, so there's nothing to confirm) — the user
 *  can simply retry.
 *
 *  Dedup (the anti-abuse guard the double-opt-in exists for): if this channel is ALREADY confirmed,
 *  or a pending confirmation is still in its 15-min window, we return ok WITHOUT charging the global
 *  budget or re-posting to the channel. Otherwise a client re-POSTing /subscribe for a channel it
 *  controls would re-spam the channel and drain the 5000/hour global budget (only the per-isolate
 *  per-IP limit would push back). `status` tells the caller which case fired. */
export async function subscribe(
  kv: KVNamespace,
  encKey: string | undefined,
  url: string,
  rawFilters: unknown,
  hourBucket: string,
  now: string,
  postConfirmMessage: (url: string, code: string) => Promise<boolean>,
): Promise<SubscribeResult> {
  if (!isValidEncKey(encKey)) return { ok: false, status: 503, error: 'Subscriptions unavailable' } // fail-closed
  if (typeof url !== 'string' || !isAllowedAlertWebhook(url)) return { ok: false, status: 403, error: 'Webhook URL not allowed' }

  const hash = await sha256Hex(url)
  // Already subscribed → idempotent no-op (no send, no budget charge). Prevents re-spam of a channel
  // the caller already controls. Filter changes go through /update, not a re-subscribe.
  if (await readConfirmed(kv, hash)) return { ok: true, hash, status: 'confirmed' }
  // A confirmation is still pending in its window → don't re-send / re-charge; tell the user to check
  // their channel for the code that's already there.
  if (await readPending(kv, hash)) return { ok: true, hash, status: 'pending' }

  const budgetOk = await reserveConfirmBudget(kv, hourBucket)
  if (!budgetOk) return { ok: false, status: 503, error: 'Confirmation budget exceeded, try later' }

  const code = generateCode()
  const sent = await postConfirmMessage(url, code)
  if (!sent) return { ok: false, status: 502, error: 'Could not deliver confirmation to the webhook' }

  const encUrl = await encryptUrl(url, encKey)
  const pending: PendingSubscription = { encUrl, code, filters: normalizeFilters(rawFilters), createdAt: now }
  const stored = await putPending(kv, hash, pending)
  if (!stored) return { ok: false, status: 500, error: 'Storage error' }
  return { ok: true, hash, status: 'sent' }
}

export type ConfirmResult =
  | { ok: true }
  | { ok: false; status: 400 | 410 | 500; error: string }

/** Confirm a pending subscription: match the code, promote to a permanent confirmed sub, drop the
 *  pending row. Constant-ish-time code compare is unnecessary (per-IP rate limit + 10^6 space), but
 *  we still require an exact match. Expired/missing pending (TTL gone) → 410. A KV write failure
 *  (server fault) → 500, not 400, so the client knows to retry rather than treating it as bad input. */
export async function confirm(
  kv: KVNamespace,
  hash: string,
  code: string,
  now: string,
): Promise<ConfirmResult> {
  if (!/^[a-f0-9]{64}$/.test(hash) || !/^\d{6}$/.test(code)) return { ok: false, status: 400, error: 'Invalid request' }
  const pending = await readPending(kv, hash)
  if (!pending) return { ok: false, status: 410, error: 'Confirmation expired or not found' }
  if (pending.code !== code) return { ok: false, status: 400, error: 'Incorrect code' }
  const sub: ConfirmedSubscription = {
    encUrl: pending.encUrl,
    filters: pending.filters,
    type: 'discord',
    registeredAt: now,
    failCount: 0,
  }
  const ok = await putConfirmed(kv, hash, sub)
  if (!ok) return { ok: false, status: 500, error: 'Storage error' }
  // Promote-then-delete: if this delete fails the pending row TTLs out in ≤15min (benign), whereas
  // deleting first then failing to promote would lose a confirmed sub — so this ordering is correct.
  await deletePending(kv, hash)
  return { ok: true }
}

export type UpdateResult = { ok: true } | { ok: false; status: 400 | 404 | 500; error: string }

/** Filters-only update on an already-confirmed sub — no new OTP (channel control already proven).
 *  A URL change is NOT this path: it's a new channel ⇒ must re-subscribe (new hash + OTP). A KV write
 *  failure → 500 (server fault, retryable), not 400. */
export async function updateFilters(kv: KVNamespace, hash: string, rawFilters: unknown): Promise<UpdateResult> {
  if (!/^[a-f0-9]{64}$/.test(hash)) return { ok: false, status: 400, error: 'Invalid request' }
  const sub = await readConfirmed(kv, hash)
  if (!sub) return { ok: false, status: 404, error: 'Subscription not found' }
  sub.filters = normalizeFilters(rawFilters)
  const ok = await putConfirmed(kv, hash, sub)
  if (!ok) return { ok: false, status: 500, error: 'Storage error' }
  return { ok: true }
}

/** Unsubscribe = immediate complete deletion (the privacy deletion path). Also clears any pending. */
export async function unsubscribe(kv: KVNamespace, hash: string): Promise<UpdateResult> {
  if (!/^[a-f0-9]{64}$/.test(hash)) return { ok: false, status: 400, error: 'Invalid request' }
  await deleteConfirmed(kv, hash)
  await deletePending(kv, hash)
  return { ok: true }
}

// ── Cron fan-out (wired into the scheduled handler, #486 PR3) ────────────────

export interface DeliveryStats {
  attempted: number
  delivered: number
  pruned: number
  failed: number
  /** Per-sub async fns that rejected unexpectedly (should be ~0 — the loop body catches its own KV/
   *  fetch errors). A non-zero count means an un-guarded await slipped in; surfaced so the cron can
   *  log it rather than have allSettled swallow it invisibly. */
  rejected: number
}

/** Classify a Discord delivery HTTP status into the prune/retry decision (#486):
 *   - 410/404 → prune immediately (webhook deleted / gone — unrecoverable)
 *   - 2xx     → success (reset failCount)
 *   - else (429/5xx/network) → retry; increment failCount; prune at MAX_FAIL_COUNT */
export type DeliveryOutcome = 'success' | 'prune' | 'retry'
export function classifyDelivery(status: number | null): DeliveryOutcome {
  if (status === 410 || status === 404) return 'prune'
  if (status !== null && status >= 200 && status < 300) return 'success'
  return 'retry'
}

// #726 — per-user (general subscriber) parity exception to the #475 byte-identical contract, the
// same kind of exception as the operator-only tweet draft (which is stripped from the feed). The
// operator embed's "View on AIWatch" link points at the operator dashboard (ai-watch.dev/#{svc});
// general subscribers should land on the friendlier is-down page instead (matching Slack /feed).
// Today the only `ai-watch.dev/#<id>` in the description is that single "View on AIWatch" link
// (built in index.ts), but the rewrite does NOT depend on that: it's GLOBAL (`/g` — maps EVERY
// hash link to its is-down URL) and IDEMPOTENT (an already-rewritten `is-…-down` URL has no hash to
// match), so it stays correct even if a future section adds a second dashboard link. NO_IS_DOWN_PAGE
// services (bedrock/azureopenai) map back to the same hash → per-link no-op. Operator delivery is a
// direct cron post (not via deliverToSubscribers), so the operator link is never touched.
// The link format is pinned by a test (toPerUserEntry rewrites the exact `[View on AIWatch](url)`
// markup index.ts emits) so a host/format drift breaks the build, not silently per-user delivery.
const DASHBOARD_HASH_LINK_RE = /https:\/\/ai-watch\.dev\/#([a-z0-9]+)/g
export function toPerUserEntry(entry: AlertFeedEntry): AlertFeedEntry {
  const desc = entry.embed.description
  if (!desc) return entry
  const rewritten = desc.replace(DASHBOARD_HASH_LINK_RE, (_m, id) => isDownUrl(id))
  return rewritten === desc ? entry : { ...entry, embed: { ...entry.embed, description: rewritten } }
}

/** Fan-out the recent alert feed to all confirmed subscribers. Each sub: decrypt URL → filter →
 *  dedup (webhook:sent:) → POST. Isolated per sub (one dead webhook never blocks the rest). Dead
 *  webhooks (410/404, or MAX_FAIL_COUNT consecutive retries) are pruned. Wired into the cron in #486
 *  PR3, which removed the browser relay in the same release so the two paths never double-send.
 *
 *  `postEmbed` returns the HTTP status (or null on network error) so classifyDelivery can decide. */
export async function deliverToSubscribers(
  kv: KVNamespace,
  encKey: string | undefined,
  feed: AlertFeedEntry[],
  postEmbed: (url: string, entry: AlertFeedEntry) => Promise<number | null>,
  now: number,
): Promise<DeliveryStats> {
  const stats: DeliveryStats = { attempted: 0, delivered: 0, pruned: 0, failed: 0, rejected: 0 }
  if (!isValidEncKey(encKey) || feed.length === 0) return stats

  const hashes = await listConfirmedHashes(kv)
  const results = await Promise.allSettled(
    hashes.map(async (hash) => {
      const sub = await readConfirmed(kv, hash)
      if (!sub) return
      const url = await decryptUrl(sub.encUrl, encKey)
      if (!url) {
        // Undecryptable row (key rotated away / corrupt) — prune so it can't wedge the loop forever.
        await deleteConfirmed(kv, hash)
        stats.pruned++
        return
      }
      let sawFailure = false
      for (const entry of feed) {
        if (!shouldDeliver(entry, sub.filters)) continue
        const sentKey = `${SENT_PREFIX}${hash}:${entry.key}`
        const already = await kv.get(sentKey).catch(() => null)
        if (already) continue
        stats.attempted++
        // #726 — general subscribers get the is-down link, not the operator dashboard link.
        const status = await postEmbed(url, toPerUserEntry(entry)).catch(() => null)
        const outcome = classifyDelivery(status)
        if (outcome === 'prune') {
          await deleteConfirmed(kv, hash)
          stats.pruned++
          return // webhook is gone — stop delivering to it this cycle
        }
        if (outcome === 'success') {
          stats.delivered++
          await kvPut(kv, sentKey, '1', { expirationTtl: SENT_TTL_S })
        } else {
          sawFailure = true
          stats.failed++
        }
      }
      // Update failCount once per sub per cycle: reset on a clean cycle, bump (and maybe prune) on failure.
      if (sawFailure) {
        const next = (sub.failCount ?? 0) + 1
        if (next >= MAX_FAIL_COUNT) {
          await deleteConfirmed(kv, hash)
          stats.pruned++
        } else {
          sub.failCount = next
          await putConfirmed(kv, hash, sub)
        }
      } else if ((sub.failCount ?? 0) > 0) {
        sub.failCount = 0
        await putConfirmed(kv, hash, sub)
      }
    }),
  )
  // allSettled is used so one bad sub can't block the rest — but a swallowed rejection would make a
  // subscriber silently vanish from delivery with no breadcrumb. Surface it: count + log the first few
  // reasons so an operator can diagnose, instead of trusting the per-sub catches forever.
  const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected')
  if (rejected.length > 0) {
    stats.rejected = rejected.length
    console.error('[webhook-deliver] unexpected per-sub rejections:', rejected.length, rejected.slice(0, 3).map((r) => r.reason instanceof Error ? r.reason.message : r.reason))
  }
  return stats
}

// #548 — new-today delta for the confirmed-subscriber count, the consent-free retention signal
// surfaced in the daily summary. Pure + unit-tested. Returns null when there's no usable prior
// snapshot (first day / KV gap / corrupt value) so the summary omits the delta rather than show a
// bogus "+N from zero". The delta is SIGNED — a negative value (churn) is reported honestly.
export function computeSubscriberDelta(todayCount: number, prevSnapshotRaw: string | null): number | null {
  // Guard the empty string too: Number('') === 0 (a JS footgun) would misread a corrupt/empty
  // snapshot as "0 subscribers yesterday" and report a bogus full-count jump. Empty = no baseline.
  if (prevSnapshotRaw == null || prevSnapshotRaw.trim() === '') return null
  const prev = Number(prevSnapshotRaw)
  if (!Number.isFinite(prev)) return null
  return todayCount - prev
}
