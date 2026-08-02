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

// <NEW> — this page never got the #1063/#804 og:url pin the individual is-down pages (api/is-down.ts)
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
