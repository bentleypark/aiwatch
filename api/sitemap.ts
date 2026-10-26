// Vercel Edge Function — /sitemap.xml (#887 Phase 3). Builder + rules: api/_sitemap/build.ts.
import { hedgedJsonFetch } from './_shared/hedged-fetch'
import { resolveWorkerApi } from './_shared/worker-api'
import { parseSitemapFeed, renderSitemapXml, sitemapEntries } from './_sitemap/build'

export const config = { runtime: 'edge' }

const WORKER_API = 'https://aiwatch-worker.p2c2kbf.workers.dev'

const workerApi = resolveWorkerApi(WORKER_API)

export default async function handler(_req: Request) {
  const feed = await hedgedJsonFetch(`${workerApi}/api/status/cached?src=sitemap`)
  if (!feed.ok) console.warn(`[sitemap] worker read failed (${feed.reason}) — serving without lastmod`)
  const changed = feed.ok ? parseSitemapFeed(feed.data) : new Map<string, string>()
  return new Response(renderSitemapXml(sitemapEntries(changed)), {
    headers: {
      'Content-Type': 'application/xml; charset=utf-8',
      'Cache-Control': feed.ok ? 'public, max-age=0, s-maxage=300' : 'public, max-age=0, s-maxage=60',
    },
  })
}
