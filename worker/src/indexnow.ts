// #887 — IndexNow: on a status-change edge, push the affected is-down URLs to participating engines
// so status queries recrawl fast (query-deserves-freshness). Submitting to api.indexnow.org fans the
// URLs out to Bing, Yandex, Naver, and Seznam (Naver matters for the KR audience). Google does NOT
// support IndexNow, so this COMPLEMENTS — not replaces — Google's own crawl cadence. Fire-and-forget
// with an isolated try-guard so a ping failure can never affect the cron's alert path.
import { isDownUrl } from './rss'
import { fetchWithTimeout } from './utils'

// Public ownership key — hosted at https://ai-watch.dev/<INDEXNOW_KEY>.txt (a `public/` static file,
// NOT a secret; its only purpose is to prove control of the host). Keep the `.txt` file in sync with
// this constant (pinned by indexnow.test.ts is not possible cross-package — see the file comment).
export const INDEXNOW_KEY = '8f2b1a6c4e9d0357a1b8c2f4e6d90b53'
const INDEXNOW_ENDPOINT = 'https://api.indexnow.org/IndexNow'
const HOST = 'ai-watch.dev'

export interface IndexNowBody {
  host: string
  key: string
  keyLocation: string
  urlList: string[]
}

/** Pure — the IndexNow POST body for a set of already-resolved URLs. */
export function buildIndexNowBody(urls: string[], key: string = INDEXNOW_KEY, host: string = HOST): IndexNowBody {
  return { host, key, keyLocation: `https://${host}/${key}.txt`, urlList: urls }
}

/** Pure — dedup service ids → canonical is-down URLs, dropping the dashboard-`#hash` fallbacks that
 *  `isDownUrl` returns for no-is-down-page services (bedrock/azureopenai, #263): those have no
 *  crawlable SSR page, so submitting them to IndexNow would be a 404 waste. */
export function indexNowUrlsFor(svcIds: string[]): string[] {
  const urls = new Set<string>()
  for (const id of svcIds) {
    const u = isDownUrl(id)
    if (u.includes('/is-')) urls.add(u) // exclude `${SITE}/#id` hash fallbacks
  }
  return [...urls]
}

/** Fire-and-forget IndexNow ping for the given service ids. Never throws; returns whether the POST
 *  was accepted. No-op (false) when no id maps to a crawlable is-down page. `fetchImpl` is injectable
 *  for tests; the default is a 5s-timeout-bounded fetch so a hung endpoint can't stall the cron. */
export async function pingIndexNow(
  svcIds: string[],
  fetchImpl: (url: string, init: RequestInit) => Promise<Response> = (url, init) => fetchWithTimeout(url, 5000, init),
): Promise<boolean> {
  const urls = indexNowUrlsFor(svcIds)
  if (urls.length === 0) return false
  try {
    const res = await fetchImpl(INDEXNOW_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify(buildIndexNowBody(urls)),
    })
    if (!res.ok) console.warn(`[cron] #887 IndexNow ping non-OK: ${res.status}`)
    return res.ok
  } catch (e) {
    console.warn('[cron] #887 IndexNow ping failed:', (e as Error).message)
    return false
  }
}
