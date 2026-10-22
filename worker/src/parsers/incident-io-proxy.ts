// incident.io pages whose page-root RSC does not embed the page data (#1752).
//
// The root HTML of status.elevenlabs.io carries no `component_impacts`, `component_uptimes` or
// `incident_links`, and its summary.json / components.json return `components: []`. The page client reads
// the same data from `/proxy/<host>/…` JSON endpoints (not a documented API); this module reads those and
// renders them as the RSC chunk the existing parsers read.

const DAY_MS = 86_400_000
/** What the page itself draws (`history_window_days`). */
const WINDOW_DAYS = 90

type Fetcher = (url: string) => Promise<Response>

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

const isoSecond = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z')

export function incidentIoProxyUrls(statusUrl: string, nowMs: number): { summary: string; impacts: string; feed: string } {
  const u = new URL(statusUrl)
  const base = `${u.origin}/proxy/${u.host}`
  return {
    summary: base,
    impacts: `${base}/component_impacts?start_at=${isoSecond(nowMs - WINDOW_DAYS * DAY_MS)}&end_at=${isoSecond(nowMs)}`,
    feed: `${base}/incidents`,
  }
}

/** The three payloads rendered as one page-root RSC chunk, or null when any of them is not the shape the
 *  parsers need. Null, never a partial chunk: a missing `component_impacts` would read as "no downtime". */
export function buildIncidentIoProxyHtml(summary: unknown, impacts: unknown, feed: unknown): string | null {
  const page = isRecord(summary) ? summary.summary : null
  const structure = isRecord(page) ? page.structure : null
  if (!isRecord(structure) || !Array.isArray(structure.items)) return null
  if (!isRecord(impacts) || !Array.isArray(impacts.component_impacts) || !Array.isArray(impacts.component_uptimes)) return null
  if (impacts.incident_links !== undefined && !Array.isArray(impacts.incident_links)) return null
  if (!isRecord(feed) || !Array.isArray(feed.incidents)) return null
  const rsc = {
    structure,
    incidents: feed.incidents,
    incident_links: impacts.incident_links ?? [],
    component_impacts: impacts.component_impacts,
    component_uptimes: impacts.component_uptimes,
  }
  const pushed = JSON.stringify(rsc).replace(/"/g, '\\"')
  return `<script>self.__next_f.push([1,"${pushed}"])</script>`
}

async function readJson(res: Response, what: string): Promise<unknown> {
  if (!res.ok) {
    console.warn(`[incident-io-proxy] ${what} returned HTTP ${res.status}`)
    res.body?.cancel()
    return null
  }
  try { return await res.json() }
  catch (err) {
    console.warn(`[incident-io-proxy] ${what} is not JSON:`, err instanceof Error ? err.message : err)
    return null
  }
}

export async function fetchIncidentIoProxyHtml(statusUrl: string, fetcher: Fetcher, nowMs: number = Date.now()): Promise<string | null> {
  const urls = incidentIoProxyUrls(statusUrl, nowMs)
  try {
    const [summaryRes, impactsRes, feedRes] = await Promise.all([fetcher(urls.summary), fetcher(urls.impacts), fetcher(urls.feed)])
    const [summary, impacts, feed] = await Promise.all([
      readJson(summaryRes, urls.summary), readJson(impactsRes, urls.impacts), readJson(feedRes, urls.feed),
    ])
    const html = buildIncidentIoProxyHtml(summary, impacts, feed)
    if (html === null && summary !== null && impacts !== null && feed !== null) {
      console.warn(`[incident-io-proxy] ${statusUrl}: a /proxy payload answered 200 but is not the expected shape — upstream change?`)
    }
    return html
  } catch (err) {
    console.warn(`[incident-io-proxy] ${statusUrl} fetch failed:`, err instanceof Error ? err.message : err)
    return null
  }
}
