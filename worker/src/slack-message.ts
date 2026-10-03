// #1581 — the Slack side of per-user alert delivery: the Discord-embed → Slack message conversion,
// the poster, and the body-based classifier. Kept apart from slack.ts so webhook-subscriptions.ts can
// own Slack delivery without an import cycle.

import { appendStatusHint } from './utils'
import type { AlertFeedEntry } from './alert-feed'
import type { DeliveryOutcome } from './webhook-subscriptions'

export const SLACK_WEBHOOK_PREFIX = 'https://hooks.slack.com/services/'

export function escapeSlack(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function formatSegment(text: string): string {
  return escapeSlack(text)
    .replace(/\*\*(.+?)\*\*/g, '\u0001$1\u0001')
    .replace(/(^|[^\w*])\*(?!\s)([^*\n]+?)(?<!\s)\*(?![\w*])/g, '$1_$2_')
    .replace(/~~(.+?)~~/g, '~$1~')
    .replace(/\u0001/g, '*')
}

const MD_LINK_RE = /\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g

/** Discord markdown (the alert embed's dialect) → Slack mrkdwn: links, bold, italic, strike, and the
 *  three characters Slack requires escaped. */
export function discordToSlackMrkdwn(text: string): string {
  let out = ''
  let last = 0
  for (const m of text.matchAll(MD_LINK_RE)) {
    out += formatSegment(text.slice(last, m.index))
    out += `<${m[2]}|${escapeSlack(m[1]).replace(/\|/g, '¦')}>`
    last = (m.index ?? 0) + m[0].length
  }
  return out + formatSegment(text.slice(last))
}

const VIEW_LINK_RE = /\n?┈+\n\[View on AIWatch\]\((https?:\/\/[^)\s]+)\)\s*$/

const OG_HINT: Partial<Record<AlertFeedEntry['kind'], string>> = {
  resolved: 'resolved',
  recovered: 'resolved',
  withdrawn: 'withdrawn',
  down: 'down',
  degraded: 'degraded',
}

/** The title line links to the is-down page and Slack unfurls it, which brings the page's OG card
 *  (the thumbnail the Slack /feed messages show). The `?e=` hint gives a recovery its own URL, so
 *  Slack does not reuse the outage card it cached (#539). */
export function toSlackPayload(entry: AlertFeedEntry): { text: string; unfurl_links?: true; attachments: unknown[] } {
  const view = entry.embed.description.match(VIEW_LINK_RE)
  const body = view ? entry.embed.description.slice(0, view.index) : entry.embed.description
  const title = escapeSlack(entry.embed.title)
  const hint = OG_HINT[entry.kind]
  const link = view ? (hint ? appendStatusHint(view[1], hint) : view[1]) : null
  return {
    text: link ? `*<${link}|${title}>*` : `*${title}*`,
    ...(link ? { unfurl_links: true as const } : {}),
    attachments: [
      {
        color: `#${entry.embed.color.toString(16).padStart(6, '0')}`,
        text: discordToSlackMrkdwn(body),
        mrkdwn_in: ['text'],
        footer: 'AIWatch',
        ts: Math.floor(Date.now() / 1000),
      },
    ],
  }
}

/** The cron fan-out's Slack poster: the status plus Slack's error string (status null on a network
 *  failure). A decrypted URL that is not a Slack webhook is never fetched. */
export async function postSlackAlert(fetchFn: typeof fetch, url: string, entry: AlertFeedEntry): Promise<{ status: number | null; body: string }> {
  if (!url.startsWith(SLACK_WEBHOOK_PREFIX)) return { status: 403, body: 'invalid_url' }
  try {
    const resp = await fetchFn(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(toSlackPayload(entry)),
    })
    return { status: resp.status, body: (await resp.text()).slice(0, 200) }
  } catch (err) {
    console.warn('[cron] slack subscriber POST failed:', err instanceof Error ? err.message : err)
    return { status: null, body: '' }
  }
}

// ── Delivery classification ──────────────────────────────────────────────────

// Measured 2026-10-02/03 against a real webhook (#1581 comment): an archived channel answers
// 404 `no_active_hooks`, not the documented 410 `channel_is_archived`, so the body decides.
const SLACK_GONE = new Set([
  'no_service',
  'no_active_hooks',
  'no_team',
  'team_disabled',
  'invalid_token',
  'channel_not_found',
  'channel_is_archived',
  'action_prohibited',
])

export function classifySlackDelivery(status: number | null, body: string): DeliveryOutcome {
  if (status !== null && status >= 200 && status < 300) return 'success'
  const error = body.trim()
  if (SLACK_GONE.has(error)) return 'prune'
  if (error === 'invalid_payload') return 'payload-error'
  return 'retry'
}
