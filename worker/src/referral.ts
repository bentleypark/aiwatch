// Outbound referral counter — #842 Deliverable A.
//
// The is-down "Open ↗" wedge (renderFallbacks) already fires a GA4 `outbound_fallback_click` when a
// visitor clicks through to a recommended alternative's provider site. GA is CONSENT-GATED, so it
// only counts consenting visitors — a systematic undercount that makes it a poor sponsor-evidence
// metric ("we sent N users to the alternative at the failover moment"). This module records the SAME
// click server-side, consent-free, via a lightweight `POST /api/referral` beacon → the honest number.
//
// Storage: `referral:out:{YYYY-MM-DD}` KV (2d TTL, mirrors the alert:count/push:count daily-counter
// pattern), surfaced in the operator daily summary. No PII — just counts by destination service.

import type { KVLike } from './utils'
import { kvPut } from './utils'

export interface ReferralCounts {
  total: number
  byService: Record<string, number> // destination service id → count
}

/** Daily KV key. */
export function referralKey(date: string): string {
  return `referral:out:${date}`
}

/**
 * Validate a beacon body → `{ from, to }` or null. `to` (the outbound target) MUST be a known service
 * id — this is the abuse guard: the endpoint is public + unauthenticated, so an arbitrary body can't
 * inflate an unknown bucket. `from` (the source is-down service) is kept only when also valid, else
 * ''. Cheap id-safe validation; no free-form strings enter KV. Pure.
 */
export function parseReferralBody(body: unknown, validIds: Set<string>): { from: string; to: string } | null {
  if (!body || typeof body !== 'object') return null
  const b = body as Record<string, unknown>
  const to = typeof b.to === 'string' ? b.to : ''
  if (!validIds.has(to)) return null
  const from = typeof b.from === 'string' && validIds.has(b.from) ? b.from : ''
  return { from, to }
}

/** Fold one referral into the daily counts (pure — testable apart from KV). Defensive against a
 *  malformed `existing` (non-number total OR non-object byService) — treats it as empty. */
export function addReferral(existing: ReferralCounts | null | undefined, to: string): ReferralCounts {
  const ok = existing && typeof existing.total === 'number' && existing.byService && typeof existing.byService === 'object'
  const c = ok ? existing : { total: 0, byService: {} }
  return { total: c.total + 1, byService: { ...c.byService, [to]: (c.byService[to] ?? 0) + 1 } }
}

/**
 * Record an outbound referral to `referral:out:{date}` (read-modify-write, 2d TTL). Best-effort —
 * returns false (and never throws) on a KV/parse error so the beacon handler can't fail the request.
 */
export async function recordReferral(kv: KVLike, date: string, to: string): Promise<boolean> {
  const key = referralKey(date)
  try {
    const raw = await kv.get(key).catch(() => null)
    let existing: ReferralCounts | null = null
    if (raw) {
      try {
        const parsed = JSON.parse(raw)
        if (parsed && typeof parsed === 'object') existing = parsed as ReferralCounts
      } catch {
        // corrupt value — start fresh rather than lose the count
      }
    }
    return await kvPut(kv, key, JSON.stringify(addReferral(existing, to)), { expirationTtl: 172800 })
  } catch {
    return false
  }
}
