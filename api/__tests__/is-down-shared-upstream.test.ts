// #1991 — the "Likely Shared Cause" card on the single-service is-down pages, driven end to end: the full
// payload goes through the worker's real view (`asWorkerView` → buildStatusView → sharedUpstreamGroups),
// then the Edge handler renders it.

import { describe, it, expect, afterEach, vi } from 'vitest'
import isDown from '../is-down'
import isDownGroup from '../is-down-group'
import { spyFetchWithEmptyReportFeed } from './fetch-stub'
import { buildSharedUpstreamNotes, type SharedUpstreamGroupLike } from '../_is-down/shared-upstream-note'
import { buildUpstreamNote } from '../_is-down/upstream-note'
import { renderSharedUpstreamNotes } from '../_is-down/html-template'

const at = new Date(Date.now() - 30 * 60_000).toISOString()
const M365 = 'Elevated errors affecting the Microsoft 365 connector'
const svc = (id: string, name: string, provider: string, category: string, title: string | null) => ({
  id, name, provider, category, status: title ? 'degraded' : 'operational', latency: null, uptime30d: 99.5,
  lastChecked: at, aiwatchScore: 80, scoreConfidence: 'high',
  incidents: title ? [{ id: `${id}-1`, title, status: 'identified', impact: 'minor', startedAt: at, duration: null, timeline: [{ stage: 'identified', text: 'We are investigating.', at }] }] : [],
})
const payload = (chatgptTitle: string | null) => new Response(JSON.stringify({
  services: [
    svc('claude', 'Claude API', 'Anthropic', 'api', null),
    svc('claudeai', 'claude.ai', 'Anthropic', 'app', 'Microsoft 365 connector errors'),
    svc('claudecode', 'Claude Code', 'Anthropic', 'agent', null),
    svc('chatgpt', 'ChatGPT', 'OpenAI', 'app', chatgptTitle),
    svc('openai', 'OpenAI API', 'OpenAI', 'api', null),
  ],
  lastUpdated: at, cached: true,
}), { status: 200, headers: { 'Content-Type': 'application/json' } })

let fetchMock: ReturnType<typeof vi.spyOn> | undefined
afterEach(() => { fetchMock?.mockRestore() })

const page = async (render: () => Promise<Response>, chatgptTitle: string | null) => {
  fetchMock = spyFetchWithEmptyReportFeed().mockResolvedValueOnce(payload(chatgptTitle))
  return (await render()).text()
}
const single = (slug: string) => () => isDown(new Request(`https://ai-watch.dev/api/is-down?slug=${slug}`))
const family = (key: string) => () => isDownGroup(new Request(`https://ai-watch.dev/api/is-down-group?family=${key}`))
const card = (html: string) => html.slice(html.indexOf('data-shared-upstream'), html.indexOf('Check Microsoft 365 status'))

describe('#1991 is-down — Likely Shared Cause card', () => {
  it("quotes this page's incident, then the other provider's incident as a row", async () => {
    const html = card(await page(single('chatgpt'), M365))
    expect(html).toContain(`ChatGPT&rsquo;s incident &ldquo;${M365}&rdquo; mentions Microsoft 365, and so does an open incident from:`)
    expect(html).toContain('&ldquo;Microsoft 365 connector errors&rdquo;')
    expect(html).toContain('href="/is-claude-ai-down"')
    expect(html).toContain('data-ga="shared_cause_link"')
    expect(html).not.toContain('data-ga="upstream_link"')
  })

  it("links the third party's status page", async () => {
    expect(await page(single('chatgpt'), M365)).toContain('href="https://status.cloud.microsoft/" target="_blank" rel="noopener noreferrer" data-ga="shared_cause_link" data-ga-loc="is_down_page" data-ga-from="chatgpt" data-ga-to="microsoft365" data-ga-dest="external">Check Microsoft 365 status')
  })

  it('a family page shows no card, even when one of its members is in the group', async () => {
    expect(await page(family('claude'), M365)).not.toContain('data-shared-upstream')
    expect(await page(family('openai'), M365)).not.toContain('data-shared-upstream')
  })

  it('no card when only one provider names it, or on a page whose service is not in the group', async () => {
    expect(await page(single('chatgpt'), 'Elevated errors on GPT-5')).not.toContain('data-shared-upstream')
    expect(await page(single('openai-api'), M365)).not.toContain('data-shared-upstream')
  })
})

describe('#1991 buildSharedUpstreamNotes', () => {
  const svcRow = (id: string, name: string, provider = id) => ({ id, name, provider, status: 'degraded', incidentTitle: `${name} errors due to GitHub`, startedAt: at })
  const github: SharedUpstreamGroupLike = {
    thirdParty: { key: 'github', name: 'GitHub', statusUrl: 'https://www.githubstatus.com/' },
    services: [svcRow('chatgpt', 'ChatGPT'), svcRow('cursor', 'Cursor'), svcRow('bedrock', 'Amazon Bedrock')],
  }

  it('a worker without the key gives no card', () => {
    expect(buildSharedUpstreamNotes(undefined, 'chatgpt', null)).toEqual([])
  })

  it('a peer with no is-down page gets a row without a link', () => {
    const [note] = buildSharedUpstreamNotes([github], 'chatgpt', null)
    expect(note.incidentTitle).toBe('ChatGPT errors due to GitHub')
    expect(note.peers.map((p) => [p.id, p.href])).toEqual([['cursor', '/is-cursor-down'], ['bedrock', null]])
  })

  it("one row per other provider, named by that provider's own service, never this page's provider", () => {
    const g: SharedUpstreamGroupLike = { ...github, services: [svcRow('claudeai', 'claude.ai', 'Anthropic'), svcRow('claudecode', 'Claude Code', 'Anthropic'), svcRow('chatgpt', 'ChatGPT', 'OpenAI'), svcRow('cursor', 'Cursor', 'Anysphere')] }
    expect(buildSharedUpstreamNotes([g], 'claudeai', null)[0].peers.map((p) => p.id)).toEqual(['chatgpt', 'cursor'])
    expect(buildSharedUpstreamNotes([g], 'chatgpt', null)[0].peers.map((p) => p.id)).toEqual(['claudeai', 'cursor'])
    expect(buildSharedUpstreamNotes([g], 'claudecode', null)[0].peers.map((p) => p.id)).toEqual(['chatgpt', 'cursor'])
  })

  it('two other providers read as plural rows', () => {
    const g: SharedUpstreamGroupLike = { ...github, services: [svcRow('chatgpt', 'ChatGPT', 'OpenAI'), svcRow('claudeai', 'claude.ai', 'Anthropic'), svcRow('cursor', 'Cursor', 'Anysphere')] }
    const html = renderSharedUpstreamNotes(buildSharedUpstreamNotes([g], 'chatgpt', null), 'ChatGPT')
    expect(html).toContain('and so do open incidents from:')
    expect(html.match(/data-ga="shared_cause_link" data-ga-loc="is_down_page" data-ga-from="chatgpt" data-ga-to="(claudeai|cursor)"/g)).toHaveLength(2)
  })

  it('no card for a third party the Related Upstream card on the same page already shows', () => {
    const upstream = buildUpstreamNote([{ id: 'chatgpt', incidentTitle: 'ChatGPT errors due to GitHub', startedAt: at,
      upstream: [{ id: 'github-platform', name: 'GitHub', status: 'degraded', incidentTitle: 'Disruption with some GitHub services', startedAt: at, statusUrl: 'https://www.githubstatus.com' }] }], 'chatgpt')
    expect(upstream?.upstream[0].external).toBe(true)
    expect(buildSharedUpstreamNotes([github], 'chatgpt', upstream)).toEqual([])
  })

  it('a status URL that is not http(s) gives no card', () => {
    expect(buildSharedUpstreamNotes([{ ...github, thirdParty: { ...github.thirdParty, statusUrl: 'javascript:alert(1)' } }], 'chatgpt', null)).toEqual([])
  })
})
