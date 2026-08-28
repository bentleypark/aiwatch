// #1164 — provider-family group pages (/is-claude-down, /is-openai-down after the API pages moved
// to /is-claude-api-down, /is-openai-api-down). Mirrors is-down.test.ts's fetch-mocking pattern.

import { describe, it, expect, vi, afterEach } from 'vitest'
import handler from '../is-down-group'

function makeReq(family: string, extraParams?: Record<string, string>): Request {
  const params = new URLSearchParams({ family, ...extraParams })
  return new Request(`https://ai-watch.dev/api/is-down-group?${params.toString()}`, { method: 'GET' })
}

interface MockIncident {
  id: string
  title: string
  status: 'investigating' | 'identified' | 'monitoring' | 'resolved'
  startedAt: string
  resolvedAt?: string | null
  duration: string | null
}

function statusResponse(
  services: Array<{ id: string; name: string; status: string; incidents?: MockIncident[] }>,
  aiAnalysis?: Record<string, Array<{ incidentId: string; summary: string; estimatedRecovery: string }>>,
): Response {
  return new Response(
    JSON.stringify({ services, ...(aiAnalysis ? { aiAnalysis } : {}) }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  )
}

describe('is-down-group.ts', () => {
  let fetchMock: ReturnType<typeof vi.spyOn>

  afterEach(() => {
    fetchMock?.mockRestore()
  })

  it('404s for an unknown family', async () => {
    const res = await handler(makeReq('gemini'))
    expect(res.status).toBe(404)
  })

  // #1164 follow-up — the group page originally shipped with NO gtag.js/consent-init/cookie-banner
  // (the [data-ga] listener was a dead no-op), unlike every individual is-down page. Regression guard
  // for the fix: both shared modules must actually render, not just be imported.
  it('wires GA4 (consent-init) + the cookie consent banner, same as the individual is-down pages', async () => {
    fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(statusResponse([
      { id: 'claude', name: 'Claude API', status: 'operational' },
      { id: 'claudeai', name: 'claude.ai', status: 'operational' },
      { id: 'claudecode', name: 'Claude Code', status: 'operational' },
    ]))
    const res = await handler(makeReq('claude'))
    const html = await res.text()
    expect(html).toContain('googletagmanager.com/gtag/js')
    expect(html).toContain("gtag('consent','default'")
    expect(html).toContain('id="aiwatch-cookie-banner"')
    expect(html).toContain('data-aiwatch-cb="accept"')
  })

  // #1164 follow-up — the group page originally hardcoded the static site-wide og-intro.png for every
  // share, unlike the individual is-down pages' live status card. Regression guard: og:image must be
  // the dynamic worker endpoint, carrying the family name + CURRENT worst-of status (not a fixed image
  // that never reflects an outage) — plus a `v` cache-buster (#1103: a static og:image query string
  // behind a static og:url can make a social crawler unfurl with NO image at all, not just a stale one).
  it('uses the dynamic /api/og live-status card for og:image, reflecting the worst-of headline + cache-busted', async () => {
    fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(statusResponse([
      { id: 'openai', name: 'OpenAI API', status: 'operational' },
      { id: 'chatgpt', name: 'ChatGPT', status: 'down' },
      { id: 'codex', name: 'Codex', status: 'operational' },
    ]))
    const res = await handler(makeReq('openai'))
    const html = await res.text()
    expect(html).toContain('og:image" content="https://aiwatch-worker.p2c2kbf.workers.dev/api/og?service=OpenAI&amp;status=down&amp;v=')
    expect(html).not.toContain('og-intro.png')
  })

  it('renders operational when every family member is operational', async () => {
    fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(statusResponse([
      { id: 'claude', name: 'Claude API', status: 'operational' },
      { id: 'claudeai', name: 'claude.ai', status: 'operational' },
      { id: 'claudecode', name: 'Claude Code', status: 'operational' },
    ]))
    const res = await handler(makeReq('claude'))
    const html = await res.text()
    expect(res.status).toBe(200)
    expect(res.headers.get('Cache-Control')).toBe('public, s-maxage=60, stale-while-revalidate=300')
    expect(html).toContain('Is Anthropic (Claude) Down? Operational')
    expect(html).toContain('/is-claude-api-down')
    expect(html).toContain('/is-claude-ai-down')
    expect(html).toContain('/is-claude-code-down')
  })

  it('worst-of headline: one member down dominates the others being operational', async () => {
    fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(statusResponse([
      { id: 'openai', name: 'OpenAI API', status: 'operational' },
      { id: 'chatgpt', name: 'ChatGPT', status: 'down' },
      { id: 'codex', name: 'Codex', status: 'operational' },
    ]))
    const res = await handler(makeReq('openai'))
    const html = await res.text()
    expect(html).toContain('Is OpenAI Down? Down')
    expect(html).toContain('/is-openai-api-down')
    expect(html).toContain('/is-codex-down')
  })

  it('worst-of headline: degraded beats operational but loses to down', async () => {
    fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(statusResponse([
      { id: 'claude', name: 'Claude API', status: 'degraded' },
      { id: 'claudeai', name: 'claude.ai', status: 'operational' },
      { id: 'claudecode', name: 'Claude Code', status: 'operational' },
    ]))
    const res = await handler(makeReq('claude'))
    const html = await res.text()
    expect(html).toContain('Is Anthropic (Claude) Down? Degraded Performance')
  })

  // #1164 review — two real bugs were caught and fixed here: (1) the headline used to render a false
  // "🟢 Operational" when every member was unknown (STATUS_RANK tied 'unknown' with 'operational');
  // (2) the fallback page used to render an EMPTY member list on total fetch failure, losing every
  // outbound link exactly when they matter most. Both tests below assert the HEADLINE, not just that
  // the word "Unknown" appears somewhere — the old bugs would still pass a mere `.toContain('Unknown')`
  // check, since a lone member row could say "Unknown" while the headline still lied.
  it('returns 503 + no-store, headline reads Unknown (never fabricated), and every member link still works', async () => {
    fetchMock = vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new DOMException('aborted', 'AbortError'))
    const res = await handler(makeReq('claude'))
    const html = await res.text()
    expect(res.status).toBe(503)
    expect(res.headers.get('Cache-Control')).toMatch(/no-store/)
    expect(html).toContain('Is Anthropic (Claude) Down? Unknown')
    // the whole point of the group page — outbound links to every member — must survive a total
    // Worker outage, not just the confirmed-good case.
    expect(html).toContain('/is-claude-api-down')
    expect(html).toContain('/is-claude-ai-down')
    expect(html).toContain('/is-claude-code-down')
    // #1164 review — member rows must show real display names ("claude.ai", "Claude Code"), not the
    // raw worker ids ("claudeai", "claudecode"), even on a total fetch failure.
    expect(html).toContain('claude.ai')
    expect(html).toContain('Claude Code')
    expect(html).not.toContain('>claudeai<')
    expect(html).not.toContain('>claudecode<')
  })

  it('returns 503 + no-store when the Worker responds with a non-2xx status', async () => {
    fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('upstream error', { status: 502 }))
    const res = await handler(makeReq('openai'))
    const html = await res.text()
    expect(res.status).toBe(503)
    expect(res.headers.get('Cache-Control')).toMatch(/no-store/)
    expect(html).toContain('Is OpenAI Down? Unknown')
  })

  it('a member missing from the Worker response renders as unknown, not fabricated as operational', async () => {
    fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(statusResponse([
      { id: 'claude', name: 'Claude API', status: 'operational' },
      // claudeai / claudecode absent — e.g. a partial worker response
    ]))
    const res = await handler(makeReq('claude'))
    const html = await res.text()
    expect(res.status).toBe(200) // the fetch itself succeeded — a missing member is not a fetch failure
    expect(html).toContain('Unknown')
  })

  it('headline reads Unknown (not Operational) when EVERY member is missing from an otherwise-successful response', async () => {
    // The bug this guards: STATUS_RANK used to tie 'unknown' with 'operational' at rank 0, so the
    // reduce (seeded 'operational') never moved off it when every member came back unknown.
    fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(statusResponse([]))
    const res = await handler(makeReq('claude'))
    const html = await res.text()
    expect(res.status).toBe(200) // fetch succeeded — an empty/mismatched roster is not a fetch failure
    expect(html).toContain('Is Anthropic (Claude) Down? Unknown')
    expect(html).not.toContain('Is Anthropic (Claude) Down? Operational')
  })

  // #1233 — the defect this page was named for in the issue: on 2026-08-14, with status.claude.com
  // unreadable, it rendered "Degraded Performance" for all three Anthropic surfaces. The page could
  // already express `unknown` (#1164's STATUS_RANK / STATUS_EMOJI / STATUS_LABEL) — the VALUE never
  // arrived, because the worker published `degraded` + a flag this page never read. These cases pin the
  // value now that the worker sends it; the ones above only ever reach `unknown` via a MISSING member,
  // which is a different route into the same state and would not have caught a `normalizeStatus` that
  // dropped the new word.
  it('a member the worker reports as `unknown` renders Unknown — never Degraded Performance', async () => {
    fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(statusResponse([
      { id: 'claude', name: 'Claude API', status: 'unknown' },
      { id: 'claudeai', name: 'claude.ai', status: 'unknown' },
      { id: 'claudecode', name: 'Claude Code', status: 'unknown' },
    ]))
    const res = await handler(makeReq('claude'))
    const html = await res.text()
    expect(html).toContain('Is Anthropic (Claude) Down? Unknown')
    expect(html).not.toContain('Degraded Performance')
  })

  // #1233 round-3 review — the DESCRIPTION, not just the title. The two-valued form put `unknown` in the
  // else branch, so meta/og/twitter/JSON-LD and the visible headline all read "see which service IS
  // AFFECTED" under an "Unknown" title. Served 200 and cached, so that sentence is what crawlers carry.
  it('does not assert a confirmed outage in the description under an Unknown headline', async () => {
    fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(statusResponse([
      { id: 'claude', name: 'Claude API', status: 'unknown' },
      { id: 'claudeai', name: 'claude.ai', status: 'unknown' },
      { id: 'claudecode', name: 'Claude Code', status: 'unknown' },
    ]))
    const html = await (await handler(makeReq('claude'))).text()
    expect(html).not.toContain('service is affected and its live status')
    expect(html).toContain('could not read the official status source')
  })

  it('control: a real outage still says which service is affected', async () => {
    fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(statusResponse([
      { id: 'claude', name: 'Claude API', status: 'down' },
      { id: 'claudeai', name: 'claude.ai', status: 'operational' },
      { id: 'claudecode', name: 'Claude Code', status: 'operational' },
    ]))
    const html = await (await handler(makeReq('claude'))).text()
    expect(html).toContain('service is affected and its live status')
  })

  it('a CONFIRMED down member still outranks a worker-reported unknown sibling', async () => {
    fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(statusResponse([
      { id: 'claude', name: 'Claude API', status: 'down' },
      { id: 'claudeai', name: 'claude.ai', status: 'unknown' },
      { id: 'claudecode', name: 'Claude Code', status: 'operational' },
    ]))
    const res = await handler(makeReq('claude'))
    const html = await res.text()
    expect(html).toContain('Is Anthropic (Claude) Down? Down')
  })

  it('...and an unknown member is not masked by an operational sibling either', async () => {
    fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(statusResponse([
      { id: 'claude', name: 'Claude API', status: 'unknown' },
      { id: 'claudeai', name: 'claude.ai', status: 'operational' },
      { id: 'claudecode', name: 'Claude Code', status: 'operational' },
    ]))
    const res = await handler(makeReq('claude'))
    const html = await res.text()
    expect(html).toContain('Is Anthropic (Claude) Down? Unknown')
  })

  it('a CONFIRMED down member still wins over an unknown sibling (unknown does not mask a real outage)', async () => {
    fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(statusResponse([
      { id: 'claude', name: 'Claude API', status: 'down' },
      // claudeai / claudecode missing — unknown, must not outrank the confirmed 'down' above
    ]))
    const res = await handler(makeReq('claude'))
    const html = await res.text()
    expect(html).toContain('Is Anthropic (Claude) Down? Down')
  })
})

// #1194 — this page never got the #1063/#804 og:url pin the individual is-down pages (api/is-down.ts)
// and buildTweetForService got: og:url was ALWAYS the bare canonical, so a social platform's
// og:url-keyed card cache reused whatever it first fetched no matter how many real outages were
// shared afterward. Reproduced live 2026-08-02 via the operator's "Anthropic (Claude)" group tweet
// draft option (worker/src/alerts.ts buildGroupTweetDraft), which was ALSO never pinned. Both are
// fixed together — the worker now appends `?e=`/`&i=` to the group draft link, and this page now reads
// + reflects them.
describe('is-down-group.ts — og:url pin (#1063/#804 parity, group page)', () => {
  let fetchMock: ReturnType<typeof vi.spyOn>
  afterEach(() => { fetchMock?.mockRestore() })

  it('with no ?e=/&i=, og:url is the bare canonical (unpinned — unchanged legacy behavior)', async () => {
    fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(statusResponse([
      { id: 'claude', name: 'Claude API', status: 'operational' },
      { id: 'claudeai', name: 'claude.ai', status: 'operational' },
      { id: 'claudecode', name: 'Claude Code', status: 'operational' },
    ]))
    const html = await (await handler(makeReq('claude'))).text()
    expect(html).toContain('og:url" content="https://ai-watch.dev/is-claude-down">')
  })

  it('with ?e=degraded&i=<token>, og:url carries BOTH — a distinct, per-incident card identity', async () => {
    fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(statusResponse([
      { id: 'claude', name: 'Claude API', status: 'operational' }, // live status is IRRELEVANT once pinned
      { id: 'claudeai', name: 'claude.ai', status: 'operational' },
      { id: 'claudecode', name: 'Claude Code', status: 'operational' },
    ]))
    const html = await (await handler(makeReq('claude', { e: 'degraded', i: 'opus47' }))).text()
    expect(html).toContain('og:url" content="https://ai-watch.dev/is-claude-down?e=degraded&amp;i=opus47">')
    // The og:image reflects the PINNED status, not the live 'operational' data above.
    expect(html).toContain('og:image" content="https://aiwatch-worker.p2c2kbf.workers.dev/api/og?service=Anthropic+%28Claude%29&amp;status=degraded">')
    // og:title pins too — otherwise the card reads "Operational" over a "Degraded" image.
    expect(html).toContain('og:title" content="Is Anthropic (Claude) Down? Degraded Performance | AIWatch">')
    // The page <title> stays LIVE (unpinned) — only the social card pins.
    expect(html).toContain('<title>Is Anthropic (Claude) Down? Operational | AIWatch</title>')
  })

  it('a pinned share drops the 10-min cache-buster (the image must not move after the share moment)', async () => {
    fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(statusResponse([
      { id: 'openai', name: 'OpenAI API', status: 'operational' },
      { id: 'chatgpt', name: 'ChatGPT', status: 'operational' },
      { id: 'codex', name: 'Codex', status: 'operational' },
    ]))
    const html = await (await handler(makeReq('openai', { e: 'down', i: 'inc1' }))).text()
    expect(html).toContain('og:image" content="https://aiwatch-worker.p2c2kbf.workers.dev/api/og?service=OpenAI&amp;status=down">')
    expect(html).not.toContain('&amp;v=')
  })

  it('an unrecognized ?e= value is ignored (falls back to unpinned live behavior)', async () => {
    fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(statusResponse([
      { id: 'claude', name: 'Claude API', status: 'down' },
      { id: 'claudeai', name: 'claude.ai', status: 'operational' },
      { id: 'claudecode', name: 'Claude Code', status: 'operational' },
    ]))
    const html = await (await handler(makeReq('claude', { e: '__proto__' }))).text()
    expect(html).toContain('og:url" content="https://ai-watch.dev/is-claude-down">')
    expect(html).toContain('og:image" content="https://aiwatch-worker.p2c2kbf.workers.dev/api/og?service=Anthropic+%28Claude%29&amp;status=down&amp;v=')
  })

  it('?i= alone (no ?e=) still pins the og:url — an incident-token-only share is just as frozen', async () => {
    fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(statusResponse([
      { id: 'claude', name: 'Claude API', status: 'operational' },
      { id: 'claudeai', name: 'claude.ai', status: 'operational' },
      { id: 'claudecode', name: 'Claude Code', status: 'operational' },
    ]))
    const html = await (await handler(makeReq('claude', { i: 'opus47' }))).text()
    expect(html).toContain('og:url" content="https://ai-watch.dev/is-claude-down?i=opus47">')
    expect(html).not.toContain('&amp;v=')
  })
})

// #1164 round-3 — recent-incidents section added during the live design-review pass: merging a
// shared incident id across members, incidentId-scoped AI analysis matching (+ the 2h post-resolution
// window), ongoing-first sort, and the sibling-family "🔄 Alternative" recommendation. None of this had
// coverage before round 3's review — each test below pins the specific bug a naive
// simplification/regression would reintroduce (noted per case).
describe('is-down-group.ts — recent incidents (#1164 round-3)', () => {
  let fetchMock: ReturnType<typeof vi.spyOn>

  afterEach(() => {
    fetchMock?.mockRestore()
  })

  const NOW = Date.parse('2026-07-26T07:00:00Z')

  it('merges a shared incident id across two members into ONE row listing both', async () => {
    vi.useFakeTimers().setSystemTime(NOW)
    fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(statusResponse([
      { id: 'claude', name: 'Claude API', status: 'down', incidents: [
        { id: 'inc-shared', title: 'Elevated errors', status: 'investigating', startedAt: '2026-07-26T05:00:00Z', resolvedAt: null, duration: null },
      ] },
      { id: 'claudeai', name: 'claude.ai', status: 'down', incidents: [
        { id: 'inc-shared', title: 'Elevated errors', status: 'investigating', startedAt: '2026-07-26T05:00:00Z', resolvedAt: null, duration: null },
      ] },
      { id: 'claudecode', name: 'Claude Code', status: 'operational' },
    ]))
    const res = await handler(makeReq('claude'))
    const html = await res.text()
    vi.useRealTimers()
    expect((html.match(/class="incident-row"/g) ?? []).length).toBe(1)
    expect(html).toContain('<a href="/is-claude-api-down">Claude API</a>')
    expect(html).toContain('<a href="/is-claude-ai-down">claude.ai</a>')
  })

  it('does NOT merge two genuinely different incident ids — each renders its own row', async () => {
    vi.useFakeTimers().setSystemTime(NOW)
    fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(statusResponse([
      { id: 'claude', name: 'Claude API', status: 'down', incidents: [
        { id: 'inc-a', title: 'Elevated errors', status: 'investigating', startedAt: '2026-07-26T05:00:00Z', resolvedAt: null, duration: null },
      ] },
      { id: 'claudeai', name: 'claude.ai', status: 'down', incidents: [
        { id: 'inc-b', title: 'Login failures', status: 'investigating', startedAt: '2026-07-26T04:00:00Z', resolvedAt: null, duration: null },
      ] },
      { id: 'claudecode', name: 'Claude Code', status: 'operational' },
    ]))
    const res = await handler(makeReq('claude'))
    const html = await res.text()
    vi.useRealTimers()
    expect((html.match(/class="incident-row"/g) ?? []).length).toBe(2)
  })

  it('does NOT attach an AI analysis meant for a different, unrelated incident on the same service', async () => {
    vi.useFakeTimers().setSystemTime(NOW)
    fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(statusResponse(
      [{ id: 'claude', name: 'Claude API', status: 'down', incidents: [
        { id: 'inc-real', title: 'Elevated errors', status: 'investigating', startedAt: '2026-07-26T05:00:00Z', resolvedAt: null, duration: null },
      ] }],
      { claude: [{ incidentId: 'inc-unrelated', summary: 'Wrong incident', estimatedRecovery: '1h' }] },
    ))
    const res = await handler(makeReq('claude'))
    const html = await res.text()
    vi.useRealTimers()
    expect(html).not.toContain('class="incident-ai">')
    expect(html).not.toContain('Wrong incident')
  })

  // #1164 round-3 review (silent-failure-hunter + code-reviewer, independently) — the analysis for a
  // shared incident can be filed under ANY affected member's key, not necessarily the first one in
  // family.members order. A per-member-scoped lookup during the merge silently dropped it whenever the
  // analysis lived under a later member. Regression test: 'claude' is first in family.members, but the
  // analysis is filed under 'claudeai' only — it must still attach to the merged row.
  it('finds the AI analysis even when filed under a NON-first member of a merged incident', async () => {
    vi.useFakeTimers().setSystemTime(NOW)
    fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(statusResponse(
      [
        { id: 'claude', name: 'Claude API', status: 'down', incidents: [
          { id: 'inc-shared', title: 'Elevated errors', status: 'investigating', startedAt: '2026-07-26T05:00:00Z', resolvedAt: null, duration: null },
        ] },
        { id: 'claudeai', name: 'claude.ai', status: 'down', incidents: [
          { id: 'inc-shared', title: 'Elevated errors', status: 'investigating', startedAt: '2026-07-26T05:00:00Z', resolvedAt: null, duration: null },
        ] },
      ],
      // deliberately NOT under 'claude' (family.members[0]) — only under 'claudeai'
      { claudeai: [{ incidentId: 'inc-shared', summary: 'Filed under the second member', estimatedRecovery: '1h' }] },
    ))
    const res = await handler(makeReq('claude'))
    const html = await res.text()
    vi.useRealTimers()
    expect(html).toContain('Filed under the second member')
  })

  it('shows a RESOLVED incident\'s analysis as "Post-Incident Analysis" (no ETA) within the 2h window', async () => {
    vi.useFakeTimers().setSystemTime(NOW)
    fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(statusResponse(
      [{ id: 'claude', name: 'Claude API', status: 'operational', incidents: [
        { id: 'inc-recent', title: 'Brief spike', status: 'resolved', startedAt: '2026-07-26T06:00:00Z', resolvedAt: '2026-07-26T06:30:00Z', duration: '30m' },
      ] }],
      { claude: [{ incidentId: 'inc-recent', summary: 'Root cause explained', estimatedRecovery: '30m' }] },
    ))
    const res = await handler(makeReq('claude'))
    const html = await res.text()
    vi.useRealTimers()
    expect(html).toContain('Post-Incident Analysis')
    expect(html).toContain('Root cause explained')
    expect(html).not.toContain('<p class="incident-ai-eta">')
  })

  it('hides a RESOLVED incident\'s analysis once past the 2h window, but still renders the row', async () => {
    vi.useFakeTimers().setSystemTime(NOW)
    fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(statusResponse(
      [{ id: 'claude', name: 'Claude API', status: 'operational', incidents: [
        { id: 'inc-old', title: 'Old incident', status: 'resolved', startedAt: '2026-07-24T09:00:00Z', resolvedAt: '2026-07-24T10:30:00Z', duration: '1h 30m' },
      ] }],
      { claude: [{ incidentId: 'inc-old', summary: 'Stale analysis', estimatedRecovery: '15m' }] },
    ))
    const res = await handler(makeReq('claude'))
    const html = await res.text()
    vi.useRealTimers()
    expect(html).toContain('Old incident')
    expect(html).toContain('resolved after 1h 30m')
    expect(html).not.toContain('class="incident-ai">')
    expect(html).not.toContain('Stale analysis')
  })

  it('never shows analysis for a resolved incident with no resolvedAt (fails closed, not open)', async () => {
    vi.useFakeTimers().setSystemTime(NOW)
    fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(statusResponse(
      [{ id: 'claude', name: 'Claude API', status: 'operational', incidents: [
        { id: 'inc-no-date', title: 'Unclear resolution time', status: 'resolved', startedAt: '2026-07-26T05:00:00Z', resolvedAt: null, duration: null },
      ] }],
      { claude: [{ incidentId: 'inc-no-date', summary: 'Should never render', estimatedRecovery: '15m' }] },
    ))
    const res = await handler(makeReq('claude'))
    const html = await res.text()
    vi.useRealTimers()
    expect(html).not.toContain('class="incident-ai">')
    expect(html).not.toContain('Should never render')
  })

  it('sorts an ONGOING incident above a more-recently-resolved one, regardless of startedAt', async () => {
    vi.useFakeTimers().setSystemTime(NOW)
    fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(statusResponse([
      { id: 'claude', name: 'Claude API', status: 'operational', incidents: [
        { id: 'inc-resolved-recent', title: 'Just resolved', status: 'resolved', startedAt: '2026-07-26T06:00:00Z', resolvedAt: '2026-07-26T06:30:00Z', duration: '30m' },
      ] },
      { id: 'claudecode', name: 'Claude Code', status: 'degraded', incidents: [
        { id: 'inc-ongoing-old', title: 'Still ongoing', status: 'monitoring', startedAt: '2026-07-20T00:00:00Z', resolvedAt: null, duration: null },
      ] },
    ]))
    const res = await handler(makeReq('claude'))
    const html = await res.text()
    vi.useRealTimers()
    expect(html.indexOf('Still ongoing')).toBeLessThan(html.indexOf('Just resolved'))
  })

  // #1164 round-3 review (silent-failure-hunter) — `new Date(inc.startedAt).getTime()` is NaN for a
  // missing/malformed date, and the old bare `NaN < cutoff` comparison is always false, so a garbage
  // date used to fail OPEN (never filtered, kept in the list forever) instead of failing safe.
  it('excludes an incident with a malformed/missing startedAt instead of keeping it forever', async () => {
    vi.useFakeTimers().setSystemTime(NOW)
    fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(statusResponse([
      { id: 'claude', name: 'Claude API', status: 'operational', incidents: [
        { id: 'inc-bad-date', title: 'Should be dropped', status: 'resolved', startedAt: 'not-a-date', resolvedAt: null, duration: null },
      ] },
    ]))
    const res = await handler(makeReq('claude'))
    const html = await res.text()
    vi.useRealTimers()
    expect(html).not.toContain('Should be dropped')
    expect(html).toContain('No incidents reported')
  })

  it('recommends a healthy sibling family inside an ongoing incident\'s AI card', async () => {
    vi.useFakeTimers().setSystemTime(NOW)
    fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(statusResponse(
      [
        { id: 'claude', name: 'Claude API', status: 'down', incidents: [
          { id: 'inc-x', title: 'Elevated errors', status: 'investigating', startedAt: '2026-07-26T05:00:00Z', resolvedAt: null, duration: null },
        ] },
        { id: 'openai', name: 'OpenAI API', status: 'operational' },
        { id: 'chatgpt', name: 'ChatGPT', status: 'operational' },
        { id: 'codex', name: 'Codex', status: 'operational' },
      ],
      { claude: [{ incidentId: 'inc-x', summary: 'Explains the outage', estimatedRecovery: '1h' }] },
    ))
    const res = await handler(makeReq('claude'))
    const html = await res.text()
    vi.useRealTimers()
    expect(html).toContain('incident-ai-alt')
    expect(html).toContain('🔄 Alternative')
    expect(html).toContain('href="/is-openai-down"')
  })

  it('does NOT recommend a sibling family that is itself degraded/down', async () => {
    vi.useFakeTimers().setSystemTime(NOW)
    fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(statusResponse(
      [
        { id: 'claude', name: 'Claude API', status: 'down', incidents: [
          { id: 'inc-x', title: 'Elevated errors', status: 'investigating', startedAt: '2026-07-26T05:00:00Z', resolvedAt: null, duration: null },
        ] },
        { id: 'openai', name: 'OpenAI API', status: 'operational' },
        { id: 'chatgpt', name: 'ChatGPT', status: 'down' },
        { id: 'codex', name: 'Codex', status: 'operational' },
      ],
      { claude: [{ incidentId: 'inc-x', summary: 'Explains the outage', estimatedRecovery: '1h' }] },
    ))
    const res = await handler(makeReq('claude'))
    const html = await res.text()
    vi.useRealTimers()
    expect(html).not.toContain('🔄 Alternative')
  })

  it('does NOT recommend an alternative on a RESOLVED incident\'s card, even with a healthy sibling', async () => {
    vi.useFakeTimers().setSystemTime(NOW)
    fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(statusResponse(
      [
        { id: 'claude', name: 'Claude API', status: 'operational', incidents: [
          { id: 'inc-resolved', title: 'Brief spike', status: 'resolved', startedAt: '2026-07-26T06:00:00Z', resolvedAt: '2026-07-26T06:30:00Z', duration: '30m' },
        ] },
        { id: 'openai', name: 'OpenAI API', status: 'operational' },
        { id: 'chatgpt', name: 'ChatGPT', status: 'operational' },
        { id: 'codex', name: 'Codex', status: 'operational' },
      ],
      { claude: [{ incidentId: 'inc-resolved', summary: 'Root cause explained', estimatedRecovery: '30m' }] },
    ))
    const res = await handler(makeReq('claude'))
    const html = await res.text()
    vi.useRealTimers()
    expect(html).toContain('Post-Incident Analysis')
    expect(html).not.toContain('🔄 Alternative')
  })

  it('shows "No incidents reported" (not an empty section) when the family has none in the window', async () => {
    fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(statusResponse([
      { id: 'claude', name: 'Claude API', status: 'operational' },
      { id: 'claudeai', name: 'claude.ai', status: 'operational' },
      { id: 'claudecode', name: 'Claude Code', status: 'operational' },
    ]))
    const res = await handler(makeReq('claude'))
    const html = await res.text()
    expect(html).toContain('No incidents reported for any Anthropic (Claude) service')
  })
})

describe('outage-audience beacon (#842-B / #1193)', () => {
  let fetchMock: ReturnType<typeof vi.spyOn>
  afterEach(() => {
    fetchMock?.mockRestore()
  })

  // The operator Reddit block hands out THIS page's URL for a family-wide incident, so a group page
  // that posts no pageview leaves every visitor arriving on a family link uncounted. `svc` must be a real service id — parsePageviewBody validates against SERVICES and
  // drops anything else, which would look identical to no traffic. That every member id is valid is
  // pinned in api/_is-down/__tests__/family-groups.test.ts.
  it('posts a pageview naming a family member, flagged inactive when all are healthy', async () => {
    fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(statusResponse([
      { id: 'claude', name: 'Claude API', status: 'operational' },
      { id: 'claudeai', name: 'claude.ai', status: 'operational' },
      { id: 'claudecode', name: 'Claude Code', status: 'operational' },
    ]))
    const html = await (await handler(makeReq('claude'))).text()
    expect(html).toContain('/api/pageview')
    expect(html).toContain('svc: "claude"')
    expect(html).toContain('active: false')
    // #1280 — and it must say it is the GROUP. `svc: "claude"` above is a member id, not this page's
    // identity: the per-service page at /is-claude-api-down posts the very same id. The surface is the
    // only thing separating them, so asserting the id without it would pin a value that means two
    // different screens.
    expect(html).toContain('surface: "group"')
    expect(html).not.toContain('surface: "service"')
  })

  it('flags the view active AND names the member that is actually down', async () => {
    // The flag separates outage-moment reach from ambient traffic, and worst-of is what the rest of
    // the page headlines with — a beacon reading only the first member would call a claude.ai-only
    // outage quiet. The svc must move with it: recordOutageView stores (source, active-flag, svcId)
    // as one row, so an active flag paired with a member that was operational at render time asserts
    // an outage view of a service that had no outage. That row is permanent and unbackfillable.
    fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(statusResponse([
      { id: 'claude', name: 'Claude API', status: 'operational' },
      { id: 'claudeai', name: 'claude.ai', status: 'down' },
      { id: 'claudecode', name: 'Claude Code', status: 'operational' },
    ]))
    const html = await (await handler(makeReq('claude'))).text()
    expect(html).toContain('active: true')
    expect(html).toContain('svc: "claudeai"')
    expect(html).not.toContain('svc: "claude"')
  })

  it('attributes to the worst-of member, not merely to any non-operational one', async () => {
    // down outranks degraded (STATUS_RANK), and the headline says "Down" — so the row must name the
    // down member. Naming the degraded one would pair a `down` headline with a service that was only
    // degraded.
    fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(statusResponse([
      { id: 'claude', name: 'Claude API', status: 'degraded' },
      { id: 'claudeai', name: 'claude.ai', status: 'operational' },
      { id: 'claudecode', name: 'Claude Code', status: 'down' },
    ]))
    const html = await (await handler(makeReq('claude'))).text()
    expect(html).toContain('active: true')
    expect(html).toContain('svc: "claudecode"')
  })

  it('survives the CSP hash pass — the beacon script is not stripped or unhashed', async () => {
    // The page hashes its own inline scripts; an added script that never made it into the policy
    // would render but be blocked in a browser, which no HTML assertion above would notice.
    fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(statusResponse([
      { id: 'claude', name: 'Claude API', status: 'operational' },
      { id: 'claudeai', name: 'claude.ai', status: 'operational' },
      { id: 'claudecode', name: 'Claude Code', status: 'operational' },
    ]))
    const res = await handler(makeReq('claude'))
    const html = await res.text()
    const csp = res.headers.get('content-security-policy') ?? ''
    const inlineScripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1])
    const beaconScript = inlineScripts.find((s) => s.includes('/api/pageview'))
    expect(beaconScript, 'no inline script carries the beacon').toBeTruthy()
    // #1243 — the executed harnesses below each parse their own slice; this covers the beacon region and
    // the text between slices. An unbalanced `})` anywhere in the block used to render fine, hash fine,
    // and ship a page whose copy handler, GA4 hook and audience beacon were all dead. `new Function`
    // parses without running, so no beacon fires.
    expect(() => new Function(beaconScript!), 'the page inline script does not parse').not.toThrow()
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(beaconScript!))
    const b64 = btoa(String.fromCharCode(...new Uint8Array(digest)))
    expect(csp, 'the beacon script is not hashed into the page CSP').toContain(`sha256-${b64}`)
  })
})

// #1243 — the page's PUBLIC share bar shared the BARE canonical (URL interpolated into the tweet text,
// no `?e=`/`&i=` pin, no UTM), so X — which keys its unfurl cache on `og:url` — re-served the card it
// crawled while the family was operational. #1194 above fixed this file's pin-CONSUMING side and the
// operator draft, but not the bar, so the page parsed a pin it never produced. Reproduced live
// 2026-08-19 during Anthropic incident `q7txxvbsftgq`. These cases pin the EMITTING side.
describe('is-down-group.ts — public share bar carries the OG pin + UTM (#1243)', () => {
  let fetchMock: ReturnType<typeof vi.spyOn>
  afterEach(() => { fetchMock?.mockRestore() })

  const ongoing: MockIncident = {
    id: 'q7txxvbsftgq', title: 'Degraded performance for multiple models',
    status: 'investigating', startedAt: new Date(Date.now() - 3_600_000).toISOString(), duration: null,
  }

  function degradedFamily(incidents: MockIncident[] = [ongoing]) {
    return statusResponse([
      { id: 'claude', name: 'Claude API', status: 'degraded', incidents },
      { id: 'claudeai', name: 'claude.ai', status: 'degraded', incidents },
      { id: 'claudecode', name: 'Claude Code', status: 'operational' },
    ])
  }

  it('X share URL carries the status pin, the x UTM and the active incident token', async () => {
    fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(degradedFamily())
    const html = await (await handler(makeReq('claude'))).text()
    const shared = 'https://ai-watch.dev/is-claude-down?e=degraded'
      + '&utm_source=x&utm_medium=social&utm_campaign=outage&i=q7txxvbsftgq'
    expect(html).toContain(`&amp;url=${encodeURIComponent(shared)}"`)
  })

  it('does NOT share the bare canonical during an outage — the defect this pins', async () => {
    fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(degradedFamily())
    const html = await (await handler(makeReq('claude'))).text()
    // The old bar interpolated the unpinned URL into the tweet TEXT, where it renders as the shared
    // link. Both `text=` and `url=` are encodeURIComponent'd, so match that form.
    expect(html).not.toContain(encodeURIComponent('Live status → https://ai-watch.dev/is-claude-down'))
    expect(html).not.toContain(`&amp;url=${encodeURIComponent('https://ai-watch.dev/is-claude-down')}"`)
  })

  it('copy-link shares the same pin under its own UTM (copy-link/share), not the bare URL', async () => {
    fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(degradedFamily())
    const html = await (await handler(makeReq('claude'))).text()
    expect(html).toContain('data-url="https://ai-watch.dev/is-claude-down?e=degraded'
      + '&amp;utm_source=copy-link&amp;utm_medium=share&amp;utm_campaign=outage&amp;i=q7txxvbsftgq"')
    expect(html).not.toContain('data-url="https://ai-watch.dev/is-claude-down"')
  })

  it('pins to the WORST-OF status, so one member down outranks another merely degraded', async () => {
    fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(statusResponse([
      { id: 'claude', name: 'Claude API', status: 'degraded', incidents: [ongoing] },
      { id: 'claudeai', name: 'claude.ai', status: 'down', incidents: [ongoing] },
      { id: 'claudecode', name: 'Claude Code', status: 'operational' },
    ]))
    const html = await (await handler(makeReq('claude'))).text()
    expect(html).toContain(encodeURIComponent('https://ai-watch.dev/is-claude-down?e=down'))
  })

  it('uses the ONGOING incident as the token, not a more-recently-resolved one', async () => {
    const resolvedLater: MockIncident = {
      id: 'resolved-newer', title: 'Elevated errors', status: 'resolved',
      startedAt: new Date(Date.now() - 1_800_000).toISOString(),
      resolvedAt: new Date(Date.now() - 600_000).toISOString(), duration: '20m',
    }
    fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(degradedFamily([resolvedLater, ongoing]))
    const html = await (await handler(makeReq('claude'))).text()
    expect(html).toContain(encodeURIComponent('&i=q7txxvbsftgq'))
    expect(html).not.toContain(encodeURIComponent('&i=resolved-newer'))
  })

  // The case above passes on `incidents[0]` alone, because the display sort already ranks ongoing
  // first — it pins the ORDER, not the predicate. This one varies the real input: a still-degraded
  // headline with nothing but resolved incidents. Picking one would hand a NEW outage the OLD
  // incident's card identity, which is the #804 collision inverted.
  it('emits NO &i= when every incident is resolved, even under a still-degraded headline', async () => {
    const resolvedOnly: MockIncident = {
      id: 'old-resolved-1', title: 'Elevated errors', status: 'resolved',
      startedAt: new Date(Date.now() - 7_200_000).toISOString(),
      resolvedAt: new Date(Date.now() - 3_600_000).toISOString(), duration: '1h',
    }
    fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(degradedFamily([resolvedOnly]))
    const html = await (await handler(makeReq('claude'))).text()
    expect(html).toContain(encodeURIComponent('https://ai-watch.dev/is-claude-down?e=degraded'))
    expect(html).not.toContain(encodeURIComponent('&i='))
  })

  // The token is taken from the RAW worker payload, before the 7-day display window prunes the
  // incident list — deriving it from the rendered list would drop the token for a long-running outage.
  it('still emits &i= for an ongoing incident older than the 7-day display window', async () => {
    const ancient: MockIncident = {
      id: 'long-running', title: 'Sustained degradation', status: 'monitoring',
      startedAt: new Date(Date.now() - 12 * 86_400_000).toISOString(), duration: null,
    }
    fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(degradedFamily([ancient]))
    const html = await (await handler(makeReq('claude'))).text()
    expect(html).toContain(encodeURIComponent('&i=long-running'))
    // The incident itself is correctly absent from the rendered list — only the token outlives the window.
    expect(html).toContain('No incidents reported')
  })

  // The INBOUND `?e=`/`?i=` a visitor arrived on pins THIS page's card; it must never leak into the
  // URL the page hands out, or a recovered outage's card re-propagates through every fresh share.
  it('ignores the inbound ?e=/&i= pin when building the outbound share URL', async () => {
    fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(statusResponse([
      { id: 'claude', name: 'Claude API', status: 'operational' },
      { id: 'claudeai', name: 'claude.ai', status: 'operational' },
      { id: 'claudecode', name: 'Claude Code', status: 'operational' },
    ]))
    const html = await (await handler(makeReq('claude', { e: 'down', i: 'stale-incident' }))).text()
    expect(html).toContain(`&amp;url=${encodeURIComponent('https://ai-watch.dev/is-claude-down')}"`)
    expect(html).not.toContain(encodeURIComponent('?e=down&utm_source=x'))
    expect(html).not.toContain(encodeURIComponent('&i=stale-incident'))
  })

  it('an operational family still shares the plain canonical — no pin, no UTM', async () => {
    fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(statusResponse([
      { id: 'claude', name: 'Claude API', status: 'operational' },
      { id: 'claudeai', name: 'claude.ai', status: 'operational' },
      { id: 'claudecode', name: 'Claude Code', status: 'operational' },
    ]))
    const html = await (await handler(makeReq('claude'))).text()
    // Anchored on the attribute's closing quote: the ENCODED bare URL is a prefix of the encoded
    // pinned one (`…is-claude-down` vs `…is-claude-down%3Fe%3D…`), so an unanchored `toContain` would
    // pass on a pinned URL too and this case would assert nothing.
    expect(html).toContain(`&amp;url=${encodeURIComponent('https://ai-watch.dev/is-claude-down')}"`)
    expect(html).toContain('data-url="https://ai-watch.dev/is-claude-down"')
    expect(html).not.toContain('utm_source=x')
  })

  it('an UNREADABLE family (unknown) also shares the plain canonical — unknown is not an outage pin', async () => {
    fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(statusResponse([
      { id: 'claude', name: 'Claude API', status: 'unknown' },
      { id: 'claudeai', name: 'claude.ai', status: 'operational' },
      { id: 'claudecode', name: 'Claude Code', status: 'operational' },
    ]))
    const html = await (await handler(makeReq('claude'))).text()
    expect(html).toContain(`&amp;url=${encodeURIComponent('https://ai-watch.dev/is-claude-down')}"`)
    expect(html).toContain('data-url="https://ai-watch.dev/is-claude-down"')
    // No pin of ANY value — not merely no `e=unknown`. `buildShareUrl` early-returns the canonical for
    // any status other than `down`/`degraded`, rather than inventing an outage hint.
    expect(html).not.toContain(encodeURIComponent('?e='))
    expect(html).not.toContain('utm_campaign=outage')
  })
})

// #1243 — the Copy-link button was broken in two independent ways, both reported from the live page
// on 2026-08-19: it copied only the URL (the individual pages copy a MESSAGE via `data-text`), and it
// never showed its '✓ Copied' confirmation because the handler read `e.currentTarget` inside the async
// clipboard callback, where the DOM has already reset it to null.
describe('is-down-group.ts — Copy link parity with the individual pages (#1243)', () => {
  let fetchMock: ReturnType<typeof vi.spyOn>
  afterEach(() => { fetchMock?.mockRestore() })

  const ongoing = {
    id: 'q7txxvbsftgq', title: 'Degraded performance for multiple models',
    status: 'investigating' as const, startedAt: new Date(Date.now() - 3_600_000).toISOString(), duration: null,
  }

  function degraded() {
    return statusResponse([
      { id: 'claude', name: 'Claude API', status: 'degraded', incidents: [ongoing] },
      { id: 'claudeai', name: 'claude.ai', status: 'degraded', incidents: [ongoing] },
      { id: 'claudecode', name: 'Claude Code', status: 'operational' },
    ])
  }

  it('copies a MESSAGE (data-text), not just the URL', async () => {
    fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(degraded())
    const html = await (await handler(makeReq('claude'))).text()
    expect(html).toContain('data-text="🟡 Is Anthropic (Claude) down? Degraded Performance. Live status →\n'
      + 'https://ai-watch.dev/is-claude-down?e=degraded'
      + '&amp;utm_source=copy-link&amp;utm_medium=share&amp;utm_campaign=outage&amp;i=q7txxvbsftgq"')
  })

  it('keeps data-url as the fallback the handler reads when data-text is absent', async () => {
    fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(degraded())
    const html = await (await handler(makeReq('claude'))).text()
    expect(html).toContain('data-url="https://ai-watch.dev/is-claude-down?e=degraded')
  })

  it('tags the X link for GA4 so the delegated listener has something to forward', async () => {
    fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(degraded())
    const html = await (await handler(makeReq('claude'))).text()
    expect(html).toContain('data-ga="share" data-ga-method="x" data-ga-item="Anthropic (Claude)"')
  })

  // The copy button must NOT carry data-ga: the delegated listener fires on click while the handler
  // fires on successful copy, so one copy would emit two `share` events — and the click-side one would
  // count a copy that failed.
  it('does not double-count copy: the copy button carries no data-ga', async () => {
    fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(degraded())
    const html = await (await handler(makeReq('claude'))).text()
    expect(html).not.toMatch(/data-action="copy-link"[^>]*data-ga=/)
    expect(html).not.toMatch(/data-ga=[^>]*data-action="copy-link"/)
  })
})

// #1243 — the cases above are all assertions about RENDERED TEXT, and every one of them was
// green while the Copy button was broken in a way a user hits on the second click. So the handler gets
// executed here instead: `vitest.config.js` already runs `api/**` under happy-dom, and slicing the
// handler out of the page script runs it without the audience beacon (a separate statement region of
// the same block) ever firing.
describe('is-down-group.ts — Copy link handler, executed (#1243)', () => {
  let fetchMock: ReturnType<typeof vi.spyOn>
  // Teardown belongs here, not at the end of each test body: an assertion that fails mid-test would
  // otherwise leak a throwing `gtag`, a spy `prompt` and a stubbed `clipboard` into the next case.
  const realClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
  afterEach(() => {
    fetchMock?.mockRestore()
    vi.useRealTimers()
    vi.unstubAllGlobals()
    if (realClipboard) Object.defineProperty(navigator, 'clipboard', realClipboard)
    else delete (navigator as { clipboard?: unknown }).clipboard
    document.body.innerHTML = ''
  })

  const ongoing = {
    id: 'q7txxvbsftgq', title: 'Degraded performance for multiple models',
    status: 'investigating' as const, startedAt: new Date(Date.now() - 3_600_000).toISOString(), duration: null,
  }

  /** Render the page, mount its share bar, and run ONLY the copy-link handler against it.
   *  `clipboard` shapes: a function → a working clipboard; `{}` → the API present but `writeText`
   *  missing (non-secure context); `null` → no clipboard object at all. */
  async function mountCopyHandler(clipboard: ((t: string) => Promise<void>) | Record<string, never> | null) {
    const writeText = typeof clipboard === 'function' ? clipboard : undefined
    fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(statusResponse([
      { id: 'claude', name: 'Claude API', status: 'degraded', incidents: [ongoing] },
      { id: 'claudeai', name: 'claude.ai', status: 'degraded', incidents: [ongoing] },
      { id: 'claudecode', name: 'Claude Code', status: 'operational' },
    ]))
    const html = await (await handler(makeReq('claude'))).text()
    const shareRow = html.match(/<div class="share-row">[\s\S]*?<\/div>/)
    const script = html.match(/var copyBtn = document\.querySelector[\s\S]*?\n\}\)\n/)
    expect(shareRow, 'share bar markup not found — the harness selector needs updating').toBeTruthy()
    expect(script, 'copy handler not found — the harness selector needs updating').toBeTruthy()
    // The slice is non-greedy, so a new `})`-terminated statement inserted between the declarations and
    // the click listener would cut it short — and the cases below would then fail with product-shaped
    // messages instead of naming the harness. Assert the slice reached the clipboard call.
    expect(script![0], 'the slice is not the whole handler').toContain('navigator.clipboard.writeText(text).then(')
    document.body.innerHTML = shareRow![0]
    const value = writeText ? { writeText } : clipboard === null ? undefined : clipboard
    Object.defineProperty(navigator, 'clipboard', { value, configurable: true })
    new Function(script![0])()
    return document.querySelector('[data-action="copy-link"]') as HTMLButtonElement
  }

  it('puts the MESSAGE on the clipboard and confirms, then restores the label', async () => {
    vi.useFakeTimers()
    const written: string[] = []
    const btn = await mountCopyHandler((t) => { written.push(t); return Promise.resolve() })
    const original = btn.textContent

    btn.click()
    await vi.advanceTimersByTimeAsync(0)
    expect(written).toHaveLength(1)
    expect(written[0]).toContain('Is Anthropic (Claude) down? Degraded Performance')
    expect(written[0]).toContain('?e=degraded')
    expect(written[0]).toContain('&i=q7txxvbsftgq')
    expect(btn.textContent).toBe('✓ Copied')

    await vi.advanceTimersByTimeAsync(2000)
    expect(btn.textContent).toBe(original)
  })

  // The regression the rendered-text assertions could not see: re-reading the label per click made
  // the second click capture the CONFIRMATION as the "original", sticking the button on it forever.
  it('a DOUBLE click inside the restore window still returns to the original label', async () => {
    vi.useFakeTimers()
    const btn = await mountCopyHandler(() => Promise.resolve())
    const original = btn.textContent

    btn.click()
    await vi.advanceTimersByTimeAsync(1000)
    btn.click()
    await vi.advanceTimersByTimeAsync(0)
    expect(btn.textContent).toBe('✓ Copied')

    // The FIRST click's timer must not restore the label under the second click: without the
    // clearTimeout the confirmation would vanish here, 1s into the second click's own window.
    await vi.advanceTimersByTimeAsync(1100)
    expect(btn.textContent).toBe('✓ Copied')

    await vi.advanceTimersByTimeAsync(1000)
    expect(btn.textContent).toBe(original)
  })

  it('shows a failure state on the button when the clipboard rejects — not just a prompt', async () => {
    vi.useFakeTimers()
    const prompt = vi.fn()
    vi.stubGlobal('prompt', prompt)
    const btn = await mountCopyHandler(() => Promise.reject(new Error('denied')))

    btn.click()
    await vi.advanceTimersByTimeAsync(0)
    expect(btn.textContent).toBe('⚠ Copy failed')
    expect(prompt).toHaveBeenCalledOnce()
  })

  // Pins the OUTCOME, not either mechanism: the try/catch around the analytics call and the
  // two-callback .then(done, fail) each guarantee it alone, so no test can separate them.
  it('a successful copy is never reported as a failure, even if the analytics call throws', async () => {
    vi.useFakeTimers()
    const prompt = vi.fn()
    vi.stubGlobal('prompt', prompt)
    vi.stubGlobal('gtag', () => { throw new Error('gtag blew up') })
    const btn = await mountCopyHandler(() => Promise.resolve())

    btn.click()
    await vi.advanceTimersByTimeAsync(0)
    expect(btn.textContent).toBe('✓ Copied')
    expect(prompt).not.toHaveBeenCalled()
  })

  it('fires exactly one share event, with the family as item_id', async () => {
    vi.useFakeTimers()
    const gtag = vi.fn()
    vi.stubGlobal('gtag', gtag)
    const btn = await mountCopyHandler(() => Promise.resolve())

    btn.click()
    await vi.advanceTimersByTimeAsync(0)
    expect(gtag).toHaveBeenCalledOnce()
    // Exact object, not objectContaining: `content_type` is the param this diff adds to the `share`
    // row in ga4-events.md on the rationale that the event keeps ONE shape across surfaces, so leaving
    // it free to drift would unpin the very claim the doc makes.
    expect(gtag).toHaveBeenCalledWith('event', 'share', {
      method: 'copy', content_type: 'is_x_down', item_id: 'Anthropic (Claude)',
    })
  })

  it('falls back to a prompt when the browser has no clipboard API at all', async () => {
    vi.useFakeTimers()
    const prompt = vi.fn()
    vi.stubGlobal('prompt', prompt)
    const btn = await mountCopyHandler(null)

    btn.click()
    await vi.advanceTimersByTimeAsync(0)
    expect(prompt).toHaveBeenCalledOnce()
    expect(btn.textContent).toBe('⚠ Copy failed')
  })

  // The guard checks the METHOD, not just the namespace — a non-secure context exposes `clipboard`
  // without `writeText`, and only the whole-object-missing case above was exercised.
  it('falls back when clipboard exists but writeText does not', async () => {
    vi.useFakeTimers()
    const prompt = vi.fn()
    vi.stubGlobal('prompt', prompt)
    const btn = await mountCopyHandler({})

    btn.click()
    await vi.advanceTimersByTimeAsync(0)
    expect(prompt).toHaveBeenCalledOnce()
    expect(btn.textContent).toBe('⚠ Copy failed')
  })

  // Both attributes are always rendered today, so this is a floor, not a live path: without it a
  // server-render bug would copy the literal string "undefined" AND count it as a successful share.
  it('refuses to copy — and does not report a share — when the button carries no URL', async () => {
    vi.useFakeTimers()
    const gtag = vi.fn()
    vi.stubGlobal('gtag', gtag)
    const written: string[] = []
    const btn = await mountCopyHandler((t) => { written.push(t); return Promise.resolve() })
    btn.removeAttribute('data-text')
    btn.removeAttribute('data-url')

    btn.click()
    await vi.advanceTimersByTimeAsync(0)
    expect(written).toHaveLength(0)
    expect(gtag).not.toHaveBeenCalled()
    expect(btn.textContent).toBe('⚠ Nothing to copy')
  })
})

// #1243 round 2 — the delegated [data-ga] listener was asserted as SOURCE TEXT, which turned out to be
// inverted: disabling it (`closest('[data-ga-DISABLED]')`) left every assertion green while every GA4
// event on the page silently stopped firing, and merely reordering two assignments went red. Executed
// instead, with the same slice-and-run harness as the copy handler above.
describe('is-down-group.ts — delegated [data-ga] listener, executed (#1243)', () => {
  let fetchMock: ReturnType<typeof vi.spyOn>
  // This listener binds to `document`, so clearing document.body does not remove it — without this the
  // next mount would leave two live listeners and "one click fires once" could not be asserted at all.
  let mounted: EventListener | null = null
  afterEach(() => {
    fetchMock?.mockRestore()
    vi.unstubAllGlobals()
    if (mounted) document.removeEventListener('click', mounted)
    mounted = null
    document.body.innerHTML = ''
  })

  async function mountListener() {
    fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(statusResponse([
      { id: 'claude', name: 'Claude API', status: 'degraded' },
      { id: 'claudeai', name: 'claude.ai', status: 'degraded' },
      { id: 'claudecode', name: 'Claude Code', status: 'operational' },
    ]))
    const html = await (await handler(makeReq('claude'))).text()
    const shareRow = html.match(/<div class="share-row">[\s\S]*?<\/div>/)
    const alertCta = html.match(/<p class="alert-cta">[\s\S]*?<\/p>/)
    const listener = html.match(/document\.addEventListener\('click', function\(e\)\{[\s\S]*?\n\}\)\n/)
    expect(shareRow, 'share bar markup not found — the harness selector needs updating').toBeTruthy()
    expect(alertCta, 'alerts CTA markup not found — the harness selector needs updating').toBeTruthy()
    expect(listener, 'delegated listener not found — the harness selector needs updating').toBeTruthy()
    expect(listener![0], 'the slice is not the whole listener').toContain("gtag('event', g.dataset.ga, p)")
    document.body.innerHTML = shareRow![0] + alertCta![0]
    // Capture the registered handler so afterEach can unbind it; `new Function` gives us no reference.
    const realAdd = document.addEventListener.bind(document)
    const spy = vi.spyOn(document, 'addEventListener').mockImplementation((type, fn, opts) => {
      if (type === 'click') mounted = fn as EventListener
      realAdd(type, fn as EventListener, opts)
    })
    new Function(listener![0])()
    spy.mockRestore()
    expect(mounted, 'the sliced listener did not register on document').toBeTruthy()
  }

  it('forwards the X link\'s method/content_type/item_id when clicked', async () => {
    const gtag = vi.fn()
    vi.stubGlobal('gtag', gtag)
    await mountListener()

    ;(document.querySelector('.share-x') as HTMLAnchorElement).click()
    expect(gtag).toHaveBeenCalledOnce()
    expect(gtag).toHaveBeenCalledWith('event', 'share', {
      method: 'x', content_type: 'is_x_down', item_id: 'Anthropic (Claude)',
    })
  })

  // `location` is the only param mapping that predates #1243, and it is what every non-share CTA on the
  // page reports through — the alerts CTA here, and the extension-install strip when that URL is set.
  it('forwards a non-share CTA\'s location', async () => {
    const gtag = vi.fn()
    vi.stubGlobal('gtag', gtag)
    await mountListener()

    ;(document.querySelector('[data-ga="click_cta_alerts"]') as HTMLAnchorElement).click()
    expect(gtag).toHaveBeenCalledWith('event', 'click_cta_alerts', { location: 'is_down_group_page' })
  })

  it('stays silent on the copy button, which reports from its own success path', async () => {
    const gtag = vi.fn()
    vi.stubGlobal('gtag', gtag)
    await mountListener()

    ;(document.querySelector('[data-action="copy-link"]') as HTMLButtonElement).click()
    expect(gtag).not.toHaveBeenCalled()
  })
})

// #1243 round 2 — the token half of the share URL, executed against the render. Two agents reproduced
// the same defect here independently: picking the FIRST unresolved incident in member-declaration order
// hands the card identity to the ordinary post-recovery `monitoring` tail of an older incident on an
// earlier-declared member (worker/src/services.ts keeps those on purpose), so two successive outages
// under one tail emit the same `&i=` — the #804 collision the token exists to prevent.
describe('is-down-group.ts — which incident becomes the card identity (#1243)', () => {
  let fetchMock: ReturnType<typeof vi.spyOn>
  afterEach(() => { fetchMock?.mockRestore() })

  const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString()

  it('picks the NEWEST unresolved incident, not the first member that has one', async () => {
    fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(statusResponse([
      // openai is declared first in FAMILY_GROUPS and carries a recovering `monitoring` tail…
      { id: 'openai', name: 'OpenAI API', status: 'operational', incidents: [
        { id: 'monitoring-tail', title: 'Elevated errors', status: 'monitoring', startedAt: iso(3 * 3_600_000), duration: null },
      ] },
      // …while the live outage the page is actually about is on codex.
      { id: 'codex', name: 'Codex', status: 'down', incidents: [
        { id: 'fresh-outage', title: 'API errors', status: 'investigating', startedAt: iso(10 * 60_000), duration: null },
      ] },
      { id: 'chatgpt', name: 'ChatGPT', status: 'operational' },
    ]))
    const html = await (await handler(makeReq('openai'))).text()
    expect(html).toContain(encodeURIComponent('&i=fresh-outage'))
    expect(html).not.toContain(encodeURIComponent('&i=monitoring-tail'))
  })

  it('an unparseable startedAt never wins the rank', async () => {
    fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(statusResponse([
      { id: 'claude', name: 'Claude API', status: 'degraded', incidents: [
        { id: 'garbage-date', title: 'Malformed', status: 'investigating', startedAt: 'not-a-date', duration: null },
        { id: 'real-outage', title: 'Degraded performance', status: 'investigating', startedAt: iso(20 * 60_000), duration: null },
      ] },
      { id: 'claudeai', name: 'claude.ai', status: 'operational' },
      { id: 'claudecode', name: 'Claude Code', status: 'operational' },
    ]))
    const html = await (await handler(makeReq('claude'))).text()
    expect(html).toContain(encodeURIComponent('&i=real-outage'))
    expect(html).not.toContain(encodeURIComponent('&i=garbage-date'))
  })

  // The case above always supplies a well-dated sibling, so it cannot see the FIRST-candidate path: a
  // seed that accepts anything lets a NaN-dated incident become the token, and the display filter then
  // drops that same incident — a card identity naming something the page refuses to show.
  it('emits NO &i= when the only unresolved incident has an unparseable date', async () => {
    fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(statusResponse([
      { id: 'claude', name: 'Claude API', status: 'degraded', incidents: [
        { id: 'garbage-only', title: 'Malformed', status: 'investigating', startedAt: 'not-a-date', duration: null },
      ] },
      { id: 'claudeai', name: 'claude.ai', status: 'operational' },
      { id: 'claudecode', name: 'Claude Code', status: 'operational' },
    ]))
    const html = await (await handler(makeReq('claude'))).text()
    expect(html).toContain(encodeURIComponent('?e=degraded'))
    expect(html).not.toContain(encodeURIComponent('&i='))
    // Confirms the two paths agree: the incident the token declined is also absent from the page.
    expect(html).toContain('No incidents reported')
  })

  // The inbound-pin case in the block above uses an OPERATIONAL family, where buildShareUrl early-returns
  // before it ever reads a token — so its `&i=stale` negative cannot fail on that input. This is the
  // path that matters: a visitor arrives on a stale pin while the family is degraded for a NEW reason.
  it('a stale inbound ?i= never becomes the outbound token during a new outage', async () => {
    fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(statusResponse([
      { id: 'claude', name: 'Claude API', status: 'degraded', incidents: [
        { id: 'q7txxvbsftgq', title: 'Degraded performance', status: 'investigating', startedAt: iso(3_600_000), duration: null },
      ] },
      { id: 'claudeai', name: 'claude.ai', status: 'operational' },
      { id: 'claudecode', name: 'Claude Code', status: 'operational' },
    ]))
    const html = await (await handler(makeReq('claude', { e: 'down', i: 'stale-incident' }))).text()
    expect(html).toContain(encodeURIComponent('&i=q7txxvbsftgq'))
    expect(html).not.toContain(encodeURIComponent('&i=stale-incident'))
    // The status pin follows the LIVE headline too, not the inbound hint.
    expect(html).toContain(encodeURIComponent('?e=degraded'))
    expect(html).not.toContain(encodeURIComponent('?e=down&utm_source=x'))
  })
})

// #1243 round 3 — three surviving mutations from the round-2 suite, each closed by executing the path
// rather than asserting the rendered text that describes it.
describe('is-down-group.ts — share paths the rendered assertions could not reach (#1243)', () => {
  let fetchMock: ReturnType<typeof vi.spyOn>
  afterEach(() => {
    fetchMock?.mockRestore()
    vi.useRealTimers()
    vi.unstubAllGlobals()
    document.body.innerHTML = ''
  })

  const ongoing = {
    id: 'q7txxvbsftgq', title: 'Degraded performance for multiple models',
    status: 'investigating' as const, startedAt: new Date(Date.now() - 3_600_000).toISOString(), duration: null,
  }

  function degradedFamily() {
    return statusResponse([
      { id: 'claude', name: 'Claude API', status: 'degraded', incidents: [ongoing] },
      { id: 'claudeai', name: 'claude.ai', status: 'degraded', incidents: [ongoing] },
      { id: 'claudecode', name: 'Claude Code', status: 'operational' },
    ])
  }

  // The X intent takes two params and only `url=` was ever asserted, so shipping an empty tweet body
  // stayed green.
  it('sends BOTH intent params — a share with an empty tweet body is not a share', async () => {
    fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(degradedFamily())
    const html = await (await handler(makeReq('claude'))).text()
    const text = encodeURIComponent('🟡 Is Anthropic (Claude) down? Degraded Performance. Live status →')
    expect(html).toContain(`tweet?text=${text}&amp;url=`)
  })

  // The handler reads `data-text || data-url`, but every executed case either has both or neither, so
  // dropping the fallback survived. Removing ONLY data-text exercises it.
  it('falls back to data-url when only data-text is missing', async () => {
    fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(degradedFamily())
    const html = await (await handler(makeReq('claude'))).text()
    const shareRow = html.match(/<div class="share-row">[\s\S]*?<\/div>/)
    const script = html.match(/var copyBtn = document\.querySelector[\s\S]*?\n\}\)\n/)
    expect(shareRow, 'share bar markup not found — the harness selector needs updating').toBeTruthy()
    expect(script, 'copy handler not found — the harness selector needs updating').toBeTruthy()
    document.body.innerHTML = shareRow![0]
    const btn = document.querySelector('[data-action="copy-link"]') as HTMLButtonElement
    const expected = btn.dataset.url
    btn.removeAttribute('data-text')
    const written: string[] = []
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: (t: string) => { written.push(t); return Promise.resolve() } }, configurable: true,
    })
    new Function(script![0])()

    btn.click()
    await Promise.resolve()
    expect(written).toEqual([expected])
    expect(expected).toContain('?e=degraded')
  })
})
