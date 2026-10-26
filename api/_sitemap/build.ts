// #887 Phase 3 — the sitemap served at /sitemap.xml (api/sitemap.ts).
//
// Google uses a `<lastmod>` only if it is "consistently and verifiably" accurate
// (developers.google.com/search/docs/crawling-indexing/sitemaps/build-sitemap); Bing may disregard
// dates "consistently set to the current date" (blogs.bing.com, February 2023, "The Importance of
// Setting the lastmod Tag in Your Sitemap"). So a page gets one only when its content's last change is
// known: an is-down page's is the latest start, update or resolution among its incidents
// (worker/src/sitemap-feed.ts). Every other page carries none, as does every page when the Worker
// could not be read. `<changefreq>` and `<priority>` are left out: both engines disregard them.
import { FAMILY_GROUPS, SLUG_TO_SERVICE } from '../_is-down/slug-map'

const ORIGIN = 'https://ai-watch.dev'

/** Pages with no per-page change time. A newly published monthly report goes here by hand. */
export const STATIC_PATHS = [
  '/intro', '/methodology', '/badges', '/plugin',
  '/reports/', '/reports/resilience/',
  '/reports/2026-09/', '/reports/2026-08/', '/reports/2026-07/', '/reports/2026-06/',
  '/reports/2026-05/', '/reports/2026-04/', '/reports/2026-03/',
]

/** service id → ISO instant. Entries that are not a parseable string are dropped. */
export function parseSitemapFeed(data: unknown): Map<string, string> {
  const out = new Map<string, string>()
  const services = (data as { services?: unknown } | null)?.services
  if (!Array.isArray(services)) return out
  for (const s of services) {
    const { id, lastChangedAt } = (s ?? {}) as { id?: unknown; lastChangedAt?: unknown }
    if (typeof id === 'string' && typeof lastChangedAt === 'string' && Number.isFinite(Date.parse(lastChangedAt))) {
      out.set(id, lastChangedAt)
    }
  }
  return out
}

function latestOf(ids: readonly string[], changed: Map<string, string>): string | null {
  let best: string | null = null
  for (const id of ids) {
    const at = changed.get(id)
    if (at && (best === null || Date.parse(at) > Date.parse(best))) best = at
  }
  return best
}

export interface SitemapEntry { path: string; lastmod: string | null }

export function sitemapEntries(changed: Map<string, string>): SitemapEntry[] {
  return [
    { path: '/', lastmod: latestOf([...changed.keys()], changed) },
    ...Object.values(FAMILY_GROUPS).map((f) => ({ path: `/is-${f.slug}-down`, lastmod: latestOf(f.members, changed) })),
    ...Object.entries(SLUG_TO_SERVICE).map(([slug, s]) => ({ path: `/is-${slug}-down`, lastmod: latestOf([s.id], changed) })),
    ...STATIC_PATHS.map((path) => ({ path, lastmod: null })),
  ]
}

export function renderSitemapXml(entries: readonly SitemapEntry[]): string {
  const urls = entries.map(({ path, lastmod }) =>
    `  <url>\n    <loc>${ORIGIN}${path}</loc>\n${lastmod ? `    <lastmod>${lastmod}</lastmod>\n` : ''}  </url>`)
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join('\n')}\n</urlset>\n`
}
