// #348 — outage-tweet draft attached to operator Discord alerts for the Claude/OpenAI family.
import { describe, it, expect } from 'vitest'
import { buildTweetDraft, buildTweetDrafts, appendTweetDraftSection, defuseAutolinkDomain, DISCORD_EMBED_DESC_MAX } from '../alerts'
import type { AlertCandidate, ScoredService, TweetDraft } from '../alerts'

const X_INTENT = 'https://twitter.com/intent/tweet?text='

function mockService(overrides: Partial<ScoredService> = {}): ScoredService {
  return {
    id: 'claude',
    name: 'Claude API',
    provider: 'Anthropic',
    category: 'api',
    status: 'operational',
    statusUrl: 'https://status.claude.com',
    incidents: [],
    uptime30d: 99.9,
    latency: 200,
    aiwatchScore: 90,
    scoreGrade: 'excellent',
    ...overrides,
  } as ScoredService
}

function alert(overrides: Partial<AlertCandidate> = {}): AlertCandidate {
  return {
    key: 'alerted:new:inc1',
    title: '🔴 Claude API — New Incident',
    description: 'Elevated errors',
    color: 0xed4245,
    url: 'https://ai-watch.dev/#claude',
    ...overrides,
  }
}

describe('buildTweetDraft', () => {
  it('builds an outage draft for a new Claude incident (impact + title + is-down url)', () => {
    const svc = mockService({
      status: 'down',
      incidents: [{ id: 'inc1', title: 'API returning 500s', status: 'investigating', startedAt: new Date().toISOString(), impact: 'major' } as any],
    })
    const draft = buildTweetDraft(alert(), [svc])
    expect(draft).not.toBeNull()
    expect(draft!.text).toBe('🔴 Claude API is reporting a major outage: API returning 500s. Live status → https://ai-watch.dev/is-claude-down?e=down&utm_source=x&utm_medium=social&utm_campaign=outage')
    expect(draft!.intentUrl).toBe(X_INTENT + encodeURIComponent(draft!.text))
  })

  it('#696 — tags the is-down link with the X UTM campaign (for GA4 attribution), after the ?e= hint', () => {
    const svc = mockService({ status: 'down' })
    const draft = buildTweetDraft(alert({ key: 'alerted:down:claude', title: '🔴 Claude API — Service Down' }), [svc])
    // utm rides as &-params AFTER ?e=, so the canonical is-down path is unchanged and ?e= still toggles
    expect(draft!.text).toContain('?e=down&utm_source=x&utm_medium=social&utm_campaign=outage')
    // the encoded intent URL carries it too (so the X click lands tagged even with a stripped referrer)
    expect(draft!.intentUrl).toContain(encodeURIComponent('utm_source=x'))
  })

  it('falls back to status phrasing for a status-only down alert (no incident)', () => {
    const svc = mockService({ id: 'openai', name: 'OpenAI API', provider: 'OpenAI', status: 'down' })
    const draft = buildTweetDraft(alert({ key: 'alerted:down:openai', title: '🔴 OpenAI API — Service Down' }), [svc])
    expect(draft!.text).toBe('🔴 OpenAI API is reporting an outage. Live status → https://ai-watch.dev/is-openai-down?e=down&utm_source=x&utm_medium=social&utm_campaign=outage')
  })

  it('uses "degraded performance" for a degraded status alert', () => {
    const svc = mockService({ id: 'chatgpt', name: 'ChatGPT', provider: 'OpenAI', category: 'app', status: 'degraded' })
    const draft = buildTweetDraft(alert({ key: 'alerted:degraded:chatgpt', title: '🟠 ChatGPT — Partially Degraded' }), [svc])
    expect(draft!.text).toBe('🔴 ChatGPT is reporting degraded performance. Live status → https://ai-watch.dev/is-chatgpt-down?e=degraded&utm_source=x&utm_medium=social&utm_campaign=outage')
  })

  it('maps minor incident impact to "degraded performance"', () => {
    const svc = mockService({
      status: 'degraded',
      incidents: [{ id: 'inc1', title: 'Slow responses', status: 'investigating', startedAt: new Date().toISOString(), impact: 'minor' } as any],
    })
    const draft = buildTweetDraft(alert(), [svc])
    expect(draft!.text).toBe('🔴 Claude API is reporting degraded performance: Slow responses. Live status → https://ai-watch.dev/is-claude-down?e=degraded&utm_source=x&utm_medium=social&utm_campaign=outage')
  })

  it('builds a recovery draft with duration parsed from the resolved title (claude.ai slug)', () => {
    const svc = mockService({
      id: 'claudeai', name: 'claude.ai', category: 'app',
      incidents: [{ id: 'incX', title: 'Resolved', status: 'resolved', startedAt: new Date().toISOString(), duration: '1h 20m', impact: 'major' } as any],
    })
    const draft = buildTweetDraft(alert({ key: 'alerted:res:incX', title: '🟢 claude.ai — Incident Resolved (1h 20m)' }), [svc])
    expect(draft!.text).toBe('🟢 claude ai recovered after 1h 20m. Live status → https://ai-watch.dev/is-claude-ai-down?e=resolved&utm_source=x&utm_medium=social&utm_campaign=outage')
  })

  it('builds a recovery draft from a service-recovered status alert', () => {
    const svc = mockService({ status: 'operational' })
    const draft = buildTweetDraft(alert({ key: 'alerted:recovered:claude', title: '🟢 Claude API — Service Recovered (45m)' }), [svc])
    expect(draft!.text).toBe('🟢 Claude API recovered after 45m. Live status → https://ai-watch.dev/is-claude-down?e=resolved&utm_source=x&utm_medium=social&utm_campaign=outage')
  })

  it('omits duration when the recovery title has none', () => {
    const svc = mockService({ status: 'operational' })
    const draft = buildTweetDraft(alert({ key: 'alerted:recovered:claude', title: '🟢 Claude API — Service Recovered' }), [svc])
    expect(draft!.text).toBe('🟢 Claude API has recovered. Live status → https://ai-watch.dev/is-claude-down?e=resolved&utm_source=x&utm_medium=social&utm_campaign=outage')
  })

  it('resolves the claudecode → claude-code slug and maps critical impact to "a major outage"', () => {
    const svc = mockService({
      id: 'claudecode', name: 'Claude Code', category: 'agent', status: 'down',
      incidents: [{ id: 'inc1', title: 'CLI down', status: 'investigating', startedAt: new Date().toISOString(), impact: 'critical' } as any],
    })
    const draft = buildTweetDraft(alert(), [svc])
    expect(draft!.text).toBe('🔴 Claude Code is reporting a major outage: CLI down. Live status → https://ai-watch.dev/is-claude-code-down?e=down&utm_source=x&utm_medium=social&utm_campaign=outage')
  })

  it('skips a non-target sibling and resolves the in-scope service in a shared-incident group', () => {
    // svcIdsForAlert returns services in array order; gemini (non-target) is listed first, so the
    // .find(in-scope) must skip past it to reach claude. Guards the documented sibling-skip path.
    const inc = { id: 'inc1', title: 'Shared multi-provider outage', status: 'investigating', startedAt: new Date().toISOString(), impact: 'major' } as any
    const gemini = mockService({ id: 'gemini', name: 'Gemini API', provider: 'Google', status: 'down', incidents: [inc] })
    const claude = mockService({ status: 'down', incidents: [inc] })
    const draft = buildTweetDraft(alert(), [gemini, claude])
    expect(draft!.text).toBe('🔴 Claude API is reporting a major outage: Shared multi-provider outage. Live status → https://ai-watch.dev/is-claude-down?e=down&utm_source=x&utm_medium=social&utm_campaign=outage')
  })

  it('consults _mergedKeys when resolving the covered service', () => {
    // Merged alerts (mergeTogetherAlerts) set _mergedKeys; buildTweetDraft must scan them, not just alert.key.
    const svc = mockService({
      status: 'down',
      incidents: [{ id: 'incA', title: 'Merged incident', status: 'investigating', startedAt: new Date().toISOString(), impact: 'major' } as any],
    })
    const draft = buildTweetDraft(alert({ key: 'alerted:new:incA', _mergedKeys: ['alerted:new:incA', 'alerted:new:incB'] }), [svc])
    expect(draft!.text).toBe('🔴 Claude API is reporting a major outage: Merged incident. Live status → https://ai-watch.dev/is-claude-down?e=down&utm_source=x&utm_medium=social&utm_campaign=outage')
  })

  it('returns null for a non-target service', () => {
    const svc = mockService({ id: 'gemini', name: 'Gemini API', provider: 'Google', status: 'down',
      incidents: [{ id: 'inc1', title: 'down', status: 'investigating', startedAt: new Date().toISOString(), impact: 'major' } as any] })
    expect(buildTweetDraft(alert(), [svc])).toBeNull()
  })

  it('returns null for an unrecognized alert key', () => {
    const svc = mockService({ status: 'down' })
    expect(buildTweetDraft(alert({ key: 'something:else:claude' }), [svc])).toBeNull()
  })

  it('truncates a long incident title to keep the tweet ≤ 270 chars', () => {
    const svc = mockService({
      status: 'down',
      incidents: [{ id: 'inc1', title: 'x'.repeat(400), status: 'investigating', startedAt: new Date().toISOString(), impact: 'major' } as any],
    })
    const draft = buildTweetDraft(alert(), [svc])
    expect(draft!.text.length).toBeLessThanOrEqual(270)
    expect(draft!.text).toContain('…')
    expect(draft!.text).toContain('https://ai-watch.dev/is-claude-down')
  })

  it('collapses newlines/backticks in the incident title', () => {
    const svc = mockService({
      status: 'down',
      incidents: [{ id: 'inc1', title: 'line1\nline2 ```code```', status: 'investigating', startedAt: new Date().toISOString(), impact: 'major' } as any],
    })
    const draft = buildTweetDraft(alert(), [svc])
    expect(draft!.text).not.toContain('\n')
    expect(draft!.text).not.toContain('`')
    expect(draft!.text).toContain('line1 line2 code')
  })
})

describe('buildTweetDrafts (#521 — operator picks the surface)', () => {
  // A multi-surface Anthropic incident: one incidentId carried by all three surfaces.
  const sharedInc = (id: string) => ({ id, title: 'Opus 4.7 elevated errors', status: 'investigating', startedAt: new Date().toISOString(), impact: 'minor' } as any)
  const anthropic = [
    mockService({ id: 'claude', name: 'Claude API', status: 'degraded', incidents: [sharedInc('opus47')] }),
    mockService({ id: 'claudeai', name: 'claude.ai', status: 'degraded', incidents: [sharedInc('opus47')] }),
    mockService({ id: 'claudecode', name: 'Claude Code', status: 'degraded', incidents: [sharedInc('opus47')] }),
  ]

  it('returns one draft per affected in-scope surface, each with its OWN name + is-down url', () => {
    const drafts = buildTweetDrafts(alert({ key: 'alerted:new:opus47' }), anthropic)
    expect(drafts.map((d) => d.serviceId)).toEqual(['claude', 'claudeai', 'claudecode'])
    expect(drafts[0].text).toContain('Claude API')
    expect(drafts[0].intentUrl).toContain(encodeURIComponent('https://ai-watch.dev/is-claude-down'))
    expect(drafts[1].text).toContain('claude ai') // #539: brand defused in tweet text
    expect(drafts[1].intentUrl).toContain(encodeURIComponent('https://ai-watch.dev/is-claude-ai-down'))
    expect(drafts[2].text).toContain('Claude Code')
    expect(drafts[2].intentUrl).toContain(encodeURIComponent('https://ai-watch.dev/is-claude-code-down'))
  })

  it('filters out non-in-scope services in the group (e.g. Gemini)', () => {
    const withGemini = [
      mockService({ id: 'gemini', name: 'Gemini API', provider: 'Google', incidents: [sharedInc('opus47')] }),
      ...anthropic,
    ]
    const drafts = buildTweetDrafts(alert({ key: 'alerted:new:opus47' }), withGemini)
    expect(drafts.map((d) => d.serviceId)).toEqual(['claude', 'claudeai', 'claudecode']) // gemini excluded
  })

  it('single-surface incident yields exactly one draft (matches buildTweetDraft)', () => {
    const svc = mockService({ id: 'openai', name: 'OpenAI API', provider: 'OpenAI', status: 'down', incidents: [sharedInc('solo')] })
    const drafts = buildTweetDrafts(alert({ key: 'alerted:new:solo' }), [svc])
    expect(drafts).toHaveLength(1)
    expect(drafts[0].text).toBe(buildTweetDraft(alert({ key: 'alerted:new:solo' }), [svc])!.text)
  })

  it('returns [] when no in-scope service is covered', () => {
    const svc = mockService({ id: 'gemini', name: 'Gemini API', provider: 'Google', incidents: [sharedInc('g1')] })
    expect(buildTweetDrafts(alert({ key: 'alerted:new:g1' }), [svc])).toEqual([])
  })

  it('builds recovery drafts per surface for a resolved multi-surface incident', () => {
    const drafts = buildTweetDrafts(alert({ key: 'alerted:res:opus47', title: '🟢 Claude API — Incident Resolved (34m)' }), anthropic)
    expect(drafts).toHaveLength(3)
    expect(drafts[0].text).toBe('🟢 Claude API recovered after 34m. Live status → https://ai-watch.dev/is-claude-down?e=resolved&utm_source=x&utm_medium=social&utm_campaign=outage')
    expect(drafts[1].text).toContain('🟢 claude ai recovered after 34m') // #539: brand defused
  })

  it('#545 — scopes drafts to alert.svcIds (the joiner), not every service sharing the incidentId', () => {
    // The alert represents only the late joiner (claudecode); the other two surfaces already fired.
    // Without the alert.svcIds preference, all three would be re-drafted (the #545 bug).
    const drafts = buildTweetDrafts(alert({ key: 'alerted:new:opus47', svcIds: ['claudecode'] }), anthropic)
    expect(drafts.map((d) => d.serviceId)).toEqual(['claudecode'])
    // Sanity: without svcIds the same alert+services would draft all three.
    expect(buildTweetDrafts(alert({ key: 'alerted:new:opus47' }), anthropic)).toHaveLength(3)
  })
})

describe('appendTweetDraftSection (#521 — Discord 4096 length guard)', () => {
  const DIV = '┈┈┈┈┈┈'
  const draft = (serviceId: string, serviceName: string, text: string): TweetDraft =>
    ({ serviceId, serviceName, text, intentUrl: 'https://twitter.com/intent/tweet?text=' + encodeURIComponent(text) })
  const three = [
    draft('claude', 'Claude API', '🔴 Claude API is reporting degraded performance: Opus 4.7 elevated errors. Live status → https://ai-watch.dev/is-claude-down'),
    draft('claudeai', 'claude.ai', '🔴 claude.ai is reporting degraded performance: Opus 4.7 elevated errors. Live status → https://ai-watch.dev/is-claude-ai-down'),
    draft('claudecode', 'Claude Code', '🔴 Claude Code is reporting degraded performance: Opus 4.7 elevated errors. Live status → https://ai-watch.dev/is-claude-code-down'),
  ]

  it('returns the description unchanged when there are no drafts', () => {
    expect(appendTweetDraftSection('desc', [], DIV)).toBe('desc')
  })

  it('single draft → original preview+link shape', () => {
    const out = appendTweetDraftSection('desc', [three[0]], DIV)
    expect(out).toContain('🐦 **TWEET DRAFT** — [✍️ Post on X](')
    expect(out).toContain('> 🔴 Claude API is reporting')
  })

  it('multiple drafts → one labeled compose link per service, no single preview', () => {
    const out = appendTweetDraftSection('desc', three, DIV)
    expect(out).toContain('pick a service to post:')
    expect(out).toContain('[✍️ Claude API](')
    expect(out).toContain('[✍️ claude ai](') // #535: defused so Discord doesn't unfurl a thumbnail
    expect(out).toContain('[✍️ Claude Code](')
    expect(out).not.toContain('> 🔴') // no blockquote preview in the multi case
  })

  // #535 — appendTweetDraftSection defuses the bare "claude.ai" in the VISIBLE blockquote/label so
  // Discord doesn't unfurl a thumbnail; it passes the intentUrl through verbatim (does not rewrite
  // it). These use SYNTHETIC drafts to test that isolation. (Real drafts from buildTweetForService
  // now also defuse the tweet text + intentUrl upstream — see the #539 block below.)
  describe('claude.ai thumbnail defuse (#535)', () => {
    const claudeaiText =
      '🔴 claude.ai is reporting a major outage: Opus 4.7 elevated errors. Live status → https://ai-watch.dev/is-claude-ai-down'
    const claudeaiDraft: TweetDraft = {
      serviceId: 'claudeai',
      serviceName: 'claude.ai',
      text: claudeaiText,
      intentUrl: 'https://twitter.com/intent/tweet?text=' + encodeURIComponent(claudeaiText),
    }

    it('single draft: blockquote preview shows "claude ai", no bare "claude.ai" domain', () => {
      const out = appendTweetDraftSection('desc', [claudeaiDraft], DIV)
      expect(out).toContain('> 🔴 claude ai is reporting')
      // the only "claude.ai" left is inside the X intent URL (a query param Discord never linkifies)
      const blockquote = out.split('\n').find((l) => l.startsWith('> '))!
      expect(blockquote).not.toContain('claude.ai')
    })

    it('passes the intentUrl through verbatim (does not rewrite the link target)', () => {
      const out = appendTweetDraftSection('desc', [claudeaiDraft], DIV)
      expect(out).toContain(claudeaiDraft.intentUrl) // intent URL embedded verbatim, untouched
    })

    it('multi draft: per-service label is defused to "claude ai"', () => {
      const others: TweetDraft[] = [
        { serviceId: 'claude', serviceName: 'Claude API', text: 'x', intentUrl: 'https://twitter.com/intent/tweet?text=x' },
        claudeaiDraft,
      ]
      const out = appendTweetDraftSection('desc', others, DIV)
      expect(out).toContain('[✍️ claude ai](')
      expect(out).not.toContain('[✍️ claude.ai](')
    })

    it('does not touch the is-claude-ai-down slug (hyphen, not a dot)', () => {
      const out = appendTweetDraftSection('desc', [claudeaiDraft], DIV)
      expect(out).toContain('is-claude-ai-down')
    })
  })

  it('never exceeds the Discord 4096-char limit, truncating links with "+N more"', () => {
    const longDesc = 'x'.repeat(3900) // already near the cap
    const out = appendTweetDraftSection(longDesc, three, DIV)
    expect(out.length).toBeLessThanOrEqual(DISCORD_EMBED_DESC_MAX)
    // not all three links fit → either truncated to fewer (+N more) or section skipped entirely
    expect(out.startsWith(longDesc)).toBe(true)
  })

  it('partially fits links and appends a "+N more" suffix, still under the limit', () => {
    // Pick a description length that leaves room for some but not all 3 links → exercises the
    // truncation branch (the prior test lands on "none fit"). Each link is ~235 chars.
    const linkLen = `[✍️ Claude API](${three[0].intentUrl})`.length
    const intro = '\n' + DIV + '\n🐦 **TWEET DRAFT** — pick a service to post:\n'
    // Budget that fits exactly 2 links (2*linkLen + 3) but not 3: target budget ≈ 2*linkLen + 10
    const targetBudget = 2 * linkLen + 10
    const descLen = DISCORD_EMBED_DESC_MAX - 16 - intro.length - targetBudget
    const out = appendTweetDraftSection('x'.repeat(descLen), three, DIV)
    expect(out.length).toBeLessThanOrEqual(DISCORD_EMBED_DESC_MAX)
    expect(out).toContain(' more') // some links dropped → "+N more"
    expect(out).toContain('[✍️ Claude API](') // at least one link kept
  })

  it('skips the whole section (description unchanged) when not even one link fits', () => {
    const longDesc = 'x'.repeat(4090)
    expect(appendTweetDraftSection(longDesc, three, DIV)).toBe(longDesc)
  })

  it('skips a single draft that would overflow rather than dropping the alert', () => {
    const longDesc = 'x'.repeat(4090)
    expect(appendTweetDraftSection(longDesc, [three[0]], DIV)).toBe(longDesc)
  })
})

// #535 — the operator send (index.ts) applies this to the embed title + the main description
// (before the tweet draft is appended) so Discord doesn't unfurl a "claude.ai" thumbnail anywhere
// in the operator embed, while the X intent-URL tweet text stays branded.
describe('defuseAutolinkDomain (#535)', () => {
  it('replaces the bare "claude.ai" domain with "claude ai"', () => {
    expect(defuseAutolinkDomain('🔴 claude.ai — Service Down')).toBe('🔴 claude ai — Service Down')
    expect(defuseAutolinkDomain('**claude.ai** (Anthropic)')).toBe('**claude ai** (Anthropic)')
  })

  it('is case-insensitive and global (incident titles may carry mixed case / repeats)', () => {
    expect(defuseAutolinkDomain('Claude.AI and claude.ai degraded')).toBe('claude ai and claude ai degraded')
  })

  it('does NOT touch the is-claude-ai-down slug (hyphen, not a dot)', () => {
    const s = 'Live status → https://ai-watch.dev/is-claude-ai-down'
    expect(defuseAutolinkDomain(s)).toBe(s)
  })

  it('leaves other dotted brands alone (only claude.ai is in scope)', () => {
    expect(defuseAutolinkDomain('Character.AI is fine')).toBe('Character.AI is fine')
    expect(defuseAutolinkDomain('ai-watch.dev unaffected')).toBe('ai-watch.dev unaffected')
  })

  it('is idempotent (re-applying does nothing)', () => {
    const once = defuseAutolinkDomain('claude.ai down')
    expect(defuseAutolinkDomain(once)).toBe(once)
  })
})

// #539 — the tweet draft is pasted into Slack/Reddit/X, so (1) the brand is defused in the tweet
// TEXT + intentUrl (not just the Discord preview), and (2) the is-X-down link carries a status hint
// so a recovery share is a DISTINCT URL from the outage share → platforms re-unfurl a fresh OG card.
describe('buildTweetForService brand defuse + status hint (#539)', () => {
  it('defuses claude.ai in the recovery tweet text AND the intent URL', () => {
    const svc = mockService({
      id: 'claudeai', name: 'claude.ai', category: 'app',
      incidents: [{ id: 'incX', title: 'Resolved', status: 'resolved', startedAt: new Date().toISOString(), duration: '1h 20m', impact: 'major' } as any],
    })
    const draft = buildTweetDraft(alert({ key: 'alerted:res:incX', title: '🟢 claude.ai — Incident Resolved (1h 20m)' }), [svc])!
    expect(draft.text).not.toContain('claude.ai')      // brand defused everywhere in the text
    expect(draft.text).toContain('claude ai')
    expect(decodeURIComponent(draft.intentUrl)).not.toContain('claude.ai') // intent URL no longer branded
  })

  it('appends ?e=resolved on recovery and ?e=<status> on outage (distinct URLs)', () => {
    const recSvc = mockService({ status: 'operational' })
    const rec = buildTweetDraft(alert({ key: 'alerted:recovered:claude', title: '🟢 Claude API — Service Recovered (45m)' }), [recSvc])!
    expect(rec.text).toContain('is-claude-down?e=resolved&utm_source=x&utm_medium=social&utm_campaign=outage')

    const downSvc = mockService({ status: 'down', incidents: [{ id: 'inc1', title: 'down', status: 'investigating', startedAt: new Date().toISOString(), impact: 'major' } as any] })
    const down = buildTweetDraft(alert(), [downSvc])!
    expect(down.text).toContain('is-claude-down?e=down&utm_source=x&utm_medium=social&utm_campaign=outage')
    // the two transitions yield different URLs → fresh unfurl
    expect(rec.text).not.toBe(down.text)
  })
})
