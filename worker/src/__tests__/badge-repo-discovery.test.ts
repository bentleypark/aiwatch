import { describe, it, expect, vi } from 'vitest'
import {
  buildBadgeSearchUrl,
  parseBadgeSearchResponse,
  parseBadgeReposSeen,
  searchBadgeEmbeds,
  diffBadgeRepoDiscovery,
  formatBadgeRepoDiscoverySection,
  type BadgeRepoResult,
} from '../badge-repo-discovery'

describe('buildBadgeSearchUrl (#1158)', () => {
  it('targets the GitHub Code Search endpoint with the badge URL query, per_page=100', () => {
    const url = buildBadgeSearchUrl()
    expect(url).toContain('https://api.github.com/search/code?q=')
    expect(url).toContain(encodeURIComponent('aiwatch-worker.p2c2kbf.workers.dev/badge'))
    expect(url).toContain('per_page=100')
  })

  it('accepts a custom query (encoded)', () => {
    expect(buildBadgeSearchUrl('foo bar')).toContain(encodeURIComponent('foo bar'))
  })
})

describe('parseBadgeSearchResponse (#1158)', () => {
  it('extracts fullName/path/htmlUrl from matching items', () => {
    const json = {
      items: [
        { path: 'README.md', html_url: 'https://github.com/acme/widget/blob/main/README.md', repository: { full_name: 'acme/widget' } },
      ],
    }
    expect(parseBadgeSearchResponse(json)).toEqual([
      { fullName: 'acme/widget', path: 'README.md', htmlUrl: 'https://github.com/acme/widget/blob/main/README.md' },
    ])
  })

  it('dedupes multiple hits in the same repo, keeping the first', () => {
    const json = {
      items: [
        { path: 'README.md', html_url: 'url1', repository: { full_name: 'acme/widget' } },
        { path: 'STATUS.md', html_url: 'url2', repository: { full_name: 'acme/widget' } },
      ],
    }
    expect(parseBadgeSearchResponse(json)).toEqual([{ fullName: 'acme/widget', path: 'README.md', htmlUrl: 'url1' }])
  })

  it('excludes the aiwatch repo itself (case-insensitive)', () => {
    const json = { items: [{ path: 'README.md', html_url: 'url', repository: { full_name: 'bentleypark/aiwatch' } }] }
    expect(parseBadgeSearchResponse(json)).toEqual([])
    const json2 = { items: [{ path: 'README.md', html_url: 'url', repository: { full_name: 'BentleyPark/AIWatch' } }] }
    expect(parseBadgeSearchResponse(json2)).toEqual([])
  })

  it('skips items with a missing/non-string repository.full_name', () => {
    const json = { items: [{ path: 'README.md', html_url: 'url', repository: {} }, { path: 'x' }] }
    expect(parseBadgeSearchResponse(json)).toEqual([])
  })

  it('returns null (not []) for a malformed payload — distinct from a genuine zero-result week', () => {
    expect(parseBadgeSearchResponse({})).toBeNull()
    expect(parseBadgeSearchResponse(null)).toBeNull()
    expect(parseBadgeSearchResponse({ items: 'not-an-array' })).toBeNull()
  })

  it('returns [] for a genuinely empty items array', () => {
    expect(parseBadgeSearchResponse({ items: [] })).toEqual([])
  })
})

describe('parseBadgeReposSeen (#1158)', () => {
  it('returns [] for a genuinely-absent key (raw === null) — a real first-run-ever state', () => {
    expect(parseBadgeReposSeen(null)).toEqual([])
  })

  it('parses a valid string array', () => {
    expect(parseBadgeReposSeen('["a/one","b/two"]')).toEqual(['a/one', 'b/two'])
  })

  it('parses a valid empty array (distinct from the absent-key case, same result)', () => {
    expect(parseBadgeReposSeen('[]')).toEqual([])
  })

  it('returns null (NOT []) for invalid JSON — caller must skip the write, not treat as empty', () => {
    expect(parseBadgeReposSeen('{not json')).toBeNull()
  })

  it('returns null for valid JSON that is not an array', () => {
    expect(parseBadgeReposSeen('{"a":1}')).toBeNull()
    expect(parseBadgeReposSeen('"a string"')).toBeNull()
    expect(parseBadgeReposSeen('42')).toBeNull()
  })

  it('returns null (rejects the whole value) when any element is not a string', () => {
    expect(parseBadgeReposSeen('["a/one", 42, "b/two"]')).toBeNull()
    expect(parseBadgeReposSeen('["a/one", null]')).toBeNull()
  })
})

describe('searchBadgeEmbeds (#1158)', () => {
  it('returns null without a token (no fetch call)', async () => {
    const fetchImpl = vi.fn()
    expect(await searchBadgeEmbeds(undefined, fetchImpl)).toBeNull()
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('sends the Bearer token + required GitHub API headers', async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => new Response(JSON.stringify({ items: [] }), { status: 200 }))
    await searchBadgeEmbeds('tok123', fetchImpl as unknown as typeof fetch)
    const init = fetchImpl.mock.calls[0][1]
    const headers = init?.headers as Record<string, string>
    expect(headers.Authorization).toBe('Bearer tok123')
    expect(headers.Accept).toBe('application/vnd.github+json')
    expect(headers['X-GitHub-Api-Version']).toBe('2022-11-28')
  })

  it('returns null on a non-OK HTTP response', async () => {
    const fetchImpl = vi.fn(async () => new Response('rate limited', { status: 403 }))
    expect(await searchBadgeEmbeds('tok', fetchImpl as unknown as typeof fetch)).toBeNull()
  })

  it('returns null when fetch throws (network error)', async () => {
    const fetchImpl = vi.fn(async () => { throw new Error('network down') })
    expect(await searchBadgeEmbeds('tok', fetchImpl as unknown as typeof fetch)).toBeNull()
  })

  it('returns null on a 200 response with a malformed (non-JSON) body', async () => {
    const fetchImpl = vi.fn(async () => new Response('not json', { status: 200 }))
    expect(await searchBadgeEmbeds('tok', fetchImpl as unknown as typeof fetch)).toBeNull()
  })

  it('parses a successful response', async () => {
    const body = { items: [{ path: 'README.md', html_url: 'url', repository: { full_name: 'acme/widget' } }] }
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(body), { status: 200 }))
    expect(await searchBadgeEmbeds('tok', fetchImpl as unknown as typeof fetch)).toEqual([
      { fullName: 'acme/widget', path: 'README.md', htmlUrl: 'url' },
    ])
  })
})

describe('diffBadgeRepoDiscovery (#1158)', () => {
  const r = (fullName: string): BadgeRepoResult => ({ fullName, path: 'README.md', htmlUrl: `https://github.com/${fullName}` })

  it('reports every result as new on a first-ever run (empty previously-seen)', () => {
    const diff = diffBadgeRepoDiscovery([r('a/one'), r('b/two')], [])
    expect(diff.newRepos.map((x) => x.fullName)).toEqual(['a/one', 'b/two'])
    expect(diff.seen).toEqual(['a/one', 'b/two'])
    expect(diff.totalKnown).toBe(2)
  })

  it('reports nothing new when every result was already seen', () => {
    const diff = diffBadgeRepoDiscovery([r('a/one')], ['a/one', 'b/two'])
    expect(diff.newRepos).toEqual([])
    expect(diff.totalKnown).toBe(2) // previously-seen repos aren't dropped just because this run didn't re-match them
  })

  it('reports only the genuinely new subset when some overlap', () => {
    const diff = diffBadgeRepoDiscovery([r('a/one'), r('c/three')], ['a/one'])
    expect(diff.newRepos.map((x) => x.fullName)).toEqual(['c/three'])
    expect(diff.seen).toEqual(['a/one', 'c/three'])
  })

  it('the returned seen set is sorted and deduped', () => {
    const diff = diffBadgeRepoDiscovery([r('z/last'), r('a/one')], ['a/one', 'm/mid'])
    expect(diff.seen).toEqual(['a/one', 'm/mid', 'z/last'])
  })
})

describe('formatBadgeRepoDiscoverySection (#1158)', () => {
  it('renders the header, count, known total, and repo list', () => {
    const diff = { newRepos: [{ fullName: 'acme/widget', path: 'README.md', htmlUrl: 'u' }], seen: ['acme/widget'], totalKnown: 5 }
    const out = formatBadgeRepoDiscoverySection(diff)
    expect(out).toContain('Badge Adopters')
    expect(out).toContain('1 new repo found this week (5 known total)')
    expect(out).toContain('• acme/widget')
  })

  it('uses plural "repos" for count !== 1', () => {
    const diff = { newRepos: [{ fullName: 'a/a', path: '', htmlUrl: '' }, { fullName: 'b/b', path: '', htmlUrl: '' }], seen: [], totalKnown: 2 }
    expect(formatBadgeRepoDiscoverySection(diff)).toContain('2 new repos found')
  })

  it('returns empty string when null (search not configured / failed)', () => {
    expect(formatBadgeRepoDiscoverySection(null)).toBe('')
  })

  it('returns empty string when there are zero new repos this week', () => {
    expect(formatBadgeRepoDiscoverySection({ newRepos: [], seen: ['a/a'], totalKnown: 1 })).toBe('')
  })

  it('caps the listed repos at 10 with an overflow count', () => {
    const newRepos = Array.from({ length: 13 }, (_, i) => ({ fullName: `org/repo${i}`, path: '', htmlUrl: '' }))
    const out = formatBadgeRepoDiscoverySection({ newRepos, seen: [], totalKnown: 13 })
    expect(out).toContain('• org/repo9')
    expect(out).not.toContain('• org/repo10')
    expect(out).toContain('… and 3 more')
  })
})
