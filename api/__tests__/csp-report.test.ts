import { describe, it, expect } from 'vitest'
import { parseCspReports, summarizeCspReport } from '../csp-report'

// #482 Phase 1 — the CSP violation sink must normalize BOTH wire formats a browser may send:
// the legacy `report-uri` ({ "csp-report": {...} }, kebab-case) and the modern `report-to`
// ([{ type, body:{...} }], camelCase). A garbage/non-JSON body must degrade to [] (never throw —
// the handler 204s regardless), so a malformed beacon can't error the Edge function.

describe('parseCspReports', () => {
  it('parses the report-uri shape ({ "csp-report": {...} })', () => {
    const body = JSON.stringify({
      'csp-report': {
        'document-uri': 'https://ai-watch.dev/is-claude-down',
        'violated-directive': "script-src-elem",
        'blocked-uri': 'inline',
      },
    })
    const out = parseCspReports(body)
    expect(out).toHaveLength(1)
    expect(out[0]['violated-directive']).toBe('script-src-elem')
  })

  it('parses the report-to array shape ([{ type, body }])', () => {
    const body = JSON.stringify([
      { type: 'csp-violation', age: 0, body: { effectiveDirective: 'script-src', blockedURL: 'inline' } },
      { type: 'other', body: { foo: 1 } }, // non-CSP report types are still unwrapped (body kept), filtered only by absence of body
    ])
    const out = parseCspReports(body)
    expect(out.length).toBeGreaterThanOrEqual(1)
    expect(out[0].effectiveDirective).toBe('script-src')
  })

  it('returns [] for non-JSON / garbage / empty (never throws)', () => {
    expect(parseCspReports('not json')).toEqual([])
    expect(parseCspReports('')).toEqual([])
    expect(parseCspReports('null')).toEqual([])
    expect(parseCspReports('42')).toEqual([])
  })

  it('returns [] when csp-report key holds a non-object', () => {
    expect(parseCspReports(JSON.stringify({ 'csp-report': 'nope' }))).toEqual([])
  })
})

describe('summarizeCspReport', () => {
  it('summarizes the kebab-case (report-uri) fields with source location', () => {
    const s = summarizeCspReport({
      'document-uri': 'https://ai-watch.dev/intro',
      'violated-directive': 'script-src',
      'blocked-uri': 'inline',
      'source-file': 'https://ai-watch.dev/intro',
      'line-number': 1076,
    })
    expect(s).toContain('directive=script-src')
    expect(s).toContain('blocked=inline')
    expect(s).toContain('doc=https://ai-watch.dev/intro')
    expect(s).toContain('src=https://ai-watch.dev/intro:1076')
  })

  it('summarizes the camelCase (report-to) fields and omits source when absent', () => {
    const s = summarizeCspReport({
      documentURL: 'https://ai-watch.dev/',
      effectiveDirective: 'connect-src',
      blockedURL: 'https://evil.example/x',
    })
    expect(s).toBe('directive=connect-src blocked=https://evil.example/x doc=https://ai-watch.dev/')
  })

  it('falls back to ? for missing fields', () => {
    expect(summarizeCspReport({})).toBe('directive=? blocked=? doc=?')
  })
})
