import { describe, it, expect, vi, afterEach } from 'vitest'
import handler from '../sitemap'
import { FAMILY_GROUPS, SLUG_TO_SERVICE } from '../_is-down/slug-map'
import { parseSitemapFeed, renderSitemapXml, sitemapEntries, STATIC_PATHS } from '../_sitemap/build'
import { resolveWorkerApi } from '../_shared/worker-api'

const lastmodOf = (entries: ReturnType<typeof sitemapEntries>, path: string) =>
  entries.find((e) => e.path === path)?.lastmod

describe('sitemapEntries (#887)', () => {
  it('lists the dashboard, every family page, every is-down slug and the static pages, once each', () => {
    const paths = sitemapEntries(new Map()).map((e) => e.path)
    expect(paths[0]).toBe('/')
    for (const f of Object.values(FAMILY_GROUPS)) expect(paths).toContain(`/is-${f.slug}-down`)
    for (const slug of Object.keys(SLUG_TO_SERVICE)) expect(paths).toContain(`/is-${slug}-down`)
    for (const p of STATIC_PATHS) expect(paths).toContain(p)
    expect(new Set(paths).size).toBe(paths.length)
  })

  it('gives a single-service page its own service instant, mapped through the slug', () => {
    const entries = sitemapEntries(new Map([
      ['bfl', '2026-10-24T10:00:00.000Z'],
      ['groq', '2026-10-01T00:00:00.000Z'],
    ]))
    expect(lastmodOf(entries, '/is-flux-down')).toBe('2026-10-24T10:00:00.000Z')
    expect(lastmodOf(entries, '/is-groq-down')).toBe('2026-10-01T00:00:00.000Z')
    expect(lastmodOf(entries, '/is-cohere-down')).toBeNull()
  })

  it('gives a family page the latest of its members, and ignores non-members', () => {
    const entries = sitemapEntries(new Map([
      ['claude', '2026-10-20T00:00:00.000Z'],
      ['claudecode', '2026-10-25T06:00:00.000Z'],
      ['openai', '2026-10-26T00:00:00.000Z'],
    ]))
    expect(lastmodOf(entries, '/is-claude-down')).toBe('2026-10-25T06:00:00.000Z')
    expect(lastmodOf(entries, '/is-openai-down')).toBe('2026-10-26T00:00:00.000Z')
    expect(lastmodOf(entries, '/is-xai-down')).toBeNull()
  })

  it('gives the dashboard the latest of every service, including ones with no is-down page', () => {
    const entries = sitemapEntries(new Map([
      ['groq', '2026-10-01T00:00:00.000Z'],
      ['bedrock', '2026-10-02T00:00:00.000Z'],
    ]))
    expect(lastmodOf(entries, '/')).toBe('2026-10-02T00:00:00.000Z')
  })

  it('never dates a static page', () => {
    const entries = sitemapEntries(new Map([['claude', '2026-10-25T00:00:00.000Z']]))
    for (const p of STATIC_PATHS) expect(lastmodOf(entries, p)).toBeNull()
  })
})

describe('parseSitemapFeed (#887)', () => {
  it('keeps parseable instants and drops everything else', () => {
    const changed = parseSitemapFeed({
      services: [
        { id: 'claude', lastChangedAt: '2026-10-25T00:00:00.000Z' },
        { id: 'groq', lastChangedAt: null },
        { id: 'cohere', lastChangedAt: 'yesterday' },
        { id: 7, lastChangedAt: '2026-10-25T00:00:00.000Z' },
        null,
      ],
    })
    expect([...changed]).toEqual([['claude', '2026-10-25T00:00:00.000Z']])
  })

  it('is empty for a payload of the wrong shape', () => {
    expect(parseSitemapFeed(null).size).toBe(0)
    expect(parseSitemapFeed({ services: 'x' }).size).toBe(0)
    expect(parseSitemapFeed({ error: 'no status snapshot available' }).size).toBe(0)
  })
})

describe('renderSitemapXml (#887)', () => {
  it('writes lastmod only for a dated entry, and no changefreq or priority', () => {
    const xml = renderSitemapXml([
      { path: '/is-groq-down', lastmod: '2026-10-01T00:00:00.000Z' },
      { path: '/intro', lastmod: null },
    ])
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">')).toBe(true)
    expect(xml).toContain('<url>\n    <loc>https://ai-watch.dev/is-groq-down</loc>\n    <lastmod>2026-10-01T00:00:00.000Z</lastmod>\n  </url>')
    expect(xml).toContain('<url>\n    <loc>https://ai-watch.dev/intro</loc>\n  </url>')
    expect(xml).not.toMatch(/changefreq|priority/)
    expect(xml.trimEnd().endsWith('</urlset>')).toBe(true)
  })
})

describe('resolveWorkerApi', () => {
  const PROD = 'https://worker.example'
  const env = (vars: Record<string, string>) => (name: string) => vars[name]
  it('uses the local override outside production only', () => {
    expect(resolveWorkerApi(PROD, env({ AIWATCH_WORKER_API: 'http://127.0.0.1:8788' }))).toBe('http://127.0.0.1:8788')
    expect(resolveWorkerApi(PROD, env({ VERCEL_ENV: 'production', AIWATCH_WORKER_API: 'http://127.0.0.1:8788' }))).toBe(PROD)
    expect(resolveWorkerApi(PROD, env({}))).toBe(PROD)
  })
})

describe('/sitemap.xml handler (#887)', () => {
  afterEach(() => vi.restoreAllMocks())
  const answer = (body: unknown, status = 200) =>
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }))

  it('reads the worker projection and writes its instants as lastmod', async () => {
    const fetchSpy = answer({ services: [{ id: 'groq', lastChangedAt: '2026-10-01T00:00:00.000Z' }] })
    const res = await handler(new Request('https://ai-watch.dev/sitemap.xml'))
    expect(String(fetchSpy.mock.calls[0][0])).toMatch(/\/api\/status\/cached\?src=sitemap$/)
    expect(res.headers.get('Content-Type')).toBe('application/xml; charset=utf-8')
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=0, s-maxage=300')
    expect(await res.text()).toContain('<loc>https://ai-watch.dev/is-groq-down</loc>\n    <lastmod>2026-10-01T00:00:00.000Z</lastmod>')
  })

  it('serves every URL with no lastmod, briefly cached, when the worker read fails', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    answer({ error: 'no status snapshot available' }, 503)
    const res = await handler(new Request('https://ai-watch.dev/sitemap.xml'))
    const xml = await res.text()
    expect(res.status).toBe(200)
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=0, s-maxage=60')
    expect(xml).toContain('<loc>https://ai-watch.dev/is-groq-down</loc>')
    expect(xml).not.toContain('<lastmod>')
  })
})
