// #1653 — the operator marks, per outage, whether an X reply went out. The X channel decision's review
// trigger compares outages where a reply was posted against ones where it was not; without this mark a
// window with no inflow cannot be told apart from one where X carried nothing to reply to, or one the
// operator missed. Two signed links ride in the operator alert; a click records the mark in KV.
//
// Pure logic + Web Crypto + KV; HTTP wiring lives in index.ts.

import { incidentTokenForAlert, type AlertCandidate } from './alerts'
import { kindFromKey } from './alert-feed'
import { hmac, safeEqual } from './slack'
import { kvPut } from './utils'

export const XREPLY_PREFIX = 'xreply:'
export const XREPLY_TTL_S = 180 * 86400
export const XREPLY_PATH = '/api/x-reply-mark'
const WORKER_ORIGIN = 'https://aiwatch-worker.p2c2kbf.workers.dev'

export type XReplyMark = 'replied' | 'none'
const MARKS: readonly XReplyMark[] = ['replied', 'none']

export interface XReplyRecord {
  mark: XReplyMark
  svc: string
  at: string
}

function signedPayload(token: string, svc: string, mark: XReplyMark): string {
  return `xreply|${token}|${svc}|${mark}`
}

export async function buildXReplyMarkUrl(secret: string, token: string, svc: string, mark: XReplyMark): Promise<string> {
  const sig = await hmac(secret, signedPayload(token, svc, mark))
  const q = new URLSearchParams({ t: token, s: svc, m: mark, sig })
  return `${WORKER_ORIGIN}${XREPLY_PATH}?${q.toString()}`
}

export async function buildXReplyMarkMessage(secret: string, token: string, svc: string): Promise<string> {
  const [replied, none] = await Promise.all([
    buildXReplyMarkUrl(secret, token, svc, 'replied'),
    buildXReplyMarkUrl(secret, token, svc, 'none'),
  ])
  return `📝 X reply for this outage → [✅ replied](${replied}) · [➖ nothing to reply to](${none})`
}

/** The incident + service to mark, for an alert that opens an incident AND carries an X reply draft. A
 *  recovery or status-edge alert gets no mark message: the reply window is the outage's start, and an
 *  edge alert has no incident id to key the mark by. */
export function xReplyMarkTarget(alert: AlertCandidate, reply: { serviceId: string } | null): { token: string; svc: string } | null {
  if (!reply || kindFromKey(alert.key) !== 'new') return null
  const token = incidentTokenForAlert(alert)
  return token ? { token, svc: reply.serviceId } : null
}

/** The mark a request carries, or null when a parameter is missing or the signature does not match. */
export async function verifyXReplyMark(params: URLSearchParams, secret: string): Promise<{ token: string; svc: string; mark: XReplyMark } | null> {
  const token = params.get('t') ?? ''
  const svc = params.get('s') ?? ''
  const mark = params.get('m') ?? ''
  const sig = params.get('sig') ?? ''
  if (!token || !svc || !sig || !MARKS.includes(mark as XReplyMark)) return null
  const expected = await hmac(secret, signedPayload(token, svc, mark as XReplyMark))
  return safeEqual(sig, expected) ? { token, svc, mark: mark as XReplyMark } : null
}

const LINK_PREVIEW_UA = /discordbot|slackbot|twitterbot|facebookexternalhit|bot\b|crawler|spider/i

export async function handleXReplyMarkRequest(request: Request, kv: KVNamespace, secret: string | undefined, nowMs: number): Promise<Response> {
  const text = (body: string, status: number) =>
    new Response(body, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } })
  if (request.method !== 'GET') return text('Method not allowed', 405)
  if (LINK_PREVIEW_UA.test(request.headers.get('User-Agent') ?? '')) return new Response(null, { status: 204 })
  if (!secret) return text('Not configured', 503)
  const marked = await verifyXReplyMark(new URL(request.url).searchParams, secret)
  if (!marked) return text('Invalid link', 403)
  const record: XReplyRecord = { mark: marked.mark, svc: marked.svc, at: new Date(nowMs).toISOString() }
  const ok = await kvPut(kv, `${XREPLY_PREFIX}${marked.token}`, JSON.stringify(record), { expirationTtl: XREPLY_TTL_S })
  if (!ok) return text('Could not record the mark — try the link again', 500)
  const label = marked.mark === 'replied' ? '✅ replied' : '➖ nothing to reply to'
  return text(`Recorded: ${label} (${marked.svc}). You can close this tab.`, 200)
}
