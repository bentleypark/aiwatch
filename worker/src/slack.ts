// #1581 — "Add to Slack" one-click install: OAuth v2 with the single `incoming-webhook` scope.
//
// The install stores the channel's webhook URL as a per-user subscription (the #486 store), so the
// existing cron fan-out delivers to it. OAuth proves the installer can post to the channel, so there
// is no #486 double opt-in. The welcome message carries a channel-scoped manage link — whoever can
// read the channel can change the services or unsubscribe; nothing else identifies them.
//
// Pure logic + Web Crypto + KV helpers; HTTP wiring lives in index.ts.

import { SERVICES } from './services'
import { kvPut, kvDel } from './utils'
import { escapeSlack, SLACK_WEBHOOK_PREFIX } from './slack-message'
import {
  SLACK_CHANNEL_PREFIX,
  SLACK_MANAGE_PREFIX,
  deleteConfirmed,
  deleteSubscription,
  encryptUrl,
  isSubscriberHash,
  isValidEncKey,
  normalizeFilters,
  putConfirmed,
  readConfirmed,
  sha256Hex,
  type ConfirmedSubscription,
  type SubscriptionFilters,
} from './webhook-subscriptions'

export const SLACK_AUTHORIZE_URL = 'https://slack.com/oauth/v2/authorize'
export const SLACK_ACCESS_URL = 'https://slack.com/api/oauth.v2.access'
export const SLACK_SCOPE = 'incoming-webhook'
export const STATE_COOKIE = 'aiwatch_slack_state'
export const STATE_TTL_S = 600

const KNOWN_SERVICE_IDS = new Set(SERVICES.map((s) => s.id))
const SERVICE_NAME = new Map(SERVICES.map((s) => [s.id, s.name]))

// ── Install filters ──────────────────────────────────────────────────────────

/** `?services=claude,openai&condition=down&incidents=0` → filters. Unknown ids are dropped; no known
 *  id left means every service. */
export function parseInstallFilters(params: URLSearchParams): SubscriptionFilters {
  const services = (params.get('services') ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((id) => KNOWN_SERVICE_IDS.has(id))
  return normalizeFilters({
    alertTarget: services.length > 0 ? 'custom' : 'all',
    alertServices: [...new Set(services)],
    alertCondition: params.get('condition') === 'down' ? 'down' : 'all',
    alertIncidents: params.get('incidents') !== '0',
  })
}

// ── Signed OAuth state ───────────────────────────────────────────────────────
//
// `state` = base64url(JSON {n, f, e}) + "." + HMAC-SHA256 over it, keyed by the Slack client secret.
// `n` must equal the nonce in the installer's own cookie, which binds the callback to the browser that
// started the install; `e` bounds the window. Nothing is written to KV before Slack returns a code.

function b64urlFromBytes(bytes: Uint8Array): string {
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function b64urlEncodeString(s: string): string {
  return b64urlFromBytes(new TextEncoder().encode(s))
}

function b64urlDecodeString(s: string): string | null {
  try {
    const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4)
    const bin = atob(b64)
    const bytes = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
    return new TextDecoder().decode(bytes)
  } catch {
    return null
  }
}

/** 32 random bytes, base64url (43 chars). */
export function randomToken(): string {
  return b64urlFromBytes(crypto.getRandomValues(new Uint8Array(32)))
}

async function hmac(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data))
  return b64urlFromBytes(new Uint8Array(sig))
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

export async function signState(nonce: string, filters: SubscriptionFilters, expiresAtMs: number, secret: string): Promise<string> {
  const body = b64urlEncodeString(JSON.stringify({ n: nonce, f: filters, e: expiresAtMs }))
  return `${body}.${await hmac(secret, body)}`
}

/** The filters carried by a valid state, or null when the signature, expiry or cookie nonce fails. */
export async function verifyState(state: string, secret: string, cookieNonce: string | null, nowMs: number): Promise<SubscriptionFilters | null> {
  const dot = state.indexOf('.')
  if (dot <= 0 || !cookieNonce) return null
  const body = state.slice(0, dot)
  if (!safeEqual(state.slice(dot + 1), await hmac(secret, body))) return null
  const json = b64urlDecodeString(body)
  if (!json) return null
  let parsed: { n?: unknown; f?: unknown; e?: unknown }
  try {
    parsed = JSON.parse(json)
  } catch {
    return null
  }
  if (typeof parsed.e !== 'number' || parsed.e < nowMs) return null
  if (typeof parsed.n !== 'string' || !safeEqual(parsed.n, cookieNonce)) return null
  return normalizeFilters(parsed.f)
}

export function buildAuthorizeUrl(clientId: string, redirectUri: string, state: string): string {
  const q = new URLSearchParams({ client_id: clientId, scope: SLACK_SCOPE, redirect_uri: redirectUri, state })
  return `${SLACK_AUTHORIZE_URL}?${q.toString()}`
}

export function stateCookie(nonce: string): string {
  return `${STATE_COOKIE}=${nonce}; Max-Age=${STATE_TTL_S}; Path=/api/slack; HttpOnly; Secure; SameSite=Lax`
}

export function clearStateCookie(): string {
  return `${STATE_COOKIE}=; Max-Age=0; Path=/api/slack; HttpOnly; Secure; SameSite=Lax`
}

export function readCookie(header: string | null, name: string): string | null {
  if (!header) return null
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq > 0 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim() || null
  }
  return null
}

// ── Code exchange ────────────────────────────────────────────────────────────

export type ExchangeResult =
  | { ok: true; webhookUrl: string; teamId: string; channelId: string }
  | { ok: false; error: string }

export async function exchangeCode(
  fetchFn: typeof fetch,
  clientId: string,
  clientSecret: string,
  code: string,
  redirectUri: string,
): Promise<ExchangeResult> {
  let json: {
    ok?: boolean
    error?: string
    team?: { id?: string }
    incoming_webhook?: { url?: string; channel_id?: string }
  }
  try {
    const resp = await fetchFn(SLACK_ACCESS_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Basic ${btoa(`${clientId}:${clientSecret}`)}`,
      },
      body: new URLSearchParams({ code, redirect_uri: redirectUri }).toString(),
    })
    json = await resp.json()
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'exchange failed' }
  }
  if (!json.ok) return { ok: false, error: json.error ?? 'not ok' }
  const webhookUrl = json.incoming_webhook?.url
  const channelId = json.incoming_webhook?.channel_id
  const teamId = json.team?.id
  if (!webhookUrl || !webhookUrl.startsWith(SLACK_WEBHOOK_PREFIX) || !channelId || !teamId) {
    return { ok: false, error: 'missing incoming_webhook' }
  }
  return { ok: true, webhookUrl, teamId, channelId }
}

// ── Store the install ────────────────────────────────────────────────────────

/** Store the install as a confirmed Slack subscription and return the manage token (shown once, in
 *  the welcome message). One subscription per channel: a reinstall to the same channel replaces the
 *  earlier one. Null on a storage failure. */
export async function completeInstall(
  kv: KVNamespace,
  encKey: string,
  install: { webhookUrl: string; teamId: string; channelId: string },
  filters: SubscriptionFilters,
  now: string,
): Promise<{ hash: string; manageToken: string } | null> {
  const hash = await sha256Hex(install.webhookUrl)
  const channelKey = await sha256Hex(`${install.teamId}:${install.channelId}`)
  const prevHash = await kv.get(`${SLACK_CHANNEL_PREFIX}${channelKey}`).catch(() => null)
  const prevSub = prevHash && prevHash !== hash && isSubscriberHash(prevHash) ? await readConfirmed(kv, prevHash) : null

  const manageToken = randomToken()
  const manageTokenHash = await sha256Hex(manageToken)
  const sub: ConfirmedSubscription = {
    encUrl: await encryptUrl(install.webhookUrl, encKey),
    filters,
    type: 'slack',
    registeredAt: now,
    failCount: 0,
    manageTokenHash,
    channelKey,
  }
  if (!(await kvPut(kv, `${SLACK_MANAGE_PREFIX}${manageTokenHash}`, hash))) return null
  if (!(await kvPut(kv, `${SLACK_CHANNEL_PREFIX}${channelKey}`, hash))) return null
  if (!(await putConfirmed(kv, hash, sub))) return null

  if (prevHash && prevSub) {
    await deleteConfirmed(kv, prevHash)
    if (prevSub.manageTokenHash) await kvDel(kv, `${SLACK_MANAGE_PREFIX}${prevSub.manageTokenHash}`)
  }
  return { hash, manageToken }
}

// ── Manage link ──────────────────────────────────────────────────────────────

export async function resolveManageToken(kv: KVNamespace, token: string): Promise<{ hash: string; sub: ConfirmedSubscription } | null> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null
  const tokenHash = await sha256Hex(token)
  const hash = await kv.get(`${SLACK_MANAGE_PREFIX}${tokenHash}`).catch(() => null)
  if (!hash || !isSubscriberHash(hash)) return null
  const sub = await readConfirmed(kv, hash)
  if (!sub || sub.type !== 'slack' || sub.manageTokenHash !== tokenHash) return null
  return { hash, sub }
}

export type ManageResult =
  | { ok: true; filters?: SubscriptionFilters; services?: { id: string; name: string }[] }
  | { ok: false; status: 400 | 404 | 500; error: string }

export async function manageSlack(kv: KVNamespace, token: string, action: unknown, rawFilters: unknown): Promise<ManageResult> {
  if (action !== 'get' && action !== 'update' && action !== 'unsubscribe') return { ok: false, status: 400, error: 'Invalid action' }
  const found = await resolveManageToken(kv, token)
  if (!found) return { ok: false, status: 404, error: 'Subscription not found' }
  if (action === 'get') return { ok: true, filters: found.sub.filters, services: SERVICES.map((s) => ({ id: s.id, name: s.name })) }
  if (action === 'unsubscribe') {
    await deleteSubscription(kv, found.hash, found.sub)
    return { ok: true }
  }
  const filters = normalizeFilters(rawFilters)
  filters.alertServices = filters.alertServices.filter((id) => KNOWN_SERVICE_IDS.has(id))
  if (!(await putConfirmed(kv, found.hash, { ...found.sub, filters }))) return { ok: false, status: 500, error: 'Storage error' }
  return { ok: true, filters }
}

export function buildWelcomeMessage(filters: SubscriptionFilters, manageUrl: string): { text: string } {
  const services = filters.alertTarget === 'custom' && filters.alertServices.length > 0
    ? filters.alertServices.map((id) => SERVICE_NAME.get(id) ?? id).join(', ')
    : 'every service AIWatch monitors'
  const lines = [
    ':white_check_mark: *AIWatch alerts are connected to this channel.*',
    `Services: ${escapeSlack(services)}`,
    `Status changes: ${filters.alertCondition === 'down' ? 'outages only' : 'outages and degraded performance'}`,
    `Incident updates: ${filters.alertIncidents ? 'on' : 'off'}`,
    `<${manageUrl}|Change services or unsubscribe> — anyone who can read this channel can use this link.`,
  ]
  return { text: lines.join('\n') }
}

// ── HTTP: install + OAuth callback ───────────────────────────────────────────

export interface SlackRouteEnv {
  kv: KVNamespace
  encKey: string | undefined
  clientId: string | undefined
  clientSecret: string | undefined
  redirectUri: string | undefined
  site: string
  fetchFn: typeof fetch
  nowMs: number
}

/** GET /api/slack/install (start OAuth) and GET /api/slack/oauth (Slack's callback). Every outcome of
 *  the callback is a redirect to `${site}/slack?result=…`; the manage token only ever travels in the
 *  welcome message. */
export async function handleSlackOAuthRoute(request: Request, env: SlackRouteEnv): Promise<Response> {
  const url = new URL(request.url)
  const site = env.site.replace(/\/$/, '')
  const done = (result: string) => new Response(null, {
    status: 302,
    headers: { Location: `${site}/slack?result=${result}`, 'Set-Cookie': clearStateCookie(), 'Cache-Control': 'no-store' },
  })
  const { clientId, clientSecret, encKey, fetchFn } = env
  if (!clientId || !clientSecret || !isValidEncKey(encKey)) return done('unavailable')
  const redirectUri = env.redirectUri || `${url.origin}/api/slack/oauth`

  if (url.pathname === '/api/slack/install') {
    const nonce = randomToken()
    const state = await signState(nonce, parseInstallFilters(url.searchParams), env.nowMs + STATE_TTL_S * 1000, clientSecret)
    return new Response(null, {
      status: 302,
      headers: { Location: buildAuthorizeUrl(clientId, redirectUri, state), 'Set-Cookie': stateCookie(nonce), 'Cache-Control': 'no-store' },
    })
  }

  if (url.searchParams.get('error')) return done('denied')
  const code = url.searchParams.get('code')
  const filters = await verifyState(url.searchParams.get('state') ?? '', clientSecret, readCookie(request.headers.get('Cookie'), STATE_COOKIE), env.nowMs)
  if (!code || !filters) return done('expired')
  const exchanged = await exchangeCode(fetchFn, clientId, clientSecret, code, redirectUri)
  if (!exchanged.ok) {
    console.warn('[slack/oauth] code exchange failed:', exchanged.error)
    return done('error')
  }
  const installed = await completeInstall(env.kv, encKey, exchanged, filters, new Date(env.nowMs).toISOString())
  if (!installed) return done('error')
  try {
    const resp = await fetchFn(exchanged.webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(buildWelcomeMessage(filters, `${site}/slack/manage#t=${installed.manageToken}`)),
    })
    if (!resp.ok) console.warn(`[slack/oauth] welcome message rejected (${resp.status} ${(await resp.text()).slice(0, 80)})`)
    else resp.body?.cancel()
  } catch (err) {
    console.warn('[slack/oauth] welcome message failed:', err instanceof Error ? err.message : err)
  }
  return done('installed')
}

// ── HTTP: manage link backend ────────────────────────────────────────────────

/** POST /api/slack/manage `{token, action, filters}` (CORS and the rate limit are the caller's). */
export async function handleSlackManageRequest(request: Request, kv: KVNamespace, cors: Record<string, string>): Promise<Response> {
  const headers = { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
  try {
    const body = await request.json() as { token?: unknown; action?: unknown; filters?: unknown }
    const result = await manageSlack(kv, typeof body.token === 'string' ? body.token : '', body.action, body.filters)
    if (!result.ok) return new Response(JSON.stringify({ error: result.error }), { status: result.status, headers })
    return new Response(JSON.stringify({ ok: true, filters: result.filters, services: result.services }), { headers })
  } catch (err) {
    console.error('[slack/manage] error:', err instanceof Error ? err.message : err)
    return new Response(JSON.stringify({ error: 'Internal error' }), { status: 500, headers })
  }
}
