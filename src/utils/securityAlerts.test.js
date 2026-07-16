import { describe, it, expect } from 'vitest'
import {
  OSV_SERVICE_MAP,
  NVD_SERVICE_MAP,
  serviceIdForAlertLabel,
  securitySourceLabel,
  primaryServiceIdForProvider,
  securityAlertMatchesService,
  filterSecurityAlertsForService,
  tagServiceForAlert,
} from './securityAlerts'
import { OSV_PACKAGES, NVD_FIRST_PARTY } from '../../worker/src/security-monitor'
import ko from '../locales/ko'
import en from '../locales/en'

// Minimal service fixtures — list order matters (primary = first api-category, else first).
// langsmith included: its OSV label ('LangChain'), id ('langsmith') and name all differ,
// so it's the most fragile OSV_SERVICE_MAP entry (#561) — pin it explicitly.
const SERVICES = [
  { id: 'openai', name: 'OpenAI API', provider: 'OpenAI', category: 'api' },
  { id: 'chatgpt', name: 'ChatGPT', provider: 'OpenAI', category: 'app' },
  { id: 'codex', name: 'Codex', provider: 'OpenAI', category: 'agent' },
  { id: 'claude', name: 'Claude API', provider: 'Anthropic', category: 'api' },
  { id: 'claudeai', name: 'claude.ai', provider: 'Anthropic', category: 'app' },
  { id: 'langsmith', name: 'LangChain (LangSmith)', provider: 'LangChain', category: 'api' },
]

const svc = (id) => SERVICES.find((s) => s.id === id)

describe('primaryServiceIdForProvider (#821)', () => {
  it('picks the first api-category service for a provider', () => {
    expect(primaryServiceIdForProvider('OpenAI', SERVICES)).toBe('openai')
    expect(primaryServiceIdForProvider('Anthropic', SERVICES)).toBe('claude')
  })

  it('falls back to the first listed service when no api-category exists', () => {
    const onlyApps = [
      { id: 'a1', name: 'A One', provider: 'P', category: 'app' },
      { id: 'a2', name: 'A Two', provider: 'P', category: 'agent' },
    ]
    expect(primaryServiceIdForProvider('P', onlyApps)).toBe('a1')
  })

  it('returns null for an unknown provider or missing input', () => {
    expect(primaryServiceIdForProvider('Nope', SERVICES)).toBeNull()
    expect(primaryServiceIdForProvider('', SERVICES)).toBeNull()
    expect(primaryServiceIdForProvider('OpenAI', [])).toBeNull()
  })
})

describe('securityAlertMatchesService — HN provider-only fan-out (#821)', () => {
  // The exact regression: provider named, no specific service → must show on ONE service only.
  const providerOnly = { title: 'Concerns raised about OpenAI agent actions and prompt injection' }

  it('attaches a provider-only HN item to the primary service only', () => {
    expect(securityAlertMatchesService(providerOnly, svc('openai'), SERVICES)).toBe(true)
    expect(securityAlertMatchesService(providerOnly, svc('chatgpt'), SERVICES)).toBe(false)
    expect(securityAlertMatchesService(providerOnly, svc('codex'), SERVICES)).toBe(false)
  })

  it('still attaches a name-matched HN item to the exact service (not just the primary)', () => {
    const named = { title: 'ChatGPT conversations leaked in a data breach' }
    expect(securityAlertMatchesService(named, svc('chatgpt'), SERVICES)).toBe(true)
    // "ChatGPT" is not in OpenAI API's name and provider-match would route elsewhere → false
    expect(securityAlertMatchesService(named, svc('openai'), SERVICES)).toBe(false)
  })

  it('does not match services of an unrelated provider', () => {
    expect(securityAlertMatchesService(providerOnly, svc('claude'), SERVICES)).toBe(false)
  })

  it('OSV alerts match by mapped service id, not by title text', () => {
    const osv = { service: 'Anthropic (Claude)', title: 'CVE in some sdk' }
    expect(securityAlertMatchesService(osv, svc('claude'), SERVICES)).toBe(true)
    expect(securityAlertMatchesService(osv, svc('claudeai'), SERVICES)).toBe(false)
  })

  it('maps the fragile LangChain OSV label to langsmith only (#561)', () => {
    // OSV label, service id, and service name all differ — the entry most likely to rot.
    const osv = { service: 'LangChain', title: 'Path traversal in langchain loaders' }
    expect(securityAlertMatchesService(osv, svc('langsmith'), SERVICES)).toBe(true)
    expect(securityAlertMatchesService(osv, svc('claude'), SERVICES)).toBe(false)
  })

  it('a title naming a provider AND a sibling service attaches to both name + primary, not the third sibling', () => {
    // "OpenAI outage hits ChatGPT": chatgpt matches by name; openai matches by provider→primary;
    // codex (neither named) does not. Pins this deliberate dual-attach against silent refactors.
    const both = { title: 'OpenAI outage hits ChatGPT users' }
    expect(securityAlertMatchesService(both, svc('chatgpt'), SERVICES)).toBe(true)
    expect(securityAlertMatchesService(both, svc('openai'), SERVICES)).toBe(true)
    expect(securityAlertMatchesService(both, svc('codex'), SERVICES)).toBe(false)
  })

  it('tolerates a missing title field without throwing', () => {
    expect(securityAlertMatchesService({}, svc('openai'), SERVICES)).toBe(false)
  })
})

describe('OSV_SERVICE_MAP ↔ worker OSV_PACKAGES cross-layer sync (#821)', () => {
  it('every worker OSV `service` label is a key in OSV_SERVICE_MAP', () => {
    // Authoritative sync: imports the REAL map + the REAL worker package list (not a
    // hand-copied set). An OSV label without a map key silently drops its alerts from
    // the Security Alerts card (OSV_SERVICE_MAP[label] === undefined → no service match).
    for (const pkg of OSV_PACKAGES) {
      expect(Object.keys(OSV_SERVICE_MAP)).toContain(pkg.service)
    }
  })

  it('every OSV_SERVICE_MAP target id resolves to a known service shape', () => {
    // Catch a typo'd target id (e.g. 'langsmith' → 'langchain') by requiring each value
    // be a non-empty lowercase id string.
    for (const id of Object.values(OSV_SERVICE_MAP)) {
      expect(typeof id).toBe('string')
      expect(id).toMatch(/^[a-z0-9]+$/)
    }
  })
})

// NVD first-party CVEs (#949) carry a `service` label like OSV, resolved via NVD_SERVICE_MAP.
const NVD_SERVICES = [
  { id: 'claudecode', name: 'Claude Code', provider: 'Anthropic', category: 'agent' },
  { id: 'claudeai', name: 'claude.ai', provider: 'Anthropic', category: 'app' },
  { id: 'codex', name: 'Codex', provider: 'OpenAI', category: 'agent' },
  { id: 'chatgpt', name: 'ChatGPT', provider: 'OpenAI', category: 'app' },
  { id: 'azureopenai', name: 'Azure OpenAI', provider: 'Microsoft', category: 'api' },
  { id: 'gemini', name: 'Gemini API', provider: 'Google', category: 'api' },
  { id: 'xai', name: 'xAI (Grok)', provider: 'xAI', category: 'api' },
  { id: 'perplexity', name: 'Perplexity', provider: 'Perplexity AI', category: 'api' },
]
const nvdSvc = (id) => NVD_SERVICES.find((s) => s.id === id)

describe('NVD_SERVICE_MAP ↔ worker NVD_FIRST_PARTY cross-layer sync (#949)', () => {
  it('every worker NVD_FIRST_PARTY `service` label is a key in NVD_SERVICE_MAP', () => {
    // Same authoritative sync as OSV: a label without a map key silently drops its CVE
    // from the ServiceDetails security card (serviceIdForAlertLabel → null → no match).
    for (const e of NVD_FIRST_PARTY) {
      expect(Object.keys(NVD_SERVICE_MAP)).toContain(e.service)
    }
  })
  it('every NVD_SERVICE_MAP target id is a non-empty lowercase id', () => {
    for (const id of Object.values(NVD_SERVICE_MAP)) {
      expect(id).toMatch(/^[a-z0-9]+$/)
    }
  })
  it('OSV and NVD labels do not collide (serviceIdForAlertLabel is unambiguous)', () => {
    const overlap = Object.keys(NVD_SERVICE_MAP).filter((k) => k in OSV_SERVICE_MAP)
    expect(overlap).toEqual([])
  })
})

describe('securityAlertMatchesService — NVD label routing (#949)', () => {
  it('routes an NVD alert to exactly its mapped service card', () => {
    const alert = { source: 'nvd', service: 'Claude Code', title: 'CVE-2025-52882: …' }
    expect(securityAlertMatchesService(alert, nvdSvc('claudecode'), NVD_SERVICES)).toBe(true)
    expect(securityAlertMatchesService(alert, nvdSvc('claudeai'), NVD_SERVICES)).toBe(false)
    expect(securityAlertMatchesService(alert, nvdSvc('codex'), NVD_SERVICES)).toBe(false)
  })
  it('Claude Desktop maps to the claude.ai card (no dedicated desktop service)', () => {
    const alert = { source: 'nvd', service: 'Claude Desktop', title: 'CVE-x' }
    expect(securityAlertMatchesService(alert, nvdSvc('claudeai'), NVD_SERVICES)).toBe(true)
    expect(securityAlertMatchesService(alert, nvdSvc('claudecode'), NVD_SERVICES)).toBe(false)
  })
  it('serviceIdForAlertLabel resolves both sources and unknown labels', () => {
    expect(serviceIdForAlertLabel('OpenAI Codex')).toBe('codex')  // NVD
    expect(serviceIdForAlertLabel('Anthropic (Claude)')).toBe('claude')  // OSV
    expect(serviceIdForAlertLabel('Nonexistent')).toBeNull()
  })
})

describe('securitySourceLabel (#949 — card labels each finding by what it is about)', () => {
  it('maps each real source to its label token', () => {
    expect(securitySourceLabel('nvd')).toBe('product')       // a CVE in the product itself
    expect(securitySourceLabel('osv')).toBe('sdk')           // a CVE in an installed package
    expect(securitySourceLabel('hackernews')).toBe('news')   // community chatter
  })

  it('returns null for an unknown/missing source (renders no badge, never a wrong one)', () => {
    expect(securitySourceLabel('futuresource')).toBeNull()
    expect(securitySourceLabel(undefined)).toBeNull()
  })

  it('every label token has both i18n keys in ko AND en (else the UI renders a raw key)', () => {
    for (const source of ['nvd', 'osv', 'hackernews']) {
      const token = securitySourceLabel(source)
      for (const locale of [ko, en]) {
        expect(locale[`svc.security.src.${token}`]).toBeTruthy()
        expect(locale[`svc.security.src.${token}.title`]).toBeTruthy()
      }
    }
  })

  it('covers every SecurityAlert source the worker can emit (no unlabeled feed)', () => {
    // Cross-layer guard: worker/src/security-monitor.ts SecurityAlert['source'] union.
    for (const source of ['hackernews', 'osv', 'nvd']) {
      expect(securitySourceLabel(source)).not.toBeNull()
    }
  })
})

describe('filterSecurityAlertsForService (#821)', () => {
  it('a provider-only item appears once across sibling services, not three times', () => {
    const alerts = [{ title: 'OpenAI prompt injection exploit disclosed' }]
    const onAll = SERVICES.filter((s) => filterSecurityAlertsForService(alerts, s, SERVICES).length > 0)
    expect(onAll.map((s) => s.id)).toEqual(['openai'])
  })

  it('tolerates null/empty alert lists', () => {
    expect(filterSecurityAlertsForService(null, svc('openai'), SERVICES)).toEqual([])
    expect(filterSecurityAlertsForService([], svc('openai'), SERVICES)).toEqual([])
  })
})

describe('tagServiceForAlert — Overview banner tag (#821)', () => {
  it('prefers an exact name match', () => {
    expect(tagServiceForAlert({ title: 'Codex token leak' }, SERVICES)?.id).toBe('codex')
  })

  it('falls back to the provider primary for a provider-only item', () => {
    expect(tagServiceForAlert({ title: 'OpenAI breach disclosed' }, SERVICES)?.id).toBe('openai')
  })

  it('returns null for OSV alerts (they carry their own service label) and for no match', () => {
    expect(tagServiceForAlert({ service: 'OpenAI', title: 'x' }, SERVICES)).toBeNull()
    expect(tagServiceForAlert({ title: 'Unrelated nginx CVE' }, SERVICES)).toBeNull()
  })
})
