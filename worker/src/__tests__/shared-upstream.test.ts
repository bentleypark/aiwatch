import { describe, it, expect } from 'vitest'
import { sharedUpstreamGroups, namesThirdParty, blameText, THIRD_PARTIES } from '../shared-upstream'
import type { Incident, ServiceStatus } from '../types'

type Svc = Pick<ServiceStatus, 'id' | 'name' | 'provider' | 'incidents'>

const inc = (title: string, updates: string[] = [], over: Partial<Incident> = {}): Incident => ({
  id: `i-${title.slice(0, 12)}`, title, status: 'identified', impact: 'minor', startedAt: '2026-11-12T17:52:44Z',
  duration: null, timeline: updates.map((text) => ({ stage: 'identified', text, at: '2026-11-12T18:00:00Z' })), ...over,
} as Incident)
const svc = (id: string, provider: string, incidents: Incident[]): Svc => ({ id, name: id, provider, incidents })

const keys = (services: Svc[]) => sharedUpstreamGroups(services).map((g) => [g.thirdParty.key, g.services.map((s) => s.id)])

describe('#1991 sharedUpstreamGroups — the classified groups from the issue', () => {
  it('Microsoft 365, 2026-11-12: two providers, same title', () => {
    expect(keys([
      svc('claudeai', 'Anthropic', [inc('Elevated errors affecting the Microsoft 365 connector')]),
      svc('chatgpt', 'OpenAI', [inc('Elevated errors affecting the Microsoft 365 connector')]),
      svc('claude', 'Anthropic', [inc('Elevated errors on Sonnet')]),
    ])).toEqual([['microsoft365', ['claudeai', 'chatgpt']]])
  })

  it('AWS, 2026-05-08: the third party is named only in an update body', () => {
    expect(keys([
      svc('modal', 'Modal', [inc('Internal data stores are failing', ['AWS us-east-1 EC2 is currently experiencing an outage'])]),
      svc('perplexity', 'Perplexity AI', [inc('Perplexity Website and API incident', ['root cause in the underlying AWS infrastructure'])]),
    ])).toEqual([['aws', ['modal', 'perplexity']]])
  })

  it('GCP, 2026-09-01: "Google Cloud Platform (GCP)" and "issues in GCP" both count', () => {
    expect(keys([
      svc('cohere', 'Cohere', [inc('Multiple Endpoint Disruptions', ['an ongoing Google Cloud Platform (GCP) outage'])]),
      svc('pinecone', 'Pinecone', [inc('5xx errors on some control plane operations', ['likely related to ongoing issues in GCP'])]),
    ])).toEqual([['gcp', ['cohere', 'pinecone']]])
  })

  it('Azure, 2025-10-29: named only in updates', () => {
    expect(keys([
      svc('bfl', 'Black Forest Labs', [inc('Global Outage', ['Azure is currently experience issues resulting in a full outage in our image generation services.'])]),
      svc('speechmatics', 'Speechmatics', [inc('Outage affecting Portal, Batch SaaS API and Management Platform API', ["the nature of Azure's outage affecting their AD B2C service"])]),
    ])).toEqual([['azure', ['bfl', 'speechmatics']]])
  })

  it('Cloudflare, 2025-11-18: three providers, lower-case mention included', () => {
    expect(keys([
      svc('groq', 'Groq', [inc('Console, Website, & API Availability Issues: Global Cloudflare Outage')]),
      svc('assemblyai', 'AssemblyAI', [inc('Cloudflare outage affecting documentation access')]),
      svc('stability', 'Stability AI', [inc('Public REST API outage', ['the public cloudflare network outage is root cause'])]),
    ])).toEqual([['cloudflare', ['groq', 'assemblyai', 'stability']]])
  })
})

describe('#1991 sharedUpstreamGroups — what must not group', () => {
  it('one provider alone is not a shared cause, even across its sibling surfaces', () => {
    const t = 'Elevated errors affecting the Microsoft 365 connector'
    expect(keys([svc('claudeai', 'Anthropic', [inc(t)]), svc('claudecode', 'Anthropic', [inc(t)])])).toEqual([])
  })

  it('a resolved incident does not count', () => {
    expect(keys([
      svc('claudeai', 'Anthropic', [inc('Microsoft 365 connector errors')]),
      svc('chatgpt', 'OpenAI', [inc('Microsoft 365 connector errors', [], { status: 'resolved' })]),
    ])).toEqual([])
  })

  it("a service owned by the third party's provider does not count towards it", () => {
    expect(keys([
      svc('copilot', 'GitHub', [inc('Disruption with some Copilot services', ['Copilot on GitHub is degraded'])]),
      svc('cursor', 'Anysphere', [inc('Slow clones from GH due to Github degradation')]),
    ])).toEqual([])
  })

  it('region tags on two unrelated incidents are not a shared cause', () => {
    expect(keys([
      svc('pinecone', 'Pinecone', [inc('[Serverless][AWS][us-east-1] 5xx errors on read operations for some indexes', [], { componentNames: ['AWS us-east-1'] })]),
      svc('turbopuffer', 'turbopuffer', [inc('Degraded performance in aws-us-west-2')]),
    ])).toEqual([])
    expect(keys([
      svc('pinecone', 'Pinecone', [inc('Elevated read latency', [], { componentNames: ['GCP us-central1'] })]),
      svc('turbopuffer', 'turbopuffer', [inc('Elevated rate of 5xx in gcp-us-central1')]),
    ])).toEqual([])
  })

  it('a region-tagged incident still counts when its update names the cause', () => {
    expect(keys([
      svc('pinecone', 'Pinecone', [inc('[GCP][us-central1] 5xx errors', ['likely related to ongoing issues in GCP'])]),
      svc('cohere', 'Cohere', [inc('Multiple Endpoint Disruptions', ['an ongoing Google Cloud Platform (GCP) outage'])]),
    ])).toEqual([['gcp', ['pinecone', 'cohere']]])
  })

  it('a generic word or a substring is not a mention', () => {
    expect(keys([
      svc('a', 'P1', [inc('Draws fail', ['our engineering teams are on it'])]),
      svc('b', 'P2', [inc('New laws page broken', ['teams are investigating'])]),
    ])).toEqual([])
  })

  it('two different third parties at once give two groups, larger first', () => {
    expect(keys([
      svc('groq', 'Groq', [inc('Cloudflare outage')]),
      svc('assemblyai', 'AssemblyAI', [inc('Cloudflare outage')]),
      svc('stability', 'Stability AI', [inc('Cloudflare outage')]),
      svc('modal', 'Modal', [inc('x', ['AWS outage'])]),
      svc('perplexity', 'Perplexity AI', [inc('y', ['AWS outage'])]),
    ]).map(([k]) => k)).toEqual(['cloudflare', 'aws'])
  })
})

describe('#1991 blameText', () => {
  it.each([
    ['[Serverless][AWS][us-east-1] 5xx errors', 'aws', false],
    ['Outage in aws-us-west-2', 'aws', false],
    ['Elevated 500s in region gcp-us-east4', 'gcp', false],
    ['AWS us-east-1 EC2 is currently experiencing an outage', 'aws', true],
    ['root cause in the underlying AWS infrastructure', 'aws', true],
    ['due to an ongoing incident with [Google Cloud Storage](https://status.cloud.google.com/incidents/x)', 'gcp', true],
    ['due to an ongoing [global cloudflare outage](https://www.cloudflarestatus.com/incidents/8gmgl950y3h7)', 'cloudflare', true],
  ])('%s → names %s: %s', (title, key, want) => {
    const tp = THIRD_PARTIES.find((t) => t.key === key)!
    expect(namesThirdParty(blameText({ title, timeline: [] }), tp.aliases)).toBe(want)
  })

  it('an unclosed bracket in one entry does not swallow the next', () => {
    const text = blameText({ title: 'Errors on array[0', timeline: [{ stage: 'identified', text: 'An AWS outage is the cause', at: '' }, { stage: 'resolved', text: 'Fixed]', at: '' }] } as never)
    expect(namesThirdParty(text, ['aws'])).toBe(true)
  })
})

describe('#1991 namesThirdParty', () => {
  it.each([
    ['AWS us-east-1', ['aws'], true],
    ['aws-us-west-2: errors', ['aws'], true],
    ['[GCP][us-central1] errors', ['gcp'], true],
    ['Microsoft  365 connector', ['microsoft 365'], true],
    ['draws', ['aws'], false],
    ['Microsoft connectors', ['microsoft 365'], false],
  ])('%s with %j → %s', (text, aliases, want) => {
    expect(namesThirdParty(text, aliases)).toBe(want)
  })

  it('every third party has a status page and at least one alias', () => {
    for (const tp of THIRD_PARTIES) {
      expect(tp.aliases.length).toBeGreaterThan(0)
      expect(tp.statusUrl).toMatch(/^https:\/\//)
    }
  })
})
