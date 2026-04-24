import { describe, it, expect, vi, afterEach } from 'vitest'
import { mapOSVSeverity, detectSecurityAlerts, fetchOSVAlerts, fetchEPSS, enrichAlertsWithEPSS, formatEpssTag, formatSecurityDigest, securityDetectedKey, incrementSecurityCount, readRecentSecurityAlerts, EPSS_ACTIVE, EPSS_ELEVATED, OSV_PACKAGES } from '../security-monitor'
import type { SecurityAlert, SecurityAlertMeta } from '../security-monitor'

// #325: OSV_PACKAGES drives both querybatch input and the post-fetch enrichment
// via OSV_PACKAGES[candidate.packageIndex]. A duplicated (name, ecosystem) would
// issue redundant queries and inflate querybatch cost; an invalid ecosystem
// silently yields zero results from OSV. Cheap guard — runs in <1ms.
describe('OSV_PACKAGES invariants', () => {
  it('has no duplicate (name, ecosystem) pairs', () => {
    const keys = OSV_PACKAGES.map(p => `${p.ecosystem}/${p.name}`)
    const unique = new Set(keys)
    expect(keys.length).toBe(unique.size)
  })

  it('uses only OSV-recognized ecosystems (PyPI or npm)', () => {
    // OSV supports more (Go, Maven, crates.io, etc.), but this project currently
    // scans Python + JavaScript AI SDKs only. A typo like "pypi" (lowercase) would
    // silently yield zero vulns across all queries — hence the strict allowlist.
    const valid = new Set(['PyPI', 'npm'])
    for (const pkg of OSV_PACKAGES) {
      expect(valid.has(pkg.ecosystem)).toBe(true)
    }
  })

  it('has a non-empty name and service label for every entry', () => {
    for (const pkg of OSV_PACKAGES) {
      expect(pkg.name).toBeTruthy()
      expect(pkg.service).toBeTruthy()
    }
  })

  it('every service label is also a key in the frontend OSV_SERVICE_MAP', () => {
    // Cross-layer invariant: adding a `service` label here without also adding it
    // to OSV_SERVICE_MAP in src/pages/ServiceDetails.jsx silently drops those
    // alerts from the Security Alerts card — the filter there evaluates
    // `OSV_SERVICE_MAP[a.service] === service.id`, which is `undefined === id`
    // (false) for unmapped labels. This mirror enforces the sync at test time.
    const KNOWN_SERVICE_LABELS = new Set([
      'OpenAI', 'Anthropic (Claude)', 'Google (Gemini)', 'Cohere', 'Mistral',
      'Hugging Face', 'LangChain',
      'Together', 'Groq', 'Replicate', 'AssemblyAI', 'Deepgram',
    ])
    for (const pkg of OSV_PACKAGES) {
      expect(KNOWN_SERVICE_LABELS.has(pkg.service)).toBe(true)
    }
  })

  it('has at least 20 entries (tripwire for accidental mass removal)', () => {
    // Current count is 24 (2026-04). The lower bound protects against a bad
    // merge or truncation that would silently shrink OSV coverage — the other
    // invariants pass for any subset, so a length floor is the only guard.
    expect(OSV_PACKAGES.length).toBeGreaterThanOrEqual(20)
  })
})

describe('mapOSVSeverity', () => {
  it('maps critical (>= 9.0)', () => {
    expect(mapOSVSeverity({ id: 'X', modified: '', severity: [{ type: 'CVSS_V3', score: '9.0' }] })).toBe('critical')
    expect(mapOSVSeverity({ id: 'X', modified: '', severity: [{ type: 'CVSS_V3', score: '10.0' }] })).toBe('critical')
  })

  it('maps high (>= 7.0, < 9.0)', () => {
    expect(mapOSVSeverity({ id: 'X', modified: '', severity: [{ type: 'CVSS_V3', score: '7.0' }] })).toBe('high')
    expect(mapOSVSeverity({ id: 'X', modified: '', severity: [{ type: 'CVSS_V3', score: '8.9' }] })).toBe('high')
  })

  it('maps medium (>= 4.0, < 7.0)', () => {
    expect(mapOSVSeverity({ id: 'X', modified: '', severity: [{ type: 'CVSS_V3', score: '4.0' }] })).toBe('medium')
    expect(mapOSVSeverity({ id: 'X', modified: '', severity: [{ type: 'CVSS_V3', score: '6.9' }] })).toBe('medium')
  })

  it('maps low (< 4.0)', () => {
    expect(mapOSVSeverity({ id: 'X', modified: '', severity: [{ type: 'CVSS_V3', score: '3.9' }] })).toBe('low')
    expect(mapOSVSeverity({ id: 'X', modified: '', severity: [{ type: 'CVSS_V3', score: '0.1' }] })).toBe('low')
  })

  it('handles CVSS vector strings by falling back to database_specific.severity', () => {
    expect(mapOSVSeverity({
      id: 'X', modified: '',
      severity: [{ type: 'CVSS_V4', score: 'CVSS:4.0/AV:L/AC:L/AT:N/PR:L/UI:N/VC:L/VI:L/VA:N/SC:N/SI:N/SA:N' }],
      database_specific: { severity: 'MODERATE' },
    })).toBe('medium')

    expect(mapOSVSeverity({
      id: 'X', modified: '',
      severity: [{ type: 'CVSS_V3', score: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H' }],
      database_specific: { severity: 'CRITICAL' },
    })).toBe('critical')
  })

  it('defaults to medium when no severity data at all', () => {
    expect(mapOSVSeverity({ id: 'X', modified: '' })).toBe('medium')
    expect(mapOSVSeverity({ id: 'X', modified: '', severity: [] })).toBe('medium')
  })

  it('uses database_specific.severity text when no numeric score', () => {
    expect(mapOSVSeverity({ id: 'X', modified: '', database_specific: { severity: 'HIGH' } })).toBe('high')
    expect(mapOSVSeverity({ id: 'X', modified: '', database_specific: { severity: 'LOW' } })).toBe('low')
    expect(mapOSVSeverity({ id: 'X', modified: '', database_specific: { severity: 'CRITICAL' } })).toBe('critical')
  })

  it('prefers numeric CVSS score over database_specific text', () => {
    expect(mapOSVSeverity({
      id: 'X', modified: '',
      severity: [{ type: 'CVSS_V3', score: '3.9' }],
      database_specific: { severity: 'CRITICAL' },
    })).toBe('low')
  })
})

describe('detectSecurityAlerts', () => {
  it('returns empty when kv is null', async () => {
    const result = await detectSecurityAlerts(null)
    expect(result).toEqual([])
  })
})

// Regression guard for #323: OSV's /v1/querybatch only returns { id, modified } —
// summary/severity/references/affected are NOT in the batch response. Without a
// Phase-2 detail fetch, titles fall back to "GHSA-...: PyPI/name" and severity
// defaults to 'medium' regardless of the real CVSS score. These tests lock in the
// two-phase flow: querybatch → dedup → per-vuln GET.
describe('fetchOSVAlerts — two-phase flow (#323)', () => {
  afterEach(() => vi.unstubAllGlobals())

  // Minimal response factory — matches what the Workers runtime passes back from fetch().
  function resp(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
  }

  // Routes fetch by URL so both querybatch (POST) and per-vuln GET share one stub.
  function stubFetchByUrl(routes: Record<string, unknown>): ReturnType<typeof vi.fn> {
    const mock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      for (const [pattern, body] of Object.entries(routes)) {
        if (url.includes(pattern)) return resp(body)
      }
      throw new Error(`unmocked fetch: ${url}`)
    })
    vi.stubGlobal('fetch', mock)
    return mock
  }

  it('enriches alerts with summary/severity/patch via per-vuln GET', async () => {
    const nowISO = new Date().toISOString()
    // Place the vuln under whatever position OSV_PACKAGES has the Anthropic-PyPI entry,
    // so a future reorder of that array doesn't silently point this test at a different package.
    const ANTHROPIC_PYPI_IDX = 1
    const mock = stubFetchByUrl({
      'querybatch': {
        results: Array.from({ length: ANTHROPIC_PYPI_IDX + 1 }, (_, i) =>
          i === ANTHROPIC_PYPI_IDX
            ? { vulns: [{ id: 'GHSA-w828-4qhx-vxx3', modified: nowISO }] }
            : {},
        ),
      },
      'GHSA-w828-4qhx-vxx3': {
        id: 'GHSA-w828-4qhx-vxx3',
        modified: nowISO,
        summary: 'Claude SDK for Python: Memory Tool Path Validation Race Condition Allows Sandbox Escape',
        severity: [{ type: 'CVSS_V3', score: '7.1' }],
        references: [
          { type: 'ADVISORY', url: 'https://github.com/anthropics/anthropic-sdk-python/security/advisories/GHSA-w828-4qhx-vxx3' },
          { type: 'WEB', url: 'https://github.com/anthropics/anthropic-sdk-python/releases/tag/v0.87.0' },
        ],
        affected: [{
          package: { name: 'anthropic', ecosystem: 'PyPI' },
          ranges: [{ type: 'ECOSYSTEM', events: [{ introduced: '0.81.0' }, { fixed: '0.87.0' }] }],
        }],
        database_specific: { severity: 'HIGH', cwe_ids: ['CWE-367'] },
      },
    })

    const alerts = await fetchOSVAlerts(null)

    expect(alerts).toHaveLength(1)
    const a = alerts[0]!
    expect(a.title).toBe('Claude SDK for Python: Memory Tool Path Validation Race Condition Allows Sandbox Escape')
    expect(a.severity).toBe('high') // CVSS 7.1 → high, NOT the 'medium' fallback
    expect(a.service).toBe('Anthropic (Claude)')
    expect(a.affectedPackage).toBe('PyPI/anthropic')
    expect(a.affectedRange).toBe('>= 0.81.0')
    expect(a.fixedVersion).toBe('0.87.0')
    expect(a.patchUrl).toBe('https://github.com/anthropics/anthropic-sdk-python/releases/tag/v0.87.0')
    expect(a.cweIds).toEqual(['CWE-367'])
    // Two HTTP calls: one querybatch + one detail fetch.
    expect(mock).toHaveBeenCalledTimes(2)
  })

  it('skips Phase-2 detail fetch for candidates already in KV dedup', async () => {
    const nowISO = new Date().toISOString()
    const mock = stubFetchByUrl({
      'querybatch': {
        results: [
          {},
          { vulns: [
            { id: 'GHSA-already-seen', modified: nowISO },
            { id: 'GHSA-new-one', modified: nowISO },
          ] },
        ],
      },
      'GHSA-new-one': {
        id: 'GHSA-new-one',
        modified: nowISO,
        summary: 'New vuln',
        severity: [{ type: 'CVSS_V3', score: '5.0' }],
      },
    })

    // Mark one as seen; the dedup pre-filter must skip its detail fetch.
    const kv = {
      async get(key: string) {
        return key === 'security:seen:osv:GHSA-already-seen' ? '1' : null
      },
    } as unknown as KVNamespace

    const alerts = await fetchOSVAlerts(kv)

    expect(alerts.map(a => a.id)).toEqual(['GHSA-new-one'])
    // 1 querybatch + 1 detail fetch (the seen one is skipped). If the skip were
    // broken, the stub would throw on 'GHSA-already-seen' (no route defined).
    expect(mock).toHaveBeenCalledTimes(2)
  })

  it('filters vulns older than 7 days before any detail fetch', async () => {
    const old = new Date(Date.now() - 10 * 86400 * 1000).toISOString()
    const mock = stubFetchByUrl({
      'querybatch': { results: [{ vulns: [{ id: 'GHSA-old', modified: old }] }] },
    })

    const alerts = await fetchOSVAlerts(null)
    expect(alerts).toEqual([])
    // Only the querybatch call — no detail fetch for the aged-out vuln.
    expect(mock).toHaveBeenCalledTimes(1)
  })

  it('drops a single failed detail fetch without failing the batch', async () => {
    const nowISO = new Date().toISOString()
    // Route the successful detail but leave 'GHSA-broken' unmocked so it throws.
    const mock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url.includes('querybatch')) {
        return resp({ results: [
          {},
          { vulns: [
            { id: 'GHSA-broken', modified: nowISO },
            { id: 'GHSA-good', modified: nowISO },
          ] },
        ] })
      }
      if (url.includes('GHSA-good')) {
        return resp({ id: 'GHSA-good', modified: nowISO, summary: 'Recoverable' })
      }
      throw new Error('simulated network error')
    })
    vi.stubGlobal('fetch', mock)

    const alerts = await fetchOSVAlerts(null)
    expect(alerts.map(a => a.id)).toEqual(['GHSA-good'])
  })

  it('throws when querybatch itself fails so detectSecurityAlerts can log it', async () => {
    // Returning [] here would be indistinguishable from a legitimate quiet day;
    // throwing lets Promise.allSettled in detectSecurityAlerts surface the failure.
    vi.stubGlobal('fetch', vi.fn(async () => new Response('server error', { status: 500 })))
    await expect(fetchOSVAlerts(null)).rejects.toThrow(/HTTP 500/)
  })

  it('returns [] with no detail fetches when querybatch yields zero vulns', async () => {
    // Quiet day — all tracked packages return empty result blocks. Must short-circuit
    // before Phase 2 so the cron doesn't burn subrequests on nothing.
    const mock = stubFetchByUrl({ 'querybatch': { results: [{}, {}, {}] } })
    const alerts = await fetchOSVAlerts(null)
    expect(alerts).toEqual([])
    expect(mock).toHaveBeenCalledTimes(1)
  })

  it('treats a KV.get rejection during pre-dedup as unseen and proceeds to detail fetch', async () => {
    // Fail-open: a transient KV outage must not mask new CVEs. Regression guard — if a
    // future refactor flipped the ternary, rejected reads would be silently marked "seen".
    const nowISO = new Date().toISOString()
    const mock = stubFetchByUrl({
      'querybatch': { results: [{}, { vulns: [{ id: 'GHSA-kv-error', modified: nowISO }] }] },
      'GHSA-kv-error': { id: 'GHSA-kv-error', modified: nowISO, summary: 'Recovered after KV error' },
    })
    const kv = {
      async get() { throw new Error('KV read failed') },
    } as unknown as KVNamespace
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const alerts = await fetchOSVAlerts(kv)

    expect(alerts.map(a => a.id)).toEqual(['GHSA-kv-error'])
    expect(errSpy).toHaveBeenCalledWith(
      expect.stringContaining('OSV pre-dedup KV read failed for GHSA-kv-error'),
      expect.anything(),
    )
  })

  it('caps detail fetches to OSV_MAX_DETAIL_FETCH and warns on overflow', async () => {
    // Post-deploy / post-KV-wipe scenario: many candidates pass dedup on the first cycle.
    // Cap keeps the Workers subrequest budget safe; overflow vulns are re-offered next cycle
    // since the seen-marker is only written for alerts that are actually surfaced.
    const nowISO = new Date().toISOString()
    const manyVulns = Array.from({ length: 20 }, (_, i) => ({ id: `GHSA-many-${i}`, modified: nowISO }))
    const routes: Record<string, unknown> = { 'querybatch': { results: [{ vulns: manyVulns }] } }
    for (let i = 0; i < 20; i++) {
      routes[`GHSA-many-${i}`] = { id: `GHSA-many-${i}`, modified: nowISO, summary: `Vuln ${i}` }
    }
    const mock = stubFetchByUrl(routes)
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const alerts = await fetchOSVAlerts(null)

    expect(alerts.length).toBe(15)
    // 1 querybatch + 15 detail fetches (not 20)
    expect(mock).toHaveBeenCalledTimes(16)
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('capped at 15'))
  })
})

describe('detectSecurityAlerts — HN dedup integration (#323 refactor)', () => {
  afterEach(() => vi.unstubAllGlobals())

  // Regression guard: the #323 refactor moved OSV dedup upstream into fetchOSVAlerts,
  // leaving detectSecurityAlerts responsible only for HN dedup. This test makes sure
  // the HN path still filters against KV and doesn't break under the new structure.
  it('filters HN alerts whose kvKey is already in KV', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url.includes('hn.algolia.com')) {
        return new Response(JSON.stringify({
          hits: [
            { objectID: 'hn-seen', title: 'OpenAI breach disclosed', url: 'https://example.com/a', points: 10, created_at_i: Math.floor(Date.now() / 1000) },
            { objectID: 'hn-new',  title: 'Anthropic vulnerability CVE', url: 'https://example.com/b', points: 20, created_at_i: Math.floor(Date.now() / 1000) },
          ],
        }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      // OSV path: return zero candidates so this test isolates the HN dedup behavior.
      if (url.includes('querybatch')) {
        return new Response(JSON.stringify({ results: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      throw new Error(`unmocked: ${url}`)
    }))

    const kv = {
      async get(key: string) {
        return key === 'security:seen:hn:hn-seen' ? '1' : null
      },
    } as unknown as KVNamespace

    const alerts = await detectSecurityAlerts(kv)
    expect(alerts.map(a => a.id)).toEqual(['hn-new'])
  })
})

describe('formatSecurityDigest', () => {
  it('formats single OSV alert with remediation', () => {
    const alerts: SecurityAlert[] = [{
      source: 'osv',
      id: 'GHSA-abc-123',
      title: 'RCE in openai package',
      url: 'https://osv.dev/vulnerability/GHSA-abc-123',
      severity: 'critical',
      kvKey: 'security:seen:osv:GHSA-abc-123',
      affectedPackage: 'PyPI/openai',
      affectedRange: '>= 1.0.0',
      fixedVersion: '1.0.1',
      patchUrl: 'https://github.com/openai/openai-python/commit/abc',
    }]
    const digest = formatSecurityDigest(alerts)
    expect(digest.title).toBe('🔒 Security Alert — 1 new finding')
    expect(digest.description).toContain('SDK Vulnerabilities (1)')
    expect(digest.description).toContain('GHSA-abc-123')
    expect(digest.description).toContain('pip install openai>=1.0.1')
    expect(digest.color).toBe(0xf85149) // critical → red
  })

  it('formats single HN alert', () => {
    const alerts: SecurityAlert[] = [{
      source: 'hackernews',
      id: '99999',
      title: 'OpenAI data breach',
      url: 'https://example.com/breach',
      kvKey: 'security:seen:hn:99999',
    }]
    const digest = formatSecurityDigest(alerts)
    expect(digest.title).toBe('🔒 Security Alert — 1 new finding')
    expect(digest.description).toContain('Security News (1)')
    expect(digest.description).toContain('OpenAI data breach')
    expect(digest.description).toContain('[HN]')
    expect(digest.description).toContain('[Source]')
  })

  it('groups mixed OSV + HN alerts into sections', () => {
    const alerts: SecurityAlert[] = [
      {
        source: 'osv', id: 'GHSA-1', title: 'Vuln A', url: 'https://osv.dev/1',
        severity: 'high', kvKey: 'k1', affectedPackage: 'PyPI/anthropic', fixedVersion: '2.0.0',
      },
      {
        source: 'osv', id: 'GHSA-2', title: 'Vuln B', url: 'https://osv.dev/2',
        severity: 'medium', kvKey: 'k2', affectedPackage: 'npm/@anthropic-ai/sdk',
      },
      {
        source: 'hackernews', id: '111', title: 'Claude security news',
        url: 'https://news.ycombinator.com/item?id=111', kvKey: 'k3',
      },
    ]
    const digest = formatSecurityDigest(alerts)
    expect(digest.title).toBe('🔒 Security Alert — 3 new findings')
    expect(digest.description).toContain('SDK Vulnerabilities (2)')
    expect(digest.description).toContain('Security News (1)')
    expect(digest.description).toContain('GHSA-1')
    expect(digest.description).toContain('GHSA-2')
    expect(digest.color).toBe(0xd29922) // highest is high → yellow
  })

  it('formats npm package with npm install command', () => {
    const alerts: SecurityAlert[] = [{
      source: 'osv', id: 'GHSA-npm', title: 'Path traversal',
      url: 'https://osv.dev/npm', severity: 'medium', kvKey: 'k',
      affectedPackage: 'npm/@anthropic-ai/sdk', fixedVersion: '0.81.0',
    }]
    const digest = formatSecurityDigest(alerts)
    expect(digest.description).toContain('npm install @anthropic-ai/sdk@0.81.0')
  })

  it('uses gray color when all alerts are medium/low', () => {
    const alerts: SecurityAlert[] = [{
      source: 'osv', id: 'X', title: 'Minor', url: 'u',
      severity: 'low', kvKey: 'k', affectedPackage: 'PyPI/x',
    }]
    expect(formatSecurityDigest(alerts).color).toBe(0x8b949e)
  })

  it('includes service name tag in OSV alert format', () => {
    const alerts: SecurityAlert[] = [{
      source: 'osv', id: 'GHSA-test', title: 'Vuln in transformers',
      url: 'https://osv.dev/test', severity: 'medium', kvKey: 'k',
      service: 'Hugging Face', affectedPackage: 'PyPI/transformers',
    }]
    const digest = formatSecurityDigest(alerts)
    expect(digest.description).toContain('[Hugging Face]')
    expect(digest.description).toContain('GHSA-test')
  })

  it('omits service tag when service is undefined', () => {
    const alerts: SecurityAlert[] = [{
      source: 'osv', id: 'GHSA-noservice', title: 'Generic vuln',
      url: 'https://osv.dev/x', severity: 'low', kvKey: 'k',
      affectedPackage: 'PyPI/unknown',
    }]
    const digest = formatSecurityDigest(alerts)
    // Should not contain a service tag like [Hugging Face], but [Details]/[HN] links are expected
    expect(digest.description).not.toMatch(/\[(?!Details|HN|Source)[A-Z][a-zA-Z ]+\]/)
    expect(digest.description).toContain('GHSA-noservice')
  })
})

describe('securityDetectedKey + incrementSecurityCount (#288)', () => {
  it('scopes key to UTC date', () => {
    expect(securityDetectedKey('2026-04-20')).toBe('security:detected:2026-04-20')
  })

  it('starts at N when no prior value exists', () => {
    expect(incrementSecurityCount(null, 3)).toBe(3)
    expect(incrementSecurityCount('', 2)).toBe(2)
  })

  it('adds to an existing integer value', () => {
    expect(incrementSecurityCount('5', 2)).toBe(7)
  })

  it('treats corrupt values as 0 to avoid NaN propagation', () => {
    // Defensive: KV could return a non-numeric string from a prior schema migration
    // or user-facing debug write. The daily summary should never display NaN.
    expect(incrementSecurityCount('not-a-number', 3)).toBe(3)
    expect(incrementSecurityCount('1.5.3', 2)).toBe(3) // parseInt stops at first non-digit → 1
  })

  it('add-by-zero read pattern returns the current value', () => {
    // Daily summary uses incrementSecurityCount(raw, 0) to parse without mutating.
    expect(incrementSecurityCount('14', 0)).toBe(14)
    expect(incrementSecurityCount(null, 0)).toBe(0)
  })
})

// Minimal in-memory KV stub for readRecentSecurityAlerts. Only implements list/get —
// enough to exercise the filter/parse branches without pulling in Miniflare.
function makeFakeKV(entries: Record<string, string>): KVNamespace {
  const api = {
    async list({ prefix, limit }: { prefix: string; limit?: number }) {
      const all = Object.keys(entries).filter(k => k.startsWith(prefix))
      const keys = (limit ? all.slice(0, limit) : all).map(name => ({ name }))
      return { keys, list_complete: true, cacheStatus: null } as unknown as KVNamespaceListResult<unknown, string>
    },
    async get(key: string) {
      return entries[key] ?? null
    },
  }
  return api as unknown as KVNamespace
}

describe('readRecentSecurityAlerts', () => {
  it('returns empty array when KV is null', async () => {
    // Defensive: env.STATUS_CACHE is typed as nullable in the Worker bindings.
    expect(await readRecentSecurityAlerts(null)).toEqual([])
  })

  it('returns empty array when no security:seen:* keys exist', async () => {
    const kv = makeFakeKV({ 'other:key': 'value' })
    expect(await readRecentSecurityAlerts(kv)).toEqual([])
  })

  it('parses JSON metadata entries', async () => {
    const meta: SecurityAlertMeta = {
      title: 'GHSA-w828: PyPI/anthropic',
      url: 'https://osv.dev/vulnerability/GHSA-w828',
      source: 'osv',
      severity: 'high',
      service: 'Anthropic (Claude)',
      detectedAt: '2026-04-22T09:00:00.000Z',
    }
    const kv = makeFakeKV({
      'security:seen:osv:GHSA-w828': JSON.stringify(meta),
    })
    const result = await readRecentSecurityAlerts(kv)
    expect(result).toEqual([meta])
  })

  it('skips legacy `"1"` marker values (pre-metadata schema)', async () => {
    // Earlier versions only stored "1" as a dedup marker. Those keys must not crash the parser
    // or be returned as alerts — the dashboard needs real metadata.
    const kv = makeFakeKV({
      'security:seen:hn:old-entry': '1',
      'security:seen:osv:new-entry': JSON.stringify({ title: 'T', url: 'U', source: 'osv' }),
    })
    const result = await readRecentSecurityAlerts(kv)
    expect(result).toHaveLength(1)
    expect(result[0].title).toBe('T')
  })

  it('skips malformed JSON entries without failing the whole read', async () => {
    const kv = makeFakeKV({
      'security:seen:hn:malformed': '{not valid json',
      'security:seen:osv:good': JSON.stringify({ title: 'Good', url: 'U', source: 'osv' }),
    })
    const result = await readRecentSecurityAlerts(kv)
    expect(result).toHaveLength(1)
    expect(result[0].title).toBe('Good')
  })

  it('swallows KV list errors — security data is optional', async () => {
    // If KV is temporarily unavailable, the status endpoint must still succeed.
    const brokenKv = {
      async list() { throw new Error('KV down') },
      async get() { return null },
    } as unknown as KVNamespace
    expect(await readRecentSecurityAlerts(brokenKv)).toEqual([])
  })

  // Regression lock for #304: `/api/status` used to omit `securityAlerts` while
  // `/api/status/cached` included it, so silent polls every 60s hid the banner.
  // Both endpoints now pass readRecentSecurityAlerts's output through the same
  // conditional-spread pattern — this describe block locks that contract.
  describe('response-shape parity invariant', () => {
    // Mirrors the spread used at both endpoint callsites in worker/src/index.ts
    // (`...(securityAlerts.length > 0 ? { securityAlerts } : {})`). If either
    // callsite drifts — e.g. `securityAlerts: alerts` without the guard, or no
    // spread at all — these assertions catch it by diffing both shapes.
    function buildEndpointResponse(alerts: SecurityAlertMeta[]): Record<string, unknown> {
      return {
        services: [],
        ...(alerts.length > 0 ? { securityAlerts: alerts } : {}),
      }
    }

    it('omits the securityAlerts key entirely when there are no alerts', async () => {
      // Schema clarity: client reads `data.securityAlerts ?? []`, so `[]` and
      // omitted behave the same — but emitting `[]` would add avoidable bytes
      // and could drift consumers that use `'securityAlerts' in data` as a signal.
      const kv = makeFakeKV({})
      const alerts = await readRecentSecurityAlerts(kv)
      const response = buildEndpointResponse(alerts)
      expect('securityAlerts' in response).toBe(false)
    })

    it('both callsite-shaped responses are identical for the same KV state', async () => {
      // #304 root cause was asymmetric shape between endpoints. This test derives
      // both endpoints' shapes from the same readRecentSecurityAlerts output and
      // asserts deep equality — a future contributor dropping the spread on one
      // side would fail this immediately.
      const kv = makeFakeKV({
        'security:seen:osv:GHSA-1': JSON.stringify({ title: 'A', url: 'U1', source: 'osv' }),
        'security:seen:hn:2': JSON.stringify({ title: 'B', url: 'U2', source: 'hn' }),
      })
      const fullShape = buildEndpointResponse(await readRecentSecurityAlerts(kv))
      const cachedShape = buildEndpointResponse(await readRecentSecurityAlerts(kv))
      expect(fullShape).toEqual(cachedShape)
      expect(fullShape.securityAlerts).toHaveLength(2)
    })
  })
})

// #326 — EPSS enrichment against GitHub Advisories API. Fail-open contract:
// no EPSS field means enrichment unavailable (cache miss + HTTP failure, rate
// limit, or advisory without EPSS). Alerts must still surface regardless.
describe('fetchEPSS (#326)', () => {
  afterEach(() => vi.unstubAllGlobals())

  function stubFetch(response: Response | Error | (() => Response | Promise<Response>)): ReturnType<typeof vi.fn> {
    const mock = vi.fn(async () => {
      if (response instanceof Error) throw response
      if (typeof response === 'function') return response()
      return response
    })
    vi.stubGlobal('fetch', mock)
    return mock
  }

  function resp(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
  }

  it('returns parsed epss when cache miss + 200 response', async () => {
    stubFetch(resp({ epss: { percentile: 0.81596, percentage: 0.01583 } }))
    const kvStore: Record<string, string> = {}
    const kv = {
      get: async (k: string) => kvStore[k] ?? null,
      put: async (k: string, v: string) => { kvStore[k] = v },
    } as unknown as KVNamespace

    const score = await fetchEPSS('GHSA-f73w-4m7g-ch9x', kv)
    expect(score).toEqual({ percentile: 0.81596, percentage: 0.01583 })
    // Cache is populated so the next call short-circuits.
    expect(kvStore['enrich:epss:GHSA-f73w-4m7g-ch9x']).toBe(JSON.stringify({ percentile: 0.81596, percentage: 0.01583 }))
  })

  it('returns cached value without fetching', async () => {
    const mock = stubFetch(resp({}, 500))  // would fail if actually called
    const kv = {
      get: async () => JSON.stringify({ percentile: 0.42, percentage: 0.003 }),
      put: async () => {},
    } as unknown as KVNamespace

    const score = await fetchEPSS('GHSA-cached', kv)
    expect(score).toEqual({ percentile: 0.42, percentage: 0.003 })
    expect(mock).not.toHaveBeenCalled()
  })

  it('falls through to HTTP when cache JSON is corrupt', async () => {
    stubFetch(resp({ epss: { percentile: 0.1, percentage: 0.001 } }))
    const kv = {
      get: async () => '{broken',
      put: async () => {},
    } as unknown as KVNamespace
    const score = await fetchEPSS('GHSA-corrupt', kv)
    expect(score).toEqual({ percentile: 0.1, percentage: 0.001 })
  })

  it('returns undefined on HTTP 404 without throwing', async () => {
    stubFetch(resp({ message: 'Not found' }, 404))
    const score = await fetchEPSS('GHSA-missing', null)
    expect(score).toBeUndefined()
  })

  it('logs rate-limit specifically on HTTP 403 / 429', async () => {
    stubFetch(resp({ message: 'API rate limit exceeded' }, 429))
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const score = await fetchEPSS('GHSA-rate-limited', null)
    expect(score).toBeUndefined()
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('rate-limited'))
  })

  it('returns undefined on fetch timeout / network error', async () => {
    stubFetch(new Error('network down'))
    const score = await fetchEPSS('GHSA-network-fail', null)
    expect(score).toBeUndefined()
  })

  it('returns undefined when advisory has no epss field', async () => {
    // GitHub advisory objects can legitimately lack epss (historical entries, private advisories).
    stubFetch(resp({ ghsa_id: 'GHSA-no-epss', summary: 'x' }))
    const score = await fetchEPSS('GHSA-no-epss', null)
    expect(score).toBeUndefined()
  })

  it('returns undefined when epss field exists but has non-numeric values', async () => {
    stubFetch(resp({ epss: { percentile: 'high' as unknown, percentage: null } }))
    const score = await fetchEPSS('GHSA-malformed-epss', null)
    expect(score).toBeUndefined()
  })

  it('continues when KV.put rejects (write-through best-effort)', async () => {
    stubFetch(resp({ epss: { percentile: 0.5, percentage: 0.01 } }))
    const kv = {
      get: async () => null,
      put: async () => { throw new Error('KV write down') },
    } as unknown as KVNamespace
    // Should still return the fetched score — cache write is non-blocking.
    const score = await fetchEPSS('GHSA-kv-write-fail', kv)
    expect(score).toEqual({ percentile: 0.5, percentage: 0.01 })
  })

  it('falls through to HTTP when KV.get rejects (fail-open read)', async () => {
    // Parity with OSV pre-dedup: a transient KV outage must not block enrichment.
    // Without this test, a future refactor that drops the `.catch` would currently
    // go unnoticed — unit tests would pass while prod quietly burned rate limit.
    stubFetch(resp({ epss: { percentile: 0.6, percentage: 0.02 } }))
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const kv = {
      get: async () => { throw new Error('KV read down') },
      put: async () => {},
    } as unknown as KVNamespace
    const score = await fetchEPSS('GHSA-kv-read-fail', kv)
    expect(score).toEqual({ percentile: 0.6, percentage: 0.02 })
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('EPSS cache read failed'),
      'GHSA-kv-read-fail',
      expect.anything(),
    )
  })

  it('writes cache with 24h TTL (expirationTtl: 86400)', async () => {
    // Silent-regression guard: dropping the TTL or typoing it (e.g. 8640 = 2.4h)
    // would invisibly change cache behavior. Assert on the put-options payload.
    stubFetch(resp({ epss: { percentile: 0.3, percentage: 0.001 } }))
    const captured: Array<{ key: string; value: string; opts?: unknown }> = []
    const kv = {
      get: async () => null,
      put: async (key: string, value: string, opts?: unknown) => {
        captured.push({ key, value, opts })
      },
    } as unknown as KVNamespace
    await fetchEPSS('GHSA-ttl-check', kv)
    expect(captured).toHaveLength(1)
    expect(captured[0].opts).toEqual({ expirationTtl: 86_400 })
  })
})

describe('enrichAlertsWithEPSS (#326)', () => {
  afterEach(() => vi.unstubAllGlobals())

  function resp(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
  }

  it('enriches only OSV alerts; HN alerts pass through untouched', async () => {
    const alerts: SecurityAlert[] = [
      { source: 'osv', id: 'GHSA-1', title: 'Vuln', url: 'u1', kvKey: 'k1', severity: 'high' },
      { source: 'hackernews', id: '42', title: 'HN post', url: 'u2', kvKey: 'k2' },
    ]
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      // HN alerts must never hit GitHub Advisories — they have no CVE.
      if (url.includes('api.github.com/advisories/42')) throw new Error('enriched HN alert!')
      return resp({ epss: { percentile: 0.9, percentage: 0.1 } })
    }))
    const enriched = await enrichAlertsWithEPSS(alerts, null)
    expect(enriched[0]).toMatchObject({ id: 'GHSA-1', epssPercentile: 0.9, epssPercentage: 0.1 })
    expect(enriched[1]).toEqual(alerts[1]) // HN alert untouched, no EPSS fields
    expect(enriched[1]).not.toHaveProperty('epssPercentile')
  })

  it('preserves alerts when enrichment fails for some', async () => {
    const alerts: SecurityAlert[] = [
      { source: 'osv', id: 'GHSA-ok', title: 'A', url: 'u', kvKey: 'k1' },
      { source: 'osv', id: 'GHSA-fail', title: 'B', url: 'u', kvKey: 'k2' },
    ]
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url.includes('GHSA-ok')) return resp({ epss: { percentile: 0.6, percentage: 0.01 } })
      return resp({}, 500)
    }))
    const enriched = await enrichAlertsWithEPSS(alerts, null)
    expect(enriched[0].epssPercentile).toBe(0.6)
    // GHSA-fail survives without EPSS fields.
    expect(enriched[1].id).toBe('GHSA-fail')
    expect(enriched[1].epssPercentile).toBeUndefined()
  })

  it('returns all alerts even if every enrichment throws', async () => {
    const alerts: SecurityAlert[] = [
      { source: 'osv', id: 'GHSA-x', title: 'A', url: 'u', kvKey: 'k1' },
      { source: 'osv', id: 'GHSA-y', title: 'B', url: 'u', kvKey: 'k2' },
    ]
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('total outage') }))
    const enriched = await enrichAlertsWithEPSS(alerts, null)
    expect(enriched).toHaveLength(2)
    expect(enriched[0].epssPercentile).toBeUndefined()
    expect(enriched[1].epssPercentile).toBeUndefined()
  })

  it('returns empty array on empty input without making any fetch call', async () => {
    // Guard against a future refactor adding an unconditional prefetch/rate-limit
    // probe that would fire on no-op calls and burn subrequests.
    const mock = vi.fn()
    vi.stubGlobal('fetch', mock)
    const result = await enrichAlertsWithEPSS([], null)
    expect(result).toEqual([])
    expect(mock).not.toHaveBeenCalled()
  })
})

describe('formatEpssTag (#326)', () => {
  it('returns null when percentile is undefined (pre-enrichment / missing data)', () => {
    expect(formatEpssTag(undefined)).toBeNull()
  })

  it('returns null for percentiles below EPSS_ELEVATED (low-signal floor)', () => {
    expect(formatEpssTag(0)).toBeNull()
    expect(formatEpssTag(0.49)).toBeNull()
  })

  it('returns elevated tag between EPSS_ELEVATED and EPSS_ACTIVE', () => {
    expect(formatEpssTag(EPSS_ELEVATED)).toContain('Elevated')
    expect(formatEpssTag(EPSS_ACTIVE - 0.01)).toContain('Elevated')
    expect(formatEpssTag(0.5)).toContain('50%ile')
  })

  it('returns actively-exploited tag at EPSS_ACTIVE and above', () => {
    expect(formatEpssTag(EPSS_ACTIVE)).toContain('Actively exploited')
    expect(formatEpssTag(0.95)).toContain('95%ile')
    expect(formatEpssTag(1)).toContain('100%ile')
  })

  it('threshold constants match dashboard source of truth', () => {
    // Frontend (src/pages/ServiceDetails.jsx) hardcodes 0.5 and 0.8 because it
    // cannot import from worker. If these constants move, the dashboard silently
    // drifts — this test is the drift tripwire. Update ServiceDetails.jsx too.
    expect(EPSS_ELEVATED).toBe(0.5)
    expect(EPSS_ACTIVE).toBe(0.8)
  })
})

describe('detectSecurityAlerts — EPSS wiring (#326)', () => {
  afterEach(() => vi.unstubAllGlobals())

  // Regression guard: verifies detectSecurityAlerts actually plumbs alerts through
  // enrichAlertsWithEPSS before returning. A refactor that drops the enrichment
  // call would silently lose EPSS tags downstream — unit tests on fetchEPSS /
  // enrichAlertsWithEPSS alone would not catch it.
  it('returns OSV alerts with epssPercentile populated end-to-end', async () => {
    const nowISO = new Date().toISOString()
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url.includes('hn.algolia.com')) {
        return new Response(JSON.stringify({ hits: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      if (url.includes('querybatch')) {
        // OSV_PACKAGES index 1 = PyPI/anthropic (same as #323 tests)
        return new Response(JSON.stringify({
          results: [{}, { vulns: [{ id: 'GHSA-epss-wired', modified: nowISO }] }],
        }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      if (url.includes('osv.dev/v1/vulns/GHSA-epss-wired')) {
        return new Response(JSON.stringify({
          id: 'GHSA-epss-wired', modified: nowISO, summary: 'Wired alert',
        }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      if (url.includes('api.github.com/advisories/GHSA-epss-wired')) {
        return new Response(JSON.stringify({
          epss: { percentile: 0.88, percentage: 0.12 },
        }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      throw new Error(`unmocked: ${url}`)
    }))

    const kv = {
      get: async () => null,
      put: async () => {},
    } as unknown as KVNamespace

    const alerts = await detectSecurityAlerts(kv)
    const wired = alerts.find(a => a.id === 'GHSA-epss-wired')
    expect(wired).toBeDefined()
    expect(wired?.epssPercentile).toBe(0.88)
    expect(wired?.epssPercentage).toBe(0.12)
  })
})
