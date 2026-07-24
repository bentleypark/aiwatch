// #1158 — GitHub repo discovery for badge embeds (weekly, best-effort, fully separate from the
// badge-serving path). #1157 (WAE) answers "how many times was a badge requested" — anonymous
// request volume. This answers "who": which public GitHub repos actually embed an AIWatch badge
// (`/badge/:serviceId`) in their README or status page, via the GitHub Code Search API.
//
// Design (per issue #1158's resolved open questions):
//   - Global "used by" list only, no per-service breakdown — start small, extend later if useful.
//   - Surfaced in the WEEKLY Discord briefing (not daily) — GitHub's code-search index has lag and
//     the search endpoint's own rate limit (~10 req/min authenticated) makes a weekly discovery
//     sweep realistic where a daily one would not add signal.
//   - Requires a classic GitHub PAT (`public_repo` scope) as the `GH_CODE_SEARCH_TOKEN` Worker
//     secret — distinct from `GH_DISPATCH_TOKEN` (#629, scoped to `actions:write` only, cannot
//     search). Fine-grained PAT support for the Search API specifically was uncertain enough at
//     setup time not to risk it.
//
// Known GitHub Code Search API limitations this design accepts:
//   - Only indexes a repo's DEFAULT branch.
//   - Query is TOKENIZED, not true substring/regex matching.
//   - Single request, `per_page=100`, no pagination — if `total_count` ever exceeds 100 this
//     undercounts. Acceptable today (badge adoption is near-zero); revisit if it grows.

const SEARCH_QUERY = 'aiwatch-worker.p2c2kbf.workers.dev/badge'

/** The repo whose own README documents/showcases the badge — not a real adopter. Excluded from
 *  results so the discovery job doesn't "discover" its own source. */
const SELF_REPO = 'bentleypark/aiwatch'

export interface BadgeRepoResult {
  readonly fullName: string // "owner/repo"
  readonly path: string // path within the repo, e.g. "README.md"
  readonly htmlUrl: string // link to the matching file
}

/** Build the GitHub Code Search API request URL. Pure. */
export function buildBadgeSearchUrl(query = SEARCH_QUERY): string {
  return `https://api.github.com/search/code?q=${encodeURIComponent(query)}&per_page=100`
}

/** Parse the GitHub Code Search API JSON into result rows, deduped by repo (a repo can match on
 *  multiple files in the response — only the first hit per repo is kept). Excludes SELF_REPO.
 *  Tolerant of a malformed/missing `items` array — returns null (NOT an empty array) so the caller
 *  treats it the same as an HTTP failure, distinct from "genuinely zero matches this week". */
export function parseBadgeSearchResponse(json: unknown): BadgeRepoResult[] | null {
  const items = (json as { items?: unknown })?.items
  if (!Array.isArray(items)) return null
  const seen = new Set<string>()
  const out: BadgeRepoResult[] = []
  for (const item of items) {
    const it = item as { path?: unknown; html_url?: unknown; repository?: { full_name?: unknown } }
    const fullName = it.repository?.full_name
    if (typeof fullName !== 'string' || !fullName) continue
    if (fullName.toLowerCase() === SELF_REPO) continue
    if (seen.has(fullName)) continue
    seen.add(fullName)
    out.push({
      fullName,
      path: typeof it.path === 'string' ? it.path : '',
      htmlUrl: typeof it.html_url === 'string' ? it.html_url : '',
    })
  }
  return out
}

/**
 * Parse the persisted `badge:repos:seen` KV value. Mirrors `parseStrategyBrief`'s tolerant-parse
 * shape (weekly-briefing.ts), extracted so this logic is unit-testable rather than living inline
 * in index.ts's cron block.
 *
 * Returns `[]` for a genuinely-absent key (`raw === null`) — that's a real "first run ever, no
 * history yet" state, safe to treat as empty. Returns `null` for anything ELSE that isn't a clean
 * string array (invalid JSON, non-array JSON, any non-string element) — the caller MUST treat
 * `null` as "unreadable / corrupt", NOT as empty, and skip persisting a diff computed against it.
 * Collapsing "corrupt" into "empty" was a real bug: `badge:repos:seen` is a PERMANENT accumulator
 * with no recovery path (unlike `component-seen:`, #992's superficially-similar corrupt→empty
 * fallback, whose worst case is a bounded, non-destructive re-alert) — persisting a diff computed
 * against a false "empty" baseline overwrites real adopter history with just that week's hits.
 */
export function parseBadgeReposSeen(raw: string | null): string[] | null {
  if (raw === null) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!Array.isArray(parsed)) return null
  if (!parsed.every((x): x is string => typeof x === 'string')) return null
  return parsed
}

/** Query GitHub Code Search for badge embeds. Best-effort: null on missing token / HTTP failure /
 *  unparseable response. Never throws — this runs on a fully separate weekly cron branch from
 *  `/badge/:serviceId` serving, but follows the same never-throw discipline as `queryBadgeTraffic`
 *  so callers don't need special-case error handling. */
export async function searchBadgeEmbeds(
  token: string | undefined,
  fetchImpl: typeof fetch = fetch,
): Promise<BadgeRepoResult[] | null> {
  if (!token) return null
  try {
    const res = await fetchImpl(buildBadgeSearchUrl(), {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'aiwatch-worker',
      },
    })
    if (!res.ok) {
      console.warn(`[badge-repo-discovery] GitHub search failed: HTTP ${res.status}`)
      return null
    }
    return parseBadgeSearchResponse(await res.json())
  } catch (err) {
    console.warn('[badge-repo-discovery] GitHub search error:', err instanceof Error ? err.message : err)
    return null
  }
}

export interface BadgeRepoDiscoveryDiff {
  readonly newRepos: readonly BadgeRepoResult[] // in this run's results but NOT in the persisted seen set
  readonly seen: readonly string[] // the UPDATED seen set (union of previous + this run) — persist this
  readonly totalKnown: number // seen.length, for the "N known total" line
}

/** Pure diff: given this run's search results and the previously-persisted "seen" full_name set,
 *  return which repos are NEW this run (surfaced in the briefing) and the updated seen set to
 *  persist — so next week's run only reports genuinely new adopters, not the same list every time.
 *  `seen` is sorted for a stable, diffable persisted value. */
export function diffBadgeRepoDiscovery(
  results: BadgeRepoResult[],
  previouslySeen: string[],
): BadgeRepoDiscoveryDiff {
  const seenSet = new Set(previouslySeen)
  const newRepos = results.filter((r) => !seenSet.has(r.fullName))
  for (const r of results) seenSet.add(r.fullName)
  const seen = Array.from(seenSet).sort()
  return { newRepos, seen, totalKnown: seen.length }
}

/** Format the weekly-briefing section (#1158). Empty string when there's nothing new this week —
 *  most weeks will have zero new adopters, and a "0 new" line every week for months is noise (same
 *  omit-when-quiet convention as the weekly briefing's Security section). Caps the listed repos at
 *  10 (Discord embed description budget is shared across every weekly-briefing section). */
export function formatBadgeRepoDiscoverySection(diff: BadgeRepoDiscoveryDiff | null): string {
  if (!diff || diff.newRepos.length === 0) return ''
  const lines = [
    `\n🔗 **Badge Adopters**`,
    `${diff.newRepos.length} new repo${diff.newRepos.length === 1 ? '' : 's'} found this week (${diff.totalKnown} known total):`,
  ]
  for (const r of diff.newRepos.slice(0, 10)) {
    lines.push(`• ${r.fullName}`)
  }
  if (diff.newRepos.length > 10) lines.push(`… and ${diff.newRepos.length - 10} more`)
  return lines.join('\n')
}
