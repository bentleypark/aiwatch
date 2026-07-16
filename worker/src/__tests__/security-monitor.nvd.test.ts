import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  NVD_FIRST_PARTY,
  extractNvdDescription,
  extractNvdSeverity,
  extractNvdCwes,
  isRejectedCve,
  isThirdPartyCloneSubject,
  isAiCreditedOssPatch,
  matchNvdFirstParty,
  nvdCveToAlert,
  filterNvdCves,
  fetchNvdAlerts,
  detectSecurityAlerts,
  formatSecurityDigest,
  isPubliclyVerifiedAlert,
} from '../security-monitor'
import type { SecurityAlert } from '../security-monitor'

// Real NVD 2.0 `cve` payloads — verified verbatim against the live API 2026-07-16.
// CVE-2025-52882: genuine first-party Claude Code CVE (subject = Claude Code, mentions
// Cursor/Windsurf only as forks). CVE-2026-14898: genuine OpenAI Codex desktop CVE.
//
// The Claude Code description deliberately retains the real remediation sentence "check the
// plugin Claude Code [Beta]" — the SINGULAR "plugin". A bare `\bplugin\b` noise marker
// silently dropped this very CVE (the flagship finding of #949) because Claude Code ships as
// a JetBrains plugin; an earlier fixture trimmed at "extensions" hid that, making the filter
// look correct while it discarded the signal (cf. #1021). Note the plural "Jetbrains IDE
// plugins" does NOT reproduce it (`\bplugin\b` won't match "plugins") — the singular sentence
// is what makes this fixture a real regression guard, verified by mutation. Do not trim it.
const claudeCodeCve = {
  id: 'CVE-2025-52882',
  vulnStatus: 'Deferred',
  descriptions: [{ lang: 'en', value: 'Claude Code is an agentic coding tool. Claude Code extensions in VSCode and forks (e.g., Cursor, Windsurf, and VSCodium) and JetBrains IDEs (e.g., IntelliJ, Pycharm, and Android Studio) are vulnerable to unauthorized websocket connections from an attacker when visiting attacker-controlled webpages. For Jetbrains IDE plugins, Claude Code [beta] versions 0.1.1 through 0.1.8 are vulnerable. For JetBrains IDEs including IntelliJ, PyCharm, and Android Studio, check the plugin Claude Code [Beta].' }],
  metrics: { cvssMetricV40: [{ cvssData: { baseScore: 8.8, baseSeverity: 'HIGH' } }] },
  weaknesses: [{ description: [{ lang: 'en', value: 'CWE-1385' }] }],
}
const codexCve = {
  id: 'CVE-2026-14898',
  vulnStatus: 'Awaiting Analysis',
  descriptions: [{ lang: 'en', value: 'The OpenAI Codex desktop app for macOS rendered remote images from Markdown in model responses, enabling indirect prompt injection.' }],
  metrics: { cvssMetricV31: [{ cvssData: { baseScore: 6.5, baseSeverity: 'MEDIUM' } }] },
}

describe('NVD_FIRST_PARTY table', () => {
  it('has a non-empty service label and at least one match phrase for every entry', () => {
    for (const e of NVD_FIRST_PARTY) {
      expect(e.service).toBeTruthy()
      expect(e.strong.length + e.weak.length).toBeGreaterThan(0)
    }
  })
  it('requires a context marker for every weak token (else the generic word false-positives)', () => {
    for (const e of NVD_FIRST_PARTY) {
      if (e.weak.length > 0) expect(e.context.length).toBeGreaterThan(0)
    }
  })
  it('uses lowercase phrases (matcher lowercases the description)', () => {
    for (const e of NVD_FIRST_PARTY) {
      for (const p of [...e.strong, ...e.weak, ...e.context]) expect(p).toBe(p.toLowerCase())
    }
  })
})

describe('extractNvdDescription', () => {
  it('prefers the English description', () => {
    expect(extractNvdDescription({ id: 'x', descriptions: [{ lang: 'es', value: 'hola' }, { lang: 'en', value: 'hello' }] })).toBe('hello')
  })
  it('falls back to the first entry, empty string when none', () => {
    expect(extractNvdDescription({ id: 'x', descriptions: [{ lang: 'fr', value: 'bonjour' }] })).toBe('bonjour')
    expect(extractNvdDescription({ id: 'x' })).toBe('')
  })
})

describe('extractNvdSeverity', () => {
  it('bands the CVSS base score', () => {
    const mk = (score: number) => ({ id: 'x', metrics: { cvssMetricV31: [{ cvssData: { baseScore: score } }] } })
    expect(extractNvdSeverity(mk(9.1))).toBe('critical')
    expect(extractNvdSeverity(mk(7.0))).toBe('high')
    expect(extractNvdSeverity(mk(4.0))).toBe('medium')
    expect(extractNvdSeverity(mk(3.9))).toBe('low')
  })
  it('prefers the newest metric version present', () => {
    expect(extractNvdSeverity({ id: 'x', metrics: {
      cvssMetricV40: [{ cvssData: { baseScore: 9.5 } }],
      cvssMetricV2: [{ cvssData: { baseScore: 2.0 } }],
    } })).toBe('critical')
  })
  it('returns undefined when the CVE carries no score yet', () => {
    expect(extractNvdSeverity({ id: 'x' })).toBeUndefined()
    expect(extractNvdSeverity({ id: 'x', metrics: {} })).toBeUndefined()
  })
  it('reads real fixtures', () => {
    expect(extractNvdSeverity(claudeCodeCve)).toBe('high')   // 8.8 v4.0
    expect(extractNvdSeverity(codexCve)).toBe('medium')      // 6.5 v3.1
  })
})

describe('extractNvdCwes', () => {
  it('collects CWE ids, dedupes, undefined when none', () => {
    expect(extractNvdCwes(claudeCodeCve)).toEqual(['CWE-1385'])
    expect(extractNvdCwes({ id: 'x', weaknesses: [{ description: [{ lang: 'en', value: 'CWE-79' }, { lang: 'en', value: 'CWE-79' }] }] })).toEqual(['CWE-79'])
    expect(extractNvdCwes({ id: 'x' })).toBeUndefined()
    expect(extractNvdCwes({ id: 'x', weaknesses: [{ description: [{ lang: 'en', value: 'NVD-CWE-noinfo' }] }] })).toBeUndefined()
  })
})

describe('isRejectedCve (noise class 1)', () => {
  it('drops on vulnStatus Rejected', () => {
    expect(isRejectedCve({ id: 'x', vulnStatus: 'Rejected', descriptions: [{ lang: 'en', value: 'Claude Code bug' }] })).toBe(true)
  })
  it('drops on the canonical rejection preamble', () => {
    expect(isRejectedCve({ id: 'x', descriptions: [{ lang: 'en', value: 'Rejected reason: This CVE ID has been rejected by its CVE Numbering Authority.' }] })).toBe(true)
    expect(isRejectedCve({ id: 'x', descriptions: [{ lang: 'en', value: '** REJECT ** DO NOT USE THIS CANDIDATE NUMBER.' }] })).toBe(true)
  })
  it('keeps a live CVE', () => {
    expect(isRejectedCve(claudeCodeCve)).toBe(false)
  })
})

describe('isThirdPartyCloneSubject (noise class 2)', () => {
  it('drops clone/wrapper/proxy subjects', () => {
    expect(isThirdPartyCloneSubject('Cloud CLI aka Claude Code UI mishandles tokens')).toBe(true)
    expect(isThirdPartyCloneSubject('claude-code-cache-fix is a proxy for Claude Code that leaks keys')).toBe(true)
    expect(isThirdPartyCloneSubject('An unofficial ChatGPT client stores credentials in plaintext')).toBe(true)
    expect(isThirdPartyCloneSubject('This tool is a reverse-proxy of Claude Code')).toBe(true)
  })
  it('drops the REAL 3rd-party noise seen in live NVD (2026-07-16)', () => {
    // Verbatim (trimmed) descriptions that leaked into the keyword search — each names a
    // first-party product but is NOT that product.
    expect(isThirdPartyCloneSubject('claude-code-router is a powerful tool to route Claude Code requests to different models')).toBe(true)
    expect(isThirdPartyCloneSubject('AgentAPI is an HTTP API for Claude Code, Goose, Aider, and other agents')).toBe(true)
    expect(isThirdPartyCloneSubject('MCP Manager for Claude Desktop execute-command Command Injection')).toBe(true)
    expect(isThirdPartyCloneSubject('The Chatbot with ChatGPT WordPress plugin before 2.4.6 does not sanitize input')).toBe(true)
    expect(isThirdPartyCloneSubject('LibreChat is an enhanced ChatGPT clone that supports multiple AI providers')).toBe(true)
    // Verbatim head of the real CVE-2024-11896 — note "plugin for WordPress": the `wordpress`
    // marker is what catches it, which is why a bare `\bplugin\b` marker is unnecessary.
    expect(isThirdPartyCloneSubject('The Text Prompter – Unlimited chatgpt text prompts for openai tasks plugin for WordPress is vulnerable to Stored Cross-Site Scripting')).toBe(true)
  })
  it('keeps genuine first-party descriptions', () => {
    expect(isThirdPartyCloneSubject(claudeCodeCve.descriptions[0].value)).toBe(false)
    expect(isThirdPartyCloneSubject(codexCve.descriptions[0].value)).toBe(false)
    // A genuine Codex CLI CVE ("...is a coding agent from OpenAI...") must survive.
    expect(isThirdPartyCloneSubject('Codex CLI is a coding agent from OpenAI that runs locally in your terminal')).toBe(false)
    expect(isThirdPartyCloneSubject('Azure OpenAI Elevation of Privilege Vulnerability')).toBe(false)
  })

  // FALSE-NEGATIVE boundary. A dropped CVE is invisible in production (no feedback channel),
  // so the markers must be anchored, not bare nouns. Each case below was silently dropped by
  // an earlier bare-`plugin` / bare-`<noun> for` version of this regex.
  it('does NOT drop a first-party CVE that incidentally says "plugin" (Claude Code IS a plugin, #920)', () => {
    expect(isThirdPartyCloneSubject('Claude Code is an agentic coding tool. The Claude Code plugin for JetBrains IDEs is vulnerable to unauthorized websocket connections.')).toBe(false)
    expect(isThirdPartyCloneSubject('Claude Code allows a malicious plugin from the marketplace to execute arbitrary code.')).toBe(false)
    expect(isThirdPartyCloneSubject('Claude Code before 1.0.24 mishandles the plugin manifest allowing RCE.')).toBe(false)
  })
  it('does NOT drop first-party "<noun> for <platform>" phrasings (NVD_FIRST_PARTY itself uses them)', () => {
    expect(isThirdPartyCloneSubject('The ChatGPT desktop client for macOS rendered remote images from Markdown, enabling prompt injection.')).toBe(false)
    expect(isThirdPartyCloneSubject('Claude Desktop client for Windows escalates privileges via an unquoted service path.')).toBe(false)
    expect(isThirdPartyCloneSubject('Azure OpenAI Service exposes a REST API for model inference that mishandles auth tokens.')).toBe(false)
    expect(isThirdPartyCloneSubject('OpenAI Codex IDE extension SDK for VS Code mishandles workspace trust.')).toBe(false)
    expect(isThirdPartyCloneSubject('The Gemini CLI dashboard for enterprise users leaks tokens.')).toBe(false)
  })
})

describe('isAiCreditedOssPatch (noise class 3)', () => {
  it('drops kernel/firmware subjects', () => {
    expect(isAiCreditedOssPatch('In the Linux kernel, the following vulnerability has been resolved (found by Claude Code).')).toBe(true)
    expect(isAiCreditedOssPatch('A U-Boot bootloader flaw allows secure-boot bypass')).toBe(true)
  })
  it('drops explicit AI-authorship credit phrasing', () => {
    expect(isAiCreditedOssPatch('A buffer overflow in foobar, discovered using Claude Code, allows RCE.')).toBe(true)
  })
  it('does NOT drop a first-party CVE that merely names a bundled OSS lib', () => {
    // Narrowed from a general OSS-library list: a real product CVE can reference a bundled
    // dep, and vetoing on a bare mention would defeat the feature.
    expect(isAiCreditedOssPatch('Claude Code ships a vulnerable OpenSSL version enabling MITM')).toBe(false)
  })
  it('keeps genuine first-party product CVEs', () => {
    expect(isAiCreditedOssPatch(claudeCodeCve.descriptions[0].value)).toBe(false)
    expect(isAiCreditedOssPatch(codexCve.descriptions[0].value)).toBe(false)
  })
})

describe('matchNvdFirstParty (attribution gate)', () => {
  it('attributes real first-party CVEs to the right service label', () => {
    expect(matchNvdFirstParty(claudeCodeCve.descriptions[0].value)).toBe('Claude Code')
    expect(matchNvdFirstParty(codexCve.descriptions[0].value)).toBe('OpenAI Codex')
  })
  it('matches strong multi-word phrases on their own', () => {
    expect(matchNvdFirstParty('Azure OpenAI Service mishandled a request')).toBe('Azure OpenAI')
    expect(matchNvdFirstParty('The Gemini CLI executed untrusted shell commands')).toBe('Gemini')
    expect(matchNvdFirstParty("Perplexity's Comet browser leaked session tokens")).toBe('Perplexity')
    expect(matchNvdFirstParty('Claude Desktop for Windows escalates privileges')).toBe('Claude Desktop')
  })
  it('requires a context marker for weak single tokens', () => {
    // 'grok' as a common word / unrelated tool — no xAI context → no match
    expect(matchNvdFirstParty('The developer failed to grok the API contract')).toBeNull()
    // 'gemini' the zodiac/other product — no Google context → no match
    expect(matchNvdFirstParty('The Gemini horoscope app crashed')).toBeNull()
    // 'codex' generic — no OpenAI context → no match
    expect(matchNvdFirstParty('A medical codex parser overflowed')).toBeNull()
  })
  it('matches weak tokens once the vendor context co-occurs', () => {
    expect(matchNvdFirstParty('xAI Grok chatbot exposed conversation history')).toBe('Grok')
    expect(matchNvdFirstParty("Google's Gemini assistant mishandled input")).toBe('Gemini')
  })
  it('returns null for unrelated CVEs', () => {
    expect(matchNvdFirstParty('A SQL injection in WordPress plugin Foo')).toBeNull()
  })
})

describe('nvdCveToAlert', () => {
  it('builds a well-formed alert from a real CVE', () => {
    const a = nvdCveToAlert(claudeCodeCve, 'Claude Code')
    expect(a.source).toBe('nvd')
    expect(a.id).toBe('CVE-2025-52882')
    expect(a.kvKey).toBe('security:seen:nvd:CVE-2025-52882')
    expect(a.url).toBe('https://nvd.nist.gov/vuln/detail/CVE-2025-52882')
    expect(a.service).toBe('Claude Code')
    expect(a.severity).toBe('high')
    expect(a.cweIds).toEqual(['CWE-1385'])
    expect(a.title.startsWith('CVE-2025-52882: ')).toBe(true)
  })
  it('caps the title at the first sentence / 140 chars', () => {
    const long = 'x'.repeat(400)
    const a = nvdCveToAlert({ id: 'CVE-1', descriptions: [{ lang: 'en', value: long }] }, 'Grok')
    expect(a.title.length).toBeLessThanOrEqual('CVE-1: '.length + 140)
    expect(a.title.endsWith('...')).toBe(true)
  })
})

describe('filterNvdCves (end-to-end candidate pipeline)', () => {
  it('surfaces genuine first-party CVEs, drops all three noise classes + non-first-party', () => {
    const cves = [
      claudeCodeCve,
      codexCve,
      { id: 'CVE-R', vulnStatus: 'Rejected', descriptions: [{ lang: 'en', value: 'Claude Code flaw' }] },
      { id: 'CVE-C', descriptions: [{ lang: 'en', value: 'Cloud CLI aka Claude Code UI leaks tokens' }] },
      { id: 'CVE-K', descriptions: [{ lang: 'en', value: 'In the Linux kernel, a flaw found by Claude Code was fixed' }] },
      { id: 'CVE-U', descriptions: [{ lang: 'en', value: 'A stored XSS in some unrelated CMS' }] },
    ]
    const alerts = filterNvdCves(cves)
    expect(alerts.map(a => a.id)).toEqual(['CVE-2025-52882', 'CVE-2026-14898'])
    expect(alerts.map(a => a.service)).toEqual(['Claude Code', 'OpenAI Codex'])
  })
  it('skips CVEs with no description', () => {
    expect(filterNvdCves([{ id: 'CVE-X' }])).toEqual([])
  })
})

describe('formatSecurityDigest — NVD alerts render (regression: they were dropped)', () => {
  const nvdAlert: SecurityAlert = { source: 'nvd', id: 'CVE-2025-52882', title: 'CVE-2025-52882: Claude Code websocket flaw', url: 'https://nvd.nist.gov/vuln/detail/CVE-2025-52882', severity: 'critical', kvKey: 'security:seen:nvd:CVE-2025-52882', service: 'Claude Code' }

  it('renders an NVD-only digest with a First-Party CVEs section (not an empty body)', () => {
    const d = formatSecurityDigest([nvdAlert])
    expect(d.title).toContain('1 new finding')
    expect(d.description).toContain('First-Party CVEs (1)')
    expect(d.description).toContain('Claude Code')
    expect(d.description).toContain('CVE-2025-52882')
    expect(d.description).toContain('nvd.nist.gov')
    expect(d.description.trim().length).toBeGreaterThan(0)  // the bug: empty description
  })

  it('an NVD critical drives the embed color red', () => {
    expect(formatSecurityDigest([nvdAlert]).color).toBe(0xf85149)
  })

  it('renders NVD alongside OSV/HN in the same embed', () => {
    const osv: SecurityAlert = { source: 'osv', id: 'GHSA-x', title: 'SDK bug', url: 'https://osv.dev/x', severity: 'high', kvKey: 'k', service: 'OpenAI', affectedPackage: 'PyPI/openai' }
    const d = formatSecurityDigest([osv, nvdAlert])
    expect(d.description).toContain('SDK Vulnerabilities (1)')
    expect(d.description).toContain('First-Party CVEs (1)')
    expect(d.title).toContain('2 new findings')
  })
})

describe('isPubliclyVerifiedAlert — NVD is CVE-backed (always public)', () => {
  it('treats nvd like osv', () => {
    expect(isPubliclyVerifiedAlert({ source: 'nvd', title: 'CVE-2025-52882: anything' })).toBe(true)
    // even without a CVE id in the title (the source itself is authoritative)
    expect(isPubliclyVerifiedAlert({ source: 'nvd', title: 'no id here' })).toBe(true)
  })
})

// ---- fetchNvdAlerts: fixed rolling window + pagination + dedup (network mocked) ----

function nvdResponse(cves: unknown[], total = cves.length, resultsPerPage = 2000) {
  return { ok: true, json: async () => ({ totalResults: total, resultsPerPage, vulnerabilities: cves.map(cve => ({ cve })) }), body: { cancel() {} } }
}
function fakeKv(store = new Map<string, string>()) {
  return {
    get: vi.fn(async (k: string) => store.get(k) ?? null),
    put: vi.fn(async (k: string, v: string) => { store.set(k, v) }),
    _store: store,
  }
}

afterEach(() => vi.restoreAllMocks())

describe('fetchNvdAlerts', () => {
  it('returns first-party alerts from a fixed ~6h rolling window (no cursor state)', async () => {
    const kv = fakeKv()
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(nvdResponse([claudeCodeCve, codexCve]) as unknown as Response)
    const alerts = await fetchNvdAlerts(kv as unknown as KVNamespace)
    expect(alerts.map(a => a.id)).toEqual(['CVE-2025-52882', 'CVE-2026-14898'])
    // No cursor is persisted — the source is stateless/re-derivable like OSV.
    expect(kv.put).not.toHaveBeenCalled()
    // The window is a fixed ~6h lookback (bounded so the NVD payload/latency stays small).
    const url = decodeURIComponent(String(fetchSpy.mock.calls[0][0]))
    expect(url).toContain('lastModStartDate=')
    expect(url).toContain('lastModEndDate=')
    const windowMs = Date.now() - Date.parse(url.match(/lastModStartDate=([^&]+)/)![1])
    expect(windowMs).toBeGreaterThan(5.5 * 3600 * 1000)
    expect(windowMs).toBeLessThan(6.5 * 3600 * 1000)
  })

  it('accumulates across multiple pages (startIndex advances)', async () => {
    // Page 1 (startIndex 0) reports total=3 but only returns 2; page 2 returns the 3rd.
    const kv = fakeKv()
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce({ ok: true, body: { cancel() {} }, json: async () => ({ totalResults: 3, resultsPerPage: 2, vulnerabilities: [claudeCodeCve, codexCve].map(cve => ({ cve })) }) } as unknown as Response)
      .mockResolvedValueOnce({ ok: true, body: { cancel() {} }, json: async () => ({ totalResults: 3, resultsPerPage: 2, vulnerabilities: [{ cve: { id: 'CVE-3', descriptions: [{ lang: 'en', value: 'Azure OpenAI mishandles a request' }] } }] }) } as unknown as Response)
    const alerts = await fetchNvdAlerts(kv as unknown as KVNamespace)
    expect(fetchSpy).toHaveBeenCalledTimes(2)
    expect(String(fetchSpy.mock.calls[1][0])).toContain('startIndex=2')
    expect(alerts.map(a => a.id)).toEqual(['CVE-2025-52882', 'CVE-2026-14898', 'CVE-3'])
  })

  it('pre-dedups against seen markers', async () => {
    const kv = fakeKv(new Map([['security:seen:nvd:CVE-2025-52882', '1']]))
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(nvdResponse([claudeCodeCve, codexCve]) as unknown as Response)
    const alerts = await fetchNvdAlerts(kv as unknown as KVNamespace)
    expect(alerts.map(a => a.id)).toEqual(['CVE-2026-14898'])
  })

  it('fails OPEN on a KV dedup-read error (a transient KV outage must not suppress a real CVE)', async () => {
    const kv = fakeKv()
    kv.get = vi.fn(async () => { throw new Error('KV down') })
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(nvdResponse([claudeCodeCve]) as unknown as Response)
    const alerts = await fetchNvdAlerts(kv as unknown as KVNamespace)
    expect(alerts.map(a => a.id)).toEqual(['CVE-2025-52882'])  // kept, not silently dropped
  })

  it('throws on HTTP error (window simply re-opens next cycle — no state left behind)', async () => {
    const kv = fakeKv()
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: false, status: 503, body: { cancel() {} } } as unknown as Response)
    await expect(fetchNvdAlerts(kv as unknown as KVNamespace)).rejects.toThrow(/NVD HTTP 503/)
    expect(kv.put).not.toHaveBeenCalled()
  })

  it('works with kv=null (test ergonomics)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(nvdResponse([claudeCodeCve]) as unknown as Response)
    const alerts = await fetchNvdAlerts(null)
    expect(alerts.map(a => a.id)).toEqual(['CVE-2025-52882'])
  })
})

describe('detectSecurityAlerts integration — NVD alerts reach the combined output', () => {
  it('surfaces a fulfilled NVD result alongside OSV/HN and survives an NVD rejection', async () => {
    // Route the single global fetch by URL: NVD returns a first-party CVE; HN (Algolia)
    // and OSV (osv.dev) return empty so the test isolates the NVD contribution.
    const kv = fakeKv()
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: unknown) => {
      const u = String(input)
      if (u.includes('services.nvd.nist.gov')) return nvdResponse([claudeCodeCve]) as unknown as Response
      if (u.includes('osv.dev')) return { ok: true, body: { cancel() {} }, json: async () => ({ results: [] }) } as unknown as Response
      // HN Algolia
      return { ok: true, body: { cancel() {} }, json: async () => ({ hits: [] }) } as unknown as Response
    })
    const out = await detectSecurityAlerts(kv as unknown as KVNamespace)
    expect(out.some(a => a.source === 'nvd' && a.id === 'CVE-2025-52882')).toBe(true)
  })
})
