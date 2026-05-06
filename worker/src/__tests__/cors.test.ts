// CORS allowlist tests — covers literal-origin, wildcard, and `*suffix`
// matching (#385). The suffix pattern was added so Vercel Preview deployments
// (per-branch URLs that can't be pre-listed) can call `/api/status` without
// resorting to a global `*.vercel.app` allowlist. Vercel concatenates
// project+branch+hash+team into a single hyphenated subdomain, hence
// hyphen-anchored suffix matching rather than dot-anchored subdomain match.

import { describe, it, expect } from 'vitest'
import { matchOrigin, corsHeaders } from '../cors'

const PROD = 'https://ai-watch.dev'
const VERCEL_TEAM = '*-bentleys-projects-5f6a1a8c.vercel.app'
const ALLOWLIST = `${PROD},https://www.ai-watch.dev,${VERCEL_TEAM}`

describe('matchOrigin — exact-string allowlist', () => {
  it('matches a listed origin verbatim', () => {
    expect(matchOrigin(PROD, ALLOWLIST)).toBe(PROD)
  })

  it('matches the second allowlist entry', () => {
    expect(matchOrigin('https://www.ai-watch.dev', ALLOWLIST)).toBe('https://www.ai-watch.dev')
  })

  it('rejects an origin that is a substring of an allowed entry', () => {
    expect(matchOrigin('https://ai-watch.de', ALLOWLIST)).toBe('')
  })

  it('rejects an arbitrary origin', () => {
    expect(matchOrigin('https://attacker.example', ALLOWLIST)).toBe('')
  })

  it('is case-sensitive (origins are normalized lowercase by the browser)', () => {
    // Mirrors browser behavior — Origin header values are lowercased by the UA,
    // so the allowlist comparison is case-sensitive by design.
    expect(matchOrigin('https://AI-watch.dev', ALLOWLIST)).toBe('')
  })
})

describe('matchOrigin — *suffix pattern (Vercel preview)', () => {
  // Real-world shape: project + git branch slug + deploy hash + team slug,
  // all concatenated with hyphens into a single subdomain.
  const TEAM_PREVIEW = 'https://aiwatch-dev-git-fix-385-cors-abc123-bentleys-projects-5f6a1a8c.vercel.app'

  it('matches a real per-branch Vercel preview URL', () => {
    expect(matchOrigin(TEAM_PREVIEW, ALLOWLIST)).toBe(TEAM_PREVIEW)
  })

  it('matches a different branch under the same team suffix', () => {
    const otherBranch = 'https://aiwatch-dev-git-feat-something-xyz789-bentleys-projects-5f6a1a8c.vercel.app'
    expect(matchOrigin(otherBranch, ALLOWLIST)).toBe(otherBranch)
  })

  it('does NOT match an arbitrary *.vercel.app origin (different team)', () => {
    // Critical: a global `*.vercel.app` allowlist would let any Vercel user
    // call our Worker. The team-scoped suffix prevents that.
    expect(matchOrigin('https://something-attacker-projects-deadbeef.vercel.app', ALLOWLIST)).toBe('')
    expect(matchOrigin('https://random.vercel.app', ALLOWLIST)).toBe('')
  })

  it('does NOT match the bare suffix host (no prefix)', () => {
    // `*-foo` should not match `foo` — the asterisk requires a non-empty
    // prefix. (`bentleys-projects-5f6a1a8c.vercel.app` is the team's overview
    // page on Vercel, never a deployment host.)
    expect(matchOrigin('https://bentleys-projects-5f6a1a8c.vercel.app', ALLOWLIST)).toBe('')
  })

  it('matches even when the suffix entry is the only allowlist item', () => {
    expect(matchOrigin('https://x-bentleys-projects-5f6a1a8c.vercel.app', VERCEL_TEAM)).toBe(
      'https://x-bentleys-projects-5f6a1a8c.vercel.app',
    )
  })

  it('rejects an origin that ends with the team slug but on a different TLD', () => {
    expect(matchOrigin('https://x-bentleys-projects-5f6a1a8c.vercel.dev', ALLOWLIST)).toBe('')
    expect(matchOrigin('https://x-bentleys-projects-5f6a1a8c.attacker.com', ALLOWLIST)).toBe('')
  })

  it('IGNORES a suffix pattern whose first non-asterisk char is not "-" or "." (typo guard)', () => {
    // If an operator forgets the leading separator in wrangler.toml — e.g.
    // writes `*bentleys-projects-5f6a1a8c.vercel.app` (no `-`) — `endsWith`
    // would match `evilbentleys-projects-5f6a1a8c.vercel.app` from any
    // attacker who registers that name. The matcher rejects suffixes that
    // don't begin with a separator so this typo fails closed.
    const TYPO = '*bentleys-projects-5f6a1a8c.vercel.app'
    expect(matchOrigin('https://aiwatch-dev-git-x-bentleys-projects-5f6a1a8c.vercel.app', TYPO)).toBe('')
    expect(matchOrigin('https://evilbentleys-projects-5f6a1a8c.vercel.app', TYPO)).toBe('')
  })

  it('accepts both "-" and "." as anchor characters', () => {
    expect(matchOrigin('https://x-foo.example.com', '*-foo.example.com')).toBe('https://x-foo.example.com')
    expect(matchOrigin('https://x.foo.example.com', '*.foo.example.com')).toBe('https://x.foo.example.com')
  })
})

describe('matchOrigin — wildcard / undefined / empty', () => {
  it('returns the literal "*" when allowedOrigin is "*" (open allowlist)', () => {
    // Used by `worker/.dev.vars` for local development.
    expect(matchOrigin('https://anything.example', '*')).toBe('*')
  })

  it('returns "*" even when origin is empty under wildcard mode', () => {
    // Wildcard does not require an Origin header — that's what makes it useful
    // for local curl tests.
    expect(matchOrigin('', '*')).toBe('*')
  })

  it('returns empty string when allowedOrigin is undefined', () => {
    expect(matchOrigin(PROD, undefined)).toBe('')
  })

  it('returns empty string when allowedOrigin is the empty string', () => {
    expect(matchOrigin(PROD, '')).toBe('')
  })

  it('returns empty string when origin is empty and allowlist is non-wildcard', () => {
    expect(matchOrigin('', ALLOWLIST)).toBe('')
  })

  it('tolerates extra whitespace in the comma-separated allowlist', () => {
    expect(matchOrigin(PROD, `  ${PROD}  ,  https://www.ai-watch.dev  `)).toBe(PROD)
  })

  it('tolerates trailing commas / empty entries', () => {
    expect(matchOrigin(PROD, `${PROD},,,`)).toBe(PROD)
    expect(matchOrigin('https://attacker.example', `${PROD},,,`)).toBe('')
  })

  it('treats a bare "*" only as the top-level open-allowlist sentinel', () => {
    // The `*` shortcut is recognized only when the ENTIRE allowlist is `*`.
    // A bare `*` mid-list is silently ignored — it must not fall through to
    // the suffix branch where slice(1)='' would make .endsWith('') always true
    // for any non-empty string and silently turn the whole allowlist into
    // universal allow. The `pattern.length > 1` guard in matchOrigin enforces
    // this; keep this test as a regression lock.
    expect(matchOrigin('https://attacker.example', '*')).toBe('*')
    expect(matchOrigin('https://attacker.example', `${PROD},*`)).toBe('')
    expect(matchOrigin(PROD, `${PROD},*`)).toBe(PROD)
  })
})

describe('corsHeaders — full response shape', () => {
  it('emits Access-Control-Allow-* and Vary headers when origin matches', () => {
    const headers = corsHeaders(PROD, ALLOWLIST) as Record<string, string>
    expect(headers['Access-Control-Allow-Origin']).toBe(PROD)
    expect(headers['Access-Control-Allow-Methods']).toBe('GET, POST, DELETE, OPTIONS')
    expect(headers['Access-Control-Allow-Headers']).toBe('Content-Type')
    expect(headers['Access-Control-Max-Age']).toBe('86400')
    expect(headers['Vary']).toBe('Origin')
  })

  it('emits "*" as the origin under wildcard mode', () => {
    const headers = corsHeaders('https://anything.example', '*') as Record<string, string>
    expect(headers['Access-Control-Allow-Origin']).toBe('*')
  })

  it('returns an empty object when origin is not allowed (fail closed)', () => {
    // No headers means the browser's CORS check fails — exactly the
    // behavior we want for an unrecognized origin.
    expect(corsHeaders('https://attacker.example', ALLOWLIST)).toEqual({})
  })

  it('returns an empty object when allowedOrigin is missing', () => {
    expect(corsHeaders(PROD, undefined)).toEqual({})
  })

  it('echoes the matched preview origin (not the pattern) in the response', () => {
    // Per the CORS spec, Access-Control-Allow-Origin must be either '*' or a
    // single origin — never a pattern. Make sure the helper returns the actual
    // request origin, not the literal `*suffix` string.
    const preview = 'https://aiwatch-dev-git-fix-385-cors-abc123-bentleys-projects-5f6a1a8c.vercel.app'
    const headers = corsHeaders(preview, ALLOWLIST) as Record<string, string>
    expect(headers['Access-Control-Allow-Origin']).toBe(preview)
    expect(headers['Access-Control-Allow-Origin']).not.toContain('*')
  })
})
