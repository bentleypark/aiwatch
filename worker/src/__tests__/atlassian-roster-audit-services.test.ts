import { describe, it, expect } from 'vitest'
import { atlassianRosterAuditServices, uptimeScopeOf, SERVICES } from '../services'
import { rosterAgedInFindings } from '../roster-audit'
import { atlassianRosterEntries } from '../parsers/statuspage'
import type { ServiceConfig } from '../types'

describe('atlassianRosterAuditServices (#1518 — the Atlassian-branch equivalent of rosterAuditPages)', () => {
  it('matches exactly the real multi-id Atlassian services, none of the incident.io ones', () => {
    const ids = atlassianRosterAuditServices().map((s) => s.id).sort()
    expect(ids).toEqual(['bfl', 'claudeai', 'copilot', 'cursor', 'deepgram', 'jina', 'kimiapp', 'pinecone', 'runway', 'twelvelabs', 'windsurf'])
  })

  it('excludes a service with a single-id statusComponentIds list', () => {
    const configs: ServiceConfig[] = [
      { id: 'single', name: 'S', provider: 'X', category: 'api', statusUrl: 'https://x.example', apiUrl: null, statusComponentIds: ['a'] },
    ]
    expect(atlassianRosterAuditServices(configs)).toEqual([])
  })

  it('excludes a multi-id service that ALSO sets incidentIoComponentId — that one goes through the incident.io branch instead', () => {
    const configs: ServiceConfig[] = [
      { id: 'both', name: 'B', provider: 'X', category: 'api', statusUrl: 'https://x.example', apiUrl: null, statusComponentIds: ['a', 'b'], incidentIoComponentId: 'c' },
    ]
    expect(atlassianRosterAuditServices(configs)).toEqual([])
  })

  it('includes a multi-id service with no incidentIoComponentId', () => {
    const configs: ServiceConfig[] = [
      { id: 'multi', name: 'M', provider: 'X', category: 'api', statusUrl: 'https://x.example', apiUrl: null, statusComponentIds: ['a', 'b'] },
    ]
    expect(atlassianRosterAuditServices(configs).map((s) => s.id)).toEqual(['multi'])
  })

  it('bfl is the only one configured rosterAuditFixedScope; the others are not', () => {
    const services = atlassianRosterAuditServices()
    const fixed = services.filter((s) => s.rosterAuditFixedScope).map((s) => s.id)
    expect(fixed).toEqual(['bfl'])
  })

  it('no two of them share a statusUrl — the cron keys its seen-set on statusUrl alone', () => {
    const urls = atlassianRosterAuditServices().map((s) => s.statusUrl)
    expect(new Set(urls).size).toBe(urls.length)
  })

  it('#1821 — on status.moonshot.cn a new member of either group still reports, though kimiapp excludes the group headers', () => {
    const kimiapp = SERVICES.find((s) => s.id === 'kimiapp')!
    const entries = [
      { id: 'NEW_SAAS', dataAvailableSince: '2025-01-01T00:00:00Z', groupId: '87jpctq5cp71' },
      { id: 'NEW_KIMI', dataAvailableSince: '2025-01-01T00:00:00Z', groupId: '01l1n50g13g6' },
    ]
    expect(rosterAgedInFindings(entries, uptimeScopeOf(kimiapp), kimiapp.rosterAuditExclude ?? [], false, Date.parse('2026-10-28T00:00:00Z')).sort()).toEqual(['NEW_KIMI', 'NEW_SAAS'])
  })

  // #1821 — status.pinecone.io components.json as served 2026-10-28, every component.
  const PINECONE_PAGE = [
    { id: 'm0src6w2y5cs', created_at: '2022-07-20T00:00:00Z', group_id: 'g7400gqyfhh9' },
    { id: 'jhky1rj0ps27', created_at: '2022-07-20T00:00:00Z', group_id: null },
    { id: 'pxrv8w9g33xl', created_at: '2024-03-04T00:00:00Z', group_id: 'r7tngp2p3sjd' },
    { id: 'bsfcc9g5875b', created_at: '2023-01-26T00:00:00Z', group_id: 'g7400gqyfhh9' },
    { id: 'zp1lkdyfrwt3', created_at: '2024-03-20T00:00:00Z', group_id: 'r7tngp2p3sjd' },
    { id: 'm2plw2fl0ssb', created_at: '2023-03-18T00:00:00Z', group_id: 'g7400gqyfhh9' },
    { id: 'v47ybr4zw5gy', created_at: '2024-06-20T00:00:00Z', group_id: 'r7tngp2p3sjd' },
    { id: 'pjdtxsth1qb5', created_at: '2023-03-24T00:00:00Z', group_id: 'g7400gqyfhh9' },
    { id: 'hky8j2m18wbd', created_at: '2024-07-28T00:00:00Z', group_id: 'r7tngp2p3sjd' },
    { id: 'hcnqgqjsrcz5', created_at: '2023-04-03T00:00:00Z', group_id: 'g7400gqyfhh9' },
    { id: '6jbr8t8ctbfc', created_at: '2024-07-02T00:00:00Z', group_id: 'r7tngp2p3sjd' },
    { id: 'cd8dy02swtjd', created_at: '2023-04-27T00:00:00Z', group_id: 'g7400gqyfhh9' },
    { id: '5j9yslcpk4b4', created_at: '2024-09-24T00:00:00Z', group_id: 'r7tngp2p3sjd' },
    { id: 'g7400gqyfhh9', created_at: '2023-03-18T00:00:00Z', group_id: null },
    { id: 'mv2ztwm9bypv', created_at: '2023-05-19T00:00:00Z', group_id: 'g7400gqyfhh9' },
    { id: 'c5g0prwsb217', created_at: '2023-06-22T00:00:00Z', group_id: 'g7400gqyfhh9' },
    { id: '2qvfsf1bnyhd', created_at: '2022-07-20T00:00:00Z', group_id: 'g7400gqyfhh9' },
    { id: 'ctfk7mwkzlzs', created_at: '2023-04-20T00:00:00Z', group_id: 'g7400gqyfhh9' },
    { id: 'k5ykpmr8kdq5', created_at: '2023-04-06T00:00:00Z', group_id: 'g7400gqyfhh9' },
    { id: '5ntb606ylyjf', created_at: '2023-04-20T00:00:00Z', group_id: 'g7400gqyfhh9' },
    { id: 'r7tngp2p3sjd', created_at: '2024-03-04T00:00:00Z', group_id: null },
    { id: 'p9299mk9b7m2', created_at: '2023-05-04T00:00:00Z', group_id: 'g7400gqyfhh9' },
    { id: 'hrgtfbcqygpc', created_at: '2024-06-19T00:00:00Z', group_id: null },
    { id: '3khsvr7j9bf1', created_at: '2023-04-08T00:00:00Z', group_id: 'g7400gqyfhh9' },
    { id: '34h37xk5ltv1', created_at: '2024-10-30T00:00:00Z', group_id: null },
    { id: 'pz791s0xf7nd', created_at: '2023-11-07T00:00:00Z', group_id: 'g7400gqyfhh9' },
    { id: 'pxr1b208pdh1', created_at: '2025-04-18T00:00:00Z', group_id: null },
    { id: 'pgh87kbtyjxb', created_at: '2022-07-20T00:00:00Z', group_id: 'g7400gqyfhh9' },
  ]

  // #1821 — status.twelvelabs.io components.json as served 2026-10-28, every component.
  const TWELVELABS_PAGE = [
    { id: 'mvv53x91b74m', created_at: '2023-02-13T00:00:00Z', group_id: null },
    { id: '29c68cnyd14l', created_at: '2023-02-14T00:00:00Z', group_id: 'blny8xq0yq7p' },
    { id: '12vp1vm9smc2', created_at: '2026-10-06T00:00:00Z', group_id: 'mvv53x91b74m' },
    { id: 'j86pqszy5w90', created_at: '2026-10-14T00:00:00Z', group_id: '28vf3d4r3tjg' },
    { id: '20930d4nz774', created_at: '2023-02-14T00:00:00Z', group_id: 'blny8xq0yq7p' },
    { id: 'qkmbnw1n5mgh', created_at: '2026-10-06T00:00:00Z', group_id: 'mvv53x91b74m' },
    { id: '27kd6568skjp', created_at: '2026-10-14T00:00:00Z', group_id: '28vf3d4r3tjg' },
    { id: '28vf3d4r3tjg', created_at: '2026-10-14T00:00:00Z', group_id: null },
    { id: 'blny8xq0yq7p', created_at: '2023-02-14T00:00:00Z', group_id: null },
    { id: 'yklrkrhkd1by', created_at: '2026-05-04T00:00:00Z', group_id: 'mvv53x91b74m' },
    { id: '3pksbw640gn9', created_at: '2026-10-14T00:00:00Z', group_id: '28vf3d4r3tjg' },
    { id: '3t1cjx55dyrf', created_at: '2026-04-20T00:00:00Z', group_id: 'mvv53x91b74m' },
    { id: 'rgbmm56z696d', created_at: '2026-10-14T00:00:00Z', group_id: '28vf3d4r3tjg' },
    { id: 'mrclkkqtj01j', created_at: '2023-02-13T00:00:00Z', group_id: 'mvv53x91b74m' },
    { id: 'sjbv0n38bs7n', created_at: '2026-10-14T00:00:00Z', group_id: '28vf3d4r3tjg' },
    { id: '2zsl201s8df5', created_at: '2025-03-03T00:00:00Z', group_id: 'mvv53x91b74m' },
    { id: 'cns848tdzn22', created_at: '2026-10-14T00:00:00Z', group_id: '28vf3d4r3tjg' },
    { id: 'jnvb5r3v74q1', created_at: '2025-05-21T00:00:00Z', group_id: 'mvv53x91b74m' },
    { id: 'jzy4m39608m3', created_at: '2026-10-14T00:00:00Z', group_id: '28vf3d4r3tjg' },
    { id: 'p1hx7t867896', created_at: '2026-08-31T00:00:00Z', group_id: 'mvv53x91b74m' },
    { id: '3ng4ddpvmv3r', created_at: '2026-08-31T00:00:00Z', group_id: 'mvv53x91b74m' },
    { id: '751304vy1s9x', created_at: '2025-03-03T00:00:00Z', group_id: 'mvv53x91b74m' },
    { id: 'hr353rqqmwmk', created_at: '2026-05-13T00:00:00Z', group_id: 'mvv53x91b74m' },
    { id: 'j21c5rdfj8kf', created_at: '2023-02-15T00:00:00Z', group_id: 'mvv53x91b74m' },
    { id: '91lzwtn6071h', created_at: '2025-03-03T00:00:00Z', group_id: 'mvv53x91b74m' },
  ]

  // #1821 — status.deepgram.com components.json as served 2026-10-28, every component.
  const DEEPGRAM_PAGE = [
    { id: 'cv8l6gg3cb9d', created_at: '2022-01-06T00:00:00Z', group_id: null },
    { id: 'm49xkwqkc4kh', created_at: '2022-01-06T00:00:00Z', group_id: 'cv8l6gg3cb9d' },
    { id: 'l4ch656gbn1k', created_at: '2022-01-06T00:00:00Z', group_id: 'y4btfh52r1qh' },
    { id: 'l2n5q03f22t4', created_at: '2022-01-24T00:00:00Z', group_id: 'cv7wd8pvvqh4' },
    { id: 's6v5z4lsl658', created_at: '2022-01-06T00:00:00Z', group_id: 'cv8l6gg3cb9d' },
    { id: 'jgfq9ffjsfqk', created_at: '2022-01-06T00:00:00Z', group_id: 'cv7wd8pvvqh4' },
    { id: 'cvbdk3fslx9v', created_at: '2022-01-06T00:00:00Z', group_id: 'vhv1mkf16jjw' },
    { id: 'cv7wd8pvvqh4', created_at: '2022-01-06T00:00:00Z', group_id: null },
    { id: 'dspsk5mtjzqt', created_at: '2022-01-06T00:00:00Z', group_id: 'y4btfh52r1qh' },
    { id: '6854s60zwxgw', created_at: '2024-03-18T00:00:00Z', group_id: 'cv8l6gg3cb9d' },
    { id: 'vhv1mkf16jjw', created_at: '2022-01-06T00:00:00Z', group_id: null },
    { id: 't80v4qz2jdsf', created_at: '2024-10-23T00:00:00Z', group_id: 'vhv1mkf16jjw' },
    { id: 'r2z04fcdhhzb', created_at: '2025-10-14T00:00:00Z', group_id: 'cv8l6gg3cb9d' },
    { id: 'y4btfh52r1qh', created_at: '2022-01-06T00:00:00Z', group_id: null },
    { id: 'vm1x1v101qtn', created_at: '2024-10-23T00:00:00Z', group_id: 'vhv1mkf16jjw' },
    { id: '7n3stjcbj4bx', created_at: '2025-10-16T00:00:00Z', group_id: 'cv8l6gg3cb9d' },
    { id: 'vsnk4gb1bb47', created_at: '2023-06-09T00:00:00Z', group_id: 'cv8l6gg3cb9d' },
  ]

  it.each([['pinecone', PINECONE_PAGE], ['twelvelabs', TWELVELABS_PAGE], ['deepgram', DEEPGRAM_PAGE]])('#1821 %s: the live page yields no aged-in finding under the real config', (id, comps) => {
    const config = atlassianRosterAuditServices().find((s) => s.id === id)!
    expect(rosterAgedInFindings(atlassianRosterEntries(comps), uptimeScopeOf(config), config.rosterAuditExclude ?? [], config.rosterAuditFixedScope ?? false, Date.parse('2026-12-01T00:00:00Z'))).toEqual([])
  })

  it('claudeai: every component on status.claude.com (live 2026-10-05) is in scope or excluded — no aged-in finding', () => {
    const claudeai = SERVICES.find((s) => s.id === 'claudeai')!
    const page = [
      { id: 'rwppv331jlwc', created_at: '2023-07-11T00:00:00Z' }, // claude.ai
      { id: '0qbwn08sd68x', created_at: '2023-07-11T00:00:00Z' }, // Claude Console
      { id: 'k8w3r06qmzrp', created_at: '2023-07-11T00:00:00Z' }, // Claude API
      { id: 'yyzkbfz2thpt', created_at: '2025-05-22T00:00:00Z' }, // Claude Code
      { id: 'bpp5gb3hpjcl', created_at: '2026-04-01T00:00:00Z' }, // Claude Cowork
      { id: '0scnb50nvy53', created_at: '2026-02-17T00:00:00Z' }, // Claude for Government
    ]
    const findings = rosterAgedInFindings(atlassianRosterEntries(page), uptimeScopeOf(claudeai), claudeai.rosterAuditExclude ?? [], false, Date.parse('2026-10-05T00:00:00Z'))
    expect(findings).toEqual([])
  })

  // #1741 — status.bfl.ml components.json as served 2026-10-25, every component.
  const BFL_PAGE = [
    { id: 'lzj5bpsmhwt6', name: 'FLUX 1.1 [pro]', created_at: '2024-10-07T19:54:52.676Z', group_id: 'm991l9z7y6jj' },
    { id: 'ygnttdvrl2pj', name: 'Flux.3', created_at: '2026-09-28T11:58:06.151Z', group_id: 'x16d9nh49hch' },
    { id: '70p23r3xs7b0', name: 'FLUX.1 [pro]', created_at: '2024-10-07T23:33:59.086Z', group_id: 'm991l9z7y6jj' },
    { id: 'h4v0br1sctqx', name: 'FLUX.1 [dev]', created_at: '2024-10-07T23:34:26.058Z', group_id: 'm991l9z7y6jj' },
    { id: 'm991l9z7y6jj', name: 'Image Generation Services', created_at: '2024-10-07T23:33:19.918Z', group_id: null },
    { id: 'ppxtlh70k466', name: 'FLUX 1.1 [pro] Ultra', created_at: '2025-02-05T22:48:18.818Z', group_id: 'm991l9z7y6jj' },
    { id: '8jg9v8zhstys', name: 'Finetuning', created_at: '2025-01-17T18:24:11.561Z', group_id: null },
    { id: 'thvty5dzd95w', name: 'FLUX.1 Fill [pro]', created_at: '2025-02-05T22:49:40.002Z', group_id: 'm991l9z7y6jj' },
    { id: 'qcvzszkj9m47', name: 'FLUX.1 Canny [pro]', created_at: '2025-02-05T22:50:08.202Z', group_id: 'm991l9z7y6jj' },
    { id: 'ws9rrzk6n2j7', name: 'API (api.bfl.ai)', created_at: '2026-04-22T14:05:41.303Z', group_id: null },
    { id: 'l27p2yhv77bj', name: 'FLUX.1 Depth [pro]', created_at: '2025-02-05T22:50:57.261Z', group_id: 'm991l9z7y6jj' },
    { id: 'x16d9nh49hch', name: 'Video Generation Services', created_at: '2026-09-28T11:58:06.107Z', group_id: null },
    { id: '6yncdw0dwc1s', name: 'FLUX .1 Kontext [pro]', created_at: '2025-05-29T20:18:08.536Z', group_id: 'm991l9z7y6jj' },
    { id: 'cw5sckn8002d', name: 'API EU (api.eu.bfl.ai)', created_at: '2026-09-28T11:58:59.729Z', group_id: null },
    { id: 'bvfp4p0szk5y', name: 'FLUX.1 Kontext [max]', created_at: '2025-06-02T17:36:00.742Z', group_id: 'm991l9z7y6jj' },
    { id: 'wb9xb021290k', name: 'API US (api.us.bfl.ai)', created_at: '2026-09-28T11:59:21.941Z', group_id: null },
    { id: 'k1f1dgrqqc9g', name: 'FLUX.2', created_at: '2026-03-25T13:39:02.312Z', group_id: 'm991l9z7y6jj' },
    { id: '67vphhw599hb', name: 'FLUX.2 [klein]', created_at: '2026-03-25T13:39:30.851Z', group_id: 'm991l9z7y6jj' },
  ]
  // Past 30 days for the 2026-09-28 additions, so they are aged in.
  const BFL_AGED = Date.parse('2026-11-01T00:00:00Z')

  it('#1741 bfl: every badge id is on the live page under the expected name', () => {
    const bfl = SERVICES.find((s) => s.id === 'bfl')!
    const names = new Map(BFL_PAGE.map((c) => [c.id, c.name]))
    expect(bfl.statusComponentIds!.map((id) => names.get(id))).toEqual([
      'API (api.bfl.ai)', 'Image Generation Services', 'Video Generation Services', 'API EU (api.eu.bfl.ai)', 'API US (api.us.bfl.ai)', 'Finetuning',
    ])
  })

  it('#1741 bfl: the live page yields no aged-in finding under the real config', () => {
    const bfl = SERVICES.find((s) => s.id === 'bfl')!
    const findings = rosterAgedInFindings(atlassianRosterEntries(BFL_PAGE), uptimeScopeOf(bfl), bfl.rosterAuditExclude ?? [], bfl.rosterAuditFixedScope ?? false, BFL_AGED)
    expect(findings).toEqual([])
  })

  it('#1741 bfl: the pre-#1741 scope reports every untracked top-level component, never a FLUX model', () => {
    const findings = rosterAgedInFindings(atlassianRosterEntries(BFL_PAGE), ['ws9rrzk6n2j7', 'm991l9z7y6jj'], [], true, BFL_AGED)
    expect(findings.sort()).toEqual(['8jg9v8zhstys', 'cw5sckn8002d', 'wb9xb021290k', 'x16d9nh49hch'])
  })
})
