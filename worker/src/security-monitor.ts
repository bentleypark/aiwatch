// Security incident monitoring for AI services
// Sources: Hacker News Algolia API, OSV.dev vulnerability database
// Runs hourly alongside Reddit security monitoring

// ---------- Types ----------

export interface SecurityAlert {
  source: 'hackernews' | 'osv'
  id: string             // HN story ID or OSV vuln ID
  title: string
  url: string
  severity?: 'critical' | 'high' | 'medium' | 'low'
  kvKey: string          // KV dedup key
  // OSV-specific remediation info
  service?: string            // e.g. "Hugging Face" — mapped AIWatch service name
  affectedPackage?: string   // e.g. "PyPI/anthropic"
  affectedRange?: string     // e.g. ">= 0.86.0"
  fixedVersion?: string      // e.g. "0.87.0"
  patchUrl?: string          // commit or release URL
  cweIds?: string[]          // e.g. ["CWE-276"]
  // EPSS (Exploit Prediction Scoring System) — from GitHub Advisories API (#326).
  // Proxy for real-world exploitation likelihood. Both fields are 0..1 floats.
  // Thresholds for the UI/Discord tag live on `EPSS_ELEVATED` / `EPSS_ACTIVE`
  // (single source of truth — do not duplicate the numbers in field comments).
  // Missing = enrichment unavailable (pre-#326, cache miss + HTTP failure, or rate-limited).
  epssPercentile?: number
  epssPercentage?: number    // absolute probability of exploit in next 30d
}

// ---------- Hacker News Algolia ----------

const HN_AI_KEYWORDS = [
  'openai', 'anthropic', 'claude', 'chatgpt', 'gemini', 'mistral',
  'cohere', 'deepseek', 'huggingface', 'hugging face', 'replicate',
  'elevenlabs', 'cursor', 'copilot', 'windsurf', 'xai', 'grok',
]

const HN_SECURITY_KEYWORDS = [
  'breach', 'leak', 'hacked', 'vulnerability', 'CVE', 'exploit',
  'unauthorized', 'security incident', 'data exposure', 'compromised',
  'RCE', 'injection', 'exfiltration',
]

function buildHNQuery(): string {
  // "(openai OR anthropic OR claude OR ...) AND (breach OR leak OR ...)"
  const ai = HN_AI_KEYWORDS.map(k => `"${k}"`).join(' OR ')
  const sec = HN_SECURITY_KEYWORDS.map(k => `"${k}"`).join(' OR ')
  return `(${ai}) AND (${sec})`
}

interface HNHit {
  objectID: string
  title: string
  url: string | null
  points: number
  created_at_i: number
}

export async function fetchHNSecurityPosts(): Promise<SecurityAlert[]> {
  const oneDayAgo = Math.floor(Date.now() / 1000) - 86400
  const query = buildHNQuery()
  const params = new URLSearchParams({
    query,
    tags: 'story',
    numericFilters: `created_at_i>${oneDayAgo}`,
    hitsPerPage: '10',
  })

  const res = await fetch(`https://hn.algolia.com/api/v1/search?${params}`, {
    headers: { 'User-Agent': 'AIWatch/1.0 (ai-watch.dev; security monitoring)' },
    signal: AbortSignal.timeout(5000),
  })

  if (!res.ok) {
    console.error(`[security] HN Algolia returned HTTP ${res.status}`)
    res.body?.cancel()
    return []
  }

  const json = await res.json() as { hits?: HNHit[] }
  if (!json.hits) return []

  return json.hits
    .filter(hit => hit.title && hit.objectID)
    .map(hit => ({
      source: 'hackernews' as const,
      id: hit.objectID,
      title: hit.title,
      url: hit.url || `https://news.ycombinator.com/item?id=${hit.objectID}`,
      kvKey: `security:seen:hn:${hit.objectID}`,
    }))
}

// ---------- OSV.dev (AI SDK vulnerabilities) ----------

// Keep the OSV_SERVICE_MAP in src/pages/ServiceDetails.jsx in sync when editing
// — its keys must cover every `service` label used here or the Security Alerts
// card will silently drop entries for the unmapped service.
// Exported for invariant tests only; production callers never import it directly.
export const OSV_PACKAGES = [
  // Major LLM providers — PyPI
  { name: 'openai', ecosystem: 'PyPI', service: 'OpenAI' },
  { name: 'anthropic', ecosystem: 'PyPI', service: 'Anthropic (Claude)' },
  { name: 'google-generativeai', ecosystem: 'PyPI', service: 'Google (Gemini)' },
  { name: 'cohere', ecosystem: 'PyPI', service: 'Cohere' },
  { name: 'mistralai', ecosystem: 'PyPI', service: 'Mistral' },
  // Inference / cloud LLM — PyPI
  { name: 'together', ecosystem: 'PyPI', service: 'Together' },
  { name: 'groq', ecosystem: 'PyPI', service: 'Groq' },
  { name: 'replicate', ecosystem: 'PyPI', service: 'Replicate' },
  // Voice — PyPI
  { name: 'assemblyai', ecosystem: 'PyPI', service: 'AssemblyAI' },
  { name: 'deepgram-sdk', ecosystem: 'PyPI', service: 'Deepgram' },
  // LangChain ecosystem — per-provider adapters live in separate PyPI packages
  // since LangChain 0.1; tracking the meta-package alone misses CVEs like
  // GHSA-3hjh-jh2h-vrg6 (DoS in langchain-community, 2024-06).
  { name: 'langchain', ecosystem: 'PyPI', service: 'LangChain' },
  { name: 'langchain-community', ecosystem: 'PyPI', service: 'LangChain' },
  { name: 'langchain-core', ecosystem: 'PyPI', service: 'LangChain' },
  { name: 'langchain-openai', ecosystem: 'PyPI', service: 'LangChain' },
  { name: 'langchain-anthropic', ecosystem: 'PyPI', service: 'LangChain' },
  { name: 'langchain-google-genai', ecosystem: 'PyPI', service: 'LangChain' },
  // ML infra — PyPI
  { name: 'transformers', ecosystem: 'PyPI', service: 'Hugging Face' },
  // npm
  { name: 'openai', ecosystem: 'npm', service: 'OpenAI' },
  { name: '@anthropic-ai/sdk', ecosystem: 'npm', service: 'Anthropic (Claude)' },
  { name: '@google/generative-ai', ecosystem: 'npm', service: 'Google (Gemini)' },
  { name: 'replicate', ecosystem: 'npm', service: 'Replicate' },
  { name: 'groq-sdk', ecosystem: 'npm', service: 'Groq' },
  { name: 'assemblyai', ecosystem: 'npm', service: 'AssemblyAI' },
  { name: '@deepgram/sdk', ecosystem: 'npm', service: 'Deepgram' },
  // Intentionally NOT included: `npm/together` — that name is a pre-existing
  // unrelated HTML utility, not the Together AI SDK (as of 2026-04).
]

interface OSVVuln {
  id: string
  summary?: string
  details?: string
  severity?: Array<{ type: string; score: string }>
  references?: Array<{ type: string; url: string }>
  affected?: Array<{
    package?: { name: string; ecosystem: string }
    ranges?: Array<{
      type: string
      events: Array<{ introduced?: string; fixed?: string }>
    }>
  }>
  database_specific?: { severity?: string; cwe_ids?: string[] }
  modified: string
}

// Map OSV severity text label to our severity level
const SEVERITY_TEXT_MAP: Record<string, SecurityAlert['severity']> = {
  CRITICAL: 'critical', HIGH: 'high', MODERATE: 'medium', MEDIUM: 'medium', LOW: 'low',
}

export function mapOSVSeverity(vuln: OSVVuln): SecurityAlert['severity'] {
  // 1. Try numeric CVSS score (some entries use plain number)
  for (const s of vuln.severity ?? []) {
    const numeric = parseFloat(s.score)
    if (!Number.isNaN(numeric)) {
      if (numeric >= 9.0) return 'critical'
      if (numeric >= 7.0) return 'high'
      if (numeric >= 4.0) return 'medium'
      return 'low'
    }
  }
  // 2. Fall back to database_specific.severity text (e.g. "MODERATE", "CRITICAL")
  const textSeverity = vuln.database_specific?.severity?.toUpperCase()
  if (textSeverity && textSeverity in SEVERITY_TEXT_MAP) {
    return SEVERITY_TEXT_MAP[textSeverity]!
  }
  return 'medium'
}

// Phase-1 candidate — see fetchOSVAlerts for the two-phase rationale.
// `modified` is consumed by the 7-day filter inside listOSVCandidates and
// intentionally not carried forward (candidates only need routing info).
interface OSVCandidate {
  id: string
  packageIndex: number
}

// Phase 1 — single batch request instead of N per-package calls; OSV's querybatch
// is designed for bulk dedup/scan and avoids per-package rate-limit pressure.
// Throws on HTTP error so the outer Promise.allSettled in detectSecurityAlerts
// logs it via `[security] OSV.dev fetch failed` — a silent `return []` would be
// indistinguishable from a legitimate "no vulns this cycle".
export async function listOSVCandidates(): Promise<OSVCandidate[]> {
  const sevenDaysAgo = new Date(Date.now() - 7 * 86400 * 1000).toISOString()

  const queries = OSV_PACKAGES.map(pkg => ({ package: { name: pkg.name, ecosystem: pkg.ecosystem } }))

  const res = await fetch('https://api.osv.dev/v1/querybatch', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': 'AIWatch/1.0 (ai-watch.dev; security monitoring)' },
    body: JSON.stringify({ queries }),
    signal: AbortSignal.timeout(8000),
  })

  if (!res.ok) {
    res.body?.cancel()
    throw new Error(`OSV querybatch HTTP ${res.status}`)
  }

  const json = await res.json() as { results?: Array<{ vulns?: Array<{ id: string; modified: string }> }> }
  if (!json.results) return []

  const candidates: OSVCandidate[] = []
  for (let i = 0; i < json.results.length; i++) {
    const vulns = json.results[i]?.vulns
    if (!vulns) continue
    for (const v of vulns) {
      if (v.modified < sevenDaysAgo) continue
      candidates.push({ id: v.id, packageIndex: i })
    }
  }
  return candidates
}

// Phase 2 — fetch the full vuln document for a single candidate.
// Returns null on network/HTTP failure so the orchestrator can drop just this alert
// rather than fail the whole batch (Promise.allSettled also catches throws).
export async function fetchOSVVulnDetails(candidate: OSVCandidate): Promise<SecurityAlert | null> {
  const res = await fetch(`https://api.osv.dev/v1/vulns/${candidate.id}`, {
    headers: { 'User-Agent': 'AIWatch/1.0 (ai-watch.dev; security monitoring)' },
    signal: AbortSignal.timeout(8000),
  })

  if (!res.ok) {
    console.error(`[security] OSV.dev vuln fetch returned HTTP ${res.status} for ${candidate.id}`)
    res.body?.cancel()
    return null
  }

  const v = await res.json() as OSVVuln
  const pkg = OSV_PACKAGES[candidate.packageIndex]
  if (!pkg) {
    console.error(`[security] OSV_PACKAGES index ${candidate.packageIndex} out of bounds for ${candidate.id}`)
    return null
  }

  const aff = v.affected?.[0]
  const range = aff?.ranges?.[0]
  const introduced = range?.events?.find(e => e.introduced)?.introduced
  const fixed = range?.events?.find(e => e.fixed)?.fixed
  const patchUrl = v.references?.find(r =>
    r.url.includes('/commit/') || r.url.includes('/releases/tag/'),
  )?.url

  return {
    source: 'osv' as const,
    id: v.id,
    title: v.summary || `${v.id}: ${pkg.ecosystem}/${pkg.name}`,
    url: v.references?.find(r => r.type === 'WEB' || r.type === 'ADVISORY')?.url
      || `https://osv.dev/vulnerability/${v.id}`,
    severity: mapOSVSeverity(v),
    kvKey: `security:seen:osv:${v.id}`,
    service: pkg.service,
    affectedPackage: `${pkg.ecosystem}/${pkg.name}`,
    affectedRange: introduced ? `>= ${introduced}` : undefined,
    fixedVersion: fixed,
    patchUrl,
    cweIds: v.database_specific?.cwe_ids,
  }
}

// Cap per-cycle detail fetches to protect the Workers subrequest budget on first
// deploy, KV wipe, or post-outage catch-up (where `unseen` can be a large batch).
// Over-cap vulns aren't lost — the `security:seen:*` write happens in the caller
// (worker/src/index.ts cron handler) only for surfaced alerts, so truncated
// candidates stay unseen and re-appear next cycle. If dedup-write ever moves
// inside fetchOSVAlerts, this guarantee breaks — update both sides together.
const OSV_MAX_DETAIL_FETCH = 15

// Two-phase OSV fetch (#323): querybatch returns only id + modified, so we must
// GET /v1/vulns/{id} per candidate to get summary/severity/references/affected.
// Dedup runs between phases so vulns already marked seen by a prior cron cycle
// skip the per-vuln detail fetch.
// `kv = null` default is for test ergonomics; production always passes env.STATUS_CACHE.
export async function fetchOSVAlerts(kv: KVNamespace | null = null): Promise<SecurityAlert[]> {
  const candidates = await listOSVCandidates()
  if (candidates.length === 0) return []

  // Phase 1.5 — pre-dedup against seen-markers from prior cycles.
  let unseen: OSVCandidate[] = candidates
  if (kv) {
    const seenFlags = await Promise.allSettled(
      candidates.map(c => kv.get(`security:seen:osv:${c.id}`)),
    )
    unseen = candidates.filter((c, i) => {
      const r = seenFlags[i]
      if (r?.status === 'rejected') {
        // Fail open: treat as unseen so transient KV outages don't mask new CVEs,
        // but surface the failure — silent fail-open hides prolonged KV issues.
        console.error(
          `[security] OSV pre-dedup KV read failed for ${c.id}; treating as unseen:`,
          r.reason instanceof Error ? r.reason.message : r.reason,
        )
        return true
      }
      return !(r?.status === 'fulfilled' && r.value)
    })
  }
  if (unseen.length === 0) return []

  if (unseen.length > OSV_MAX_DETAIL_FETCH) {
    console.warn(`[security] OSV unseen=${unseen.length} capped at ${OSV_MAX_DETAIL_FETCH} for this cycle; overflow retried next cron`)
    unseen = unseen.slice(0, OSV_MAX_DETAIL_FETCH)
  }

  // Phase 2 — parallel per-vuln detail fetch. allSettled so one failure doesn't drop the batch.
  const settled = await Promise.allSettled(unseen.map(fetchOSVVulnDetails))
  const alerts: SecurityAlert[] = []
  let droppedHttp = 0
  let droppedThrew = 0
  for (const r of settled) {
    if (r.status === 'fulfilled' && r.value) alerts.push(r.value)
    else if (r.status === 'fulfilled') droppedHttp++  // null → HTTP error already logged in fetchOSVVulnDetails
    else {
      droppedThrew++
      console.error('[security] OSV.dev vuln fetch threw:', r.reason instanceof Error ? r.reason.message : r.reason)
    }
  }
  // Single aggregate line so a scatter of per-id HTTP errors produces one actionable signal.
  if (droppedHttp + droppedThrew > 0) {
    console.warn(`[security] OSV detail fetch dropped ${droppedHttp + droppedThrew}/${unseen.length} (http=${droppedHttp}, threw=${droppedThrew})`)
  }
  return alerts
}

// ---------- EPSS enrichment (#326) ----------
//
// EPSS (Exploit Prediction Scoring System) is published by FIRST.org and surfaces
// the probability a given CVE will be exploited in the wild within 30 days. GitHub's
// Advisories API embeds it inline on every GHSA response, so we get it with one HTTP
// call per vuln. A 🟠 "high" CVSS alert at EPSS 2%ile is lab-only; the same severity
// at 80%ile means active scanning — this signal changes operator prioritization.
//
// Enrichment is fail-open: if GitHub rejects, rate-limits, or returns no EPSS field,
// the alert still surfaces — just without the elevation tag. Missing is the default.

// Single source of truth for the display/alert thresholds. Tuning these values
// takes effect across formatEpssTag (Discord + tests) and the dashboard prefix
// rendering (src/pages/ServiceDetails.jsx mirrors these — keep in sync).
// Both fields are an EPSS **percentile** (0..1), not a raw probability.
export const EPSS_ELEVATED = 0.5
export const EPSS_ACTIVE = 0.8

export interface EpssScore {
  // Invariant: `fetchEPSS` only returns an EpssScore if BOTH fields are numeric
  // (see type guard in fetchEPSS). Downstream consumers can rely on either being
  // defined without checking the other.
  percentile: number  // 0..1
  percentage: number  // 0..1
}

// Cache 24h — EPSS is recomputed daily, so same-day re-fetches are wasteful.
// Corrupt cache (parse error) is treated as miss; no retry-storm protection needed
// because HTTP fetch caps itself at the outer rate-limit log.
export async function fetchEPSS(ghsaId: string, kv: KVNamespace | null): Promise<EpssScore | undefined> {
  const cacheKey = `enrich:epss:${ghsaId}`
  if (kv) {
    // Match observability parity with OSV pre-dedup / HN dedup: a silent KV outage
    // here would masquerade as "always cache miss → always hit GitHub" and quietly
    // burn the 60 req/h unauth rate limit with no correlating log.
    const cached = await kv.get(cacheKey).catch(err => {
      console.warn('[security] EPSS cache read failed:', ghsaId, err instanceof Error ? err.message : err)
      return null
    })
    if (cached) {
      try {
        const parsed = JSON.parse(cached) as EpssScore
        if (typeof parsed.percentile === 'number' && typeof parsed.percentage === 'number') {
          return parsed
        }
      } catch {
        // Persistent corruption means the writer is producing bad JSON or a
        // schema migration left stale entries. Log once (length, not content —
        // could be large) so operators can correlate with writer changes.
        console.warn(`[security] EPSS cache corrupt for ${ghsaId}, refetching (len=${cached.length})`)
      }
    }
  }

  let res: Response
  try {
    res = await fetch(`https://api.github.com/advisories/${ghsaId}`, {
      headers: {
        'Accept': 'application/vnd.github+json',
        'User-Agent': 'AIWatch/1.0 (ai-watch.dev; epss enrichment)',
      },
      signal: AbortSignal.timeout(5000),
    })
  } catch (err) {
    console.warn(`[security] EPSS fetch for ${ghsaId} threw:`, err instanceof Error ? err.message : err)
    return undefined
  }

  if (!res.ok) {
    res.body?.cancel()
    if (res.status === 403 || res.status === 429) {
      console.warn(`[security] GitHub Advisories rate-limited during EPSS enrichment (HTTP ${res.status}); remaining vulns this cycle will surface without EPSS`)
    } else {
      console.warn(`[security] GitHub Advisories HTTP ${res.status} for ${ghsaId}`)
    }
    return undefined
  }

  let data: { epss?: { percentile?: unknown; percentage?: unknown } | null }
  try {
    data = await res.json()
  } catch (err) {
    console.warn(`[security] GitHub Advisories JSON parse failed for ${ghsaId}:`, err instanceof Error ? err.message : err)
    return undefined
  }
  const epss = data?.epss
  if (!epss || typeof epss.percentile !== 'number' || typeof epss.percentage !== 'number') {
    return undefined
  }

  const score: EpssScore = { percentile: epss.percentile, percentage: epss.percentage }
  if (kv) {
    await kv.put(cacheKey, JSON.stringify(score), { expirationTtl: 86400 }).catch(err =>
      console.warn('[security] EPSS cache write failed:', ghsaId, err instanceof Error ? err.message : err),
    )
  }
  return score
}

// Parallel EPSS enrichment across a batch of alerts. OSV-only — HN alerts have
// no CVE identifier so there's nothing to enrich. Fail-open per alert: any
// enrichment failure (HTTP, timeout, rate-limit) drops the score but preserves
// the alert.
export async function enrichAlertsWithEPSS(
  alerts: SecurityAlert[],
  kv: KVNamespace | null,
): Promise<SecurityAlert[]> {
  const settled = await Promise.allSettled(
    alerts.map(async (alert) => {
      if (alert.source !== 'osv') return alert
      const score = await fetchEPSS(alert.id, kv)
      if (!score) return alert
      return { ...alert, epssPercentile: score.percentile, epssPercentage: score.percentage }
    }),
  )
  return settled.map((r, i) => r.status === 'fulfilled' ? r.value : alerts[i]!)
}

// ---------- Orchestrator ----------

export async function detectSecurityAlerts(
  kv: KVNamespace | null,
): Promise<SecurityAlert[]> {
  if (!kv) return []

  // OSV alerts are pre-deduped inside fetchOSVAlerts (avoids per-vuln detail fetches
  // for already-seen entries). HN still needs dedup here since fetchHNSecurityPosts
  // doesn't touch KV.
  const [hnAlerts, osvAlerts] = await Promise.allSettled([
    fetchHNSecurityPosts(),
    fetchOSVAlerts(kv),
  ])

  if (hnAlerts.status === 'rejected') {
    console.error('[security] HN Algolia fetch failed:', hnAlerts.reason instanceof Error ? hnAlerts.reason.message : hnAlerts.reason)
  }
  if (osvAlerts.status === 'rejected') {
    console.error('[security] OSV.dev fetch failed:', osvAlerts.reason instanceof Error ? osvAlerts.reason.message : osvAlerts.reason)
  }

  const hnFinal: SecurityAlert[] = []
  if (hnAlerts.status === 'fulfilled') {
    for (const alert of hnAlerts.value) {
      const seen = await kv.get(alert.kvKey).catch((err) => {
        console.error('[security] KV dedup read failed:', alert.kvKey, err instanceof Error ? err.message : err)
        return null
      })
      if (seen) continue
      hnFinal.push(alert)
    }
  }

  const combined = [
    ...hnFinal,
    ...(osvAlerts.status === 'fulfilled' ? osvAlerts.value : []),
  ]
  // #326: enrich OSV alerts with EPSS (fail-open). Inside detectSecurityAlerts so
  // everything downstream (Discord format, KV meta write, dashboard display) sees
  // the enriched shape without each caller needing to re-run the enrichment.
  return enrichAlertsWithEPSS(combined, kv)
}

// ---------- Discord formatting ----------

const SEVERITY_EMOJI: Record<string, string> = {
  critical: '🔴',
  high: '🟠',
  medium: '🟡',
  low: '🟢',
}

// Promote EPSS into the header line (#326) — operators scan the emoji + label combo
// to triage which findings need action this week vs background noise. Thresholds
// live on EPSS_ELEVATED / EPSS_ACTIVE above; below the elevated line we skip the
// tag entirely to avoid crowding low-signal advisories.
export function formatEpssTag(percentile: number | undefined): string | null {
  if (percentile == null) return null
  if (percentile >= EPSS_ACTIVE) return `🔥 Actively exploited (EPSS ${Math.round(percentile * 100)}%ile)`
  if (percentile >= EPSS_ELEVATED) return `⚠️ Elevated exploit risk (EPSS ${Math.round(percentile * 100)}%ile)`
  return null
}

function formatOSVLine(alert: SecurityAlert): string {
  const emoji = SEVERITY_EMOJI[alert.severity || 'medium']
  const serviceTag = alert.service ? `[${alert.service}] ` : ''
  const epssTag = formatEpssTag(alert.epssPercentile)
  const header = `${emoji} ${serviceTag}**${alert.id}** · ${alert.affectedPackage || 'unknown'}`
  const parts = [epssTag ? `${header} · ${epssTag}` : header]
  parts.push(alert.title)
  if (alert.fixedVersion) {
    const cmd = alert.affectedPackage?.startsWith('npm/')
      ? `npm install ${alert.affectedPackage.slice(4)}@${alert.fixedVersion}`
      : `pip install ${alert.affectedPackage?.split('/')[1] || 'package'}>=${alert.fixedVersion}`
    parts.push(`→ \`${cmd}\``)
  } else if (alert.affectedRange) {
    parts.push(`Affected: ${alert.affectedRange}`)
  }
  parts.push(`[Details](${alert.url})`)
  return parts.join('\n')
}

function formatHNLine(alert: SecurityAlert): string {
  const hnUrl = `https://news.ycombinator.com/item?id=${alert.id}`
  const sourceLink = alert.url !== hnUrl ? ` · [Source](${alert.url})` : ''
  return `• ${alert.title}\n  [HN](${hnUrl})${sourceLink}`
}

/**
 * Format all security alerts into a single Discord embed.
 * Groups OSV vulnerabilities and HN news into sections.
 */
export function formatSecurityDigest(alerts: SecurityAlert[]): {
  title: string
  description: string
  color: number
} {
  const osvAlerts = alerts.filter(a => a.source === 'osv')
  const hnAlerts = alerts.filter(a => a.source === 'hackernews')

  const sections: string[] = []

  if (osvAlerts.length > 0) {
    sections.push(`**SDK Vulnerabilities (${osvAlerts.length})**`)
    for (const alert of osvAlerts) {
      sections.push(formatOSVLine(alert))
    }
  }

  if (hnAlerts.length > 0) {
    if (sections.length > 0) sections.push('')
    sections.push(`**Security News (${hnAlerts.length})**`)
    for (const alert of hnAlerts) {
      sections.push(formatHNLine(alert))
    }
  }

  // Color: highest severity wins
  const hasCritical = osvAlerts.some(a => a.severity === 'critical')
  const hasHigh = osvAlerts.some(a => a.severity === 'high')
  const color = hasCritical ? 0xf85149 : hasHigh ? 0xd29922 : 0x8b949e

  return {
    title: `🔒 Security Alert — ${alerts.length} new finding${alerts.length > 1 ? 's' : ''}`,
    description: sections.join('\n'),
    color,
  }
}

// #288: daily counter for "security alerts detected today" in the daily summary.
// security:seen:* has 7d TTL for dedup — conflating it with "today's count" inflates the
// number by up to a factor of 7. This counter is incremented per new alert in the cron
// dispatch path and read fresh by the daily summary.

/** KV key for the daily detected-alert counter, scoped to UTC date. */
export function securityDetectedKey(dateUtc: string): string {
  return `security:detected:${dateUtc}`
}

/** Parse the stored counter and add N. Treats missing/corrupt values as 0 to avoid NaN propagation. */
export function incrementSecurityCount(raw: string | null, addBy: number): number {
  const prev = raw ? parseInt(raw, 10) : 0
  return (Number.isFinite(prev) ? prev : 0) + addBy
}

/**
 * Shape of dashboard-surfaced security alert metadata stored in KV under `security:seen:*`.
 * Separate from `SecurityAlert` (which is the detection-time shape with `id`) — once an alert
 * is dedup-stored, only the display fields matter. `detectedAt` is added at write time so the
 * dashboard can filter to a 24h window.
 */
export interface SecurityAlertMeta {
  title: string
  url: string
  source: string
  severity?: string
  service?: string
  detectedAt?: string
  // #326 — EPSS fields mirror SecurityAlert so the dashboard can render exploit
  // probability without re-fetching. Snapshotted at detection time; a later EPSS
  // change doesn't update the meta (dedup key is 7d TTL — stale enough to matter
  // only if EPSS shifts drastically, at which point the alert re-surfaces anyway).
  epssPercentile?: number
  epssPercentage?: number
}

/**
 * Invariant: `/api/status` and `/api/status/cached` must emit the same `securityAlerts`
 * shape. Asymmetric responses would flap the dashboard banner on 60s silent polls (#304).
 *
 * Returns at most 20 alerts; malformed entries and legacy `"1"` marker values are skipped.
 * Swallows KV list/get errors — security data is optional display, not a hard dependency.
 */
export async function readRecentSecurityAlerts(kv: KVNamespace | null): Promise<SecurityAlertMeta[]> {
  if (!kv) return []
  const alerts: SecurityAlertMeta[] = []
  try {
    const secKeys = await kv.list({ prefix: 'security:seen:', limit: 20 })
    if (secKeys.keys.length === 0) return alerts
    const results = await Promise.allSettled(
      secKeys.keys.map(k => kv.get(k.name)),
    )
    for (const r of results) {
      if (r.status !== 'fulfilled' || !r.value || r.value === '1') continue
      try { alerts.push(JSON.parse(r.value)) } catch { /* skip malformed */ }
    }
  } catch { /* security data is optional — don't fail the response */ }
  return alerts
}

// ── OSV per-alert timeline tracking (#291) ─────────────────────────────────
//
// Captures real transitions — patch availability, severity shifts — against an
// OSV alert so the monthly report can show progression ("T+0 detected → T+6h
// fix released → T+26h severity raised"). Stored under security:timeline:osv:{id}
// with NO TTL (permanent); the dedup-oriented security:seen:osv:* key (7d TTL)
// is unchanged and kept separate.

export type OsvTimelineStage = 'detected' | 'severity_changed' | 'fix_released' | 'cve_merged' | 'withdrawn'

export interface OsvTimelineEntry {
  stage: OsvTimelineStage
  at: string                      // ISO 8601 — when AIWatch observed the transition
  severity?: SecurityAlert['severity']
  fixedVersion?: string
  cveIds?: string[]
  osvModified?: string            // OSV's own modified timestamp at snapshot time
}

export interface OsvTimeline {
  vulnId: string
  affectedPackage?: string
  service?: string
  createdAt: string               // first AIWatch observation
  lastSeen: string                // refreshed when a new entry is appended
  entries: OsvTimelineEntry[]     // chronological, at least one (the initial `detected`)
}

/** KV key for the permanent per-alert OSV timeline (#291). */
export function osvTimelineKey(vulnId: string): string {
  return `security:timeline:osv:${vulnId}`
}

/**
 * Walk the timeline backwards to find the most recently observed severity.
 * Returns undefined if no entry ever recorded one.
 */
function lastKnownSeverity(timeline: OsvTimeline): SecurityAlert['severity'] | undefined {
  for (let i = timeline.entries.length - 1; i >= 0; i--) {
    const sev = timeline.entries[i].severity
    if (sev) return sev
  }
  return undefined
}

/** Same walk for fixedVersion — treats empty string as "no fix yet known". */
function lastKnownFixedVersion(timeline: OsvTimeline): string | undefined {
  for (let i = timeline.entries.length - 1; i >= 0; i--) {
    const fv = timeline.entries[i].fixedVersion
    if (fv) return fv
  }
  return undefined
}

/**
 * Decide whether the current observation of an OSV alert warrants a new timeline entry.
 * Pure function — callers provide existing timeline (null on first sight), the current
 * alert payload, and the current ISO timestamp.
 *
 * Stages this function emits today:
 *   - `detected`          existing is null (first observation)
 *   - `severity_changed`  current severity differs from the last observed severity
 *   - `fix_released`      current has a fixedVersion where the last observation had none
 *
 * `cve_merged` and `withdrawn` are reserved in the type for forward compat but not
 * detected yet — they require fetch-layer fields (OSV aliases, withdrawn) the current
 * SecurityAlert doesn't carry. Extend the fetcher first, then add branches here.
 */
export function shouldAppendTimeline(
  existing: OsvTimeline | null,
  current: SecurityAlert,
  now: string,
): OsvTimelineEntry | null {
  if (!existing) {
    return {
      stage: 'detected',
      at: now,
      severity: current.severity,
      fixedVersion: current.fixedVersion,
    }
  }
  const lastSeverity = lastKnownSeverity(existing)
  if (current.severity && current.severity !== lastSeverity) {
    return { stage: 'severity_changed', at: now, severity: current.severity }
  }
  const lastFixed = lastKnownFixedVersion(existing)
  if (current.fixedVersion && !lastFixed) {
    return { stage: 'fix_released', at: now, fixedVersion: current.fixedVersion }
  }
  return null
}

/**
 * Append a new entry to an existing timeline, or construct a new one. Pure — the
 * cron integration handles the KV write.
 */
export function appendTimelineEntry(
  existing: OsvTimeline | null,
  alert: SecurityAlert,
  entry: OsvTimelineEntry,
  now: string,
): OsvTimeline {
  if (existing) {
    return { ...existing, lastSeen: now, entries: [...existing.entries, entry] }
  }
  return {
    vulnId: alert.id,
    affectedPackage: alert.affectedPackage,
    service: alert.service,
    createdAt: now,
    lastSeen: now,
    entries: [entry],
  }
}

/**
 * Plan the KV writes for a full cycle of OSV timeline updates. Pure — callers provide
 * the current OSV alert list and a reader for existing timelines; receive the list of
 * timelines that need to be persisted. Extracted from the cron loop so the branching
 * (no-op, first observation, transition, corrupt-existing) is directly testable.
 *
 * Corrupt existing timelines (parse failure) are preserved, NOT overwritten: resetting
 * `createdAt` on corruption would erase the historical first-detection timestamp that
 * the monthly report depends on. A skip+log stance favors manual repair.
 */
export interface TimelineCyclePlan {
  key: string
  next: OsvTimeline
}

export async function planOsvTimelineCycle(
  alerts: SecurityAlert[],
  readExisting: (key: string) => Promise<string | null>,
  now: string,
  onParseFail?: (key: string, err: unknown) => void,
): Promise<TimelineCyclePlan[]> {
  const plans: TimelineCyclePlan[] = []
  for (const alert of alerts) {
    if (alert.source !== 'osv') continue
    const key = osvTimelineKey(alert.id)
    const raw = await readExisting(key)
    let existing: OsvTimeline | null = null
    let corrupt = false
    if (raw) {
      try { existing = JSON.parse(raw) as OsvTimeline } catch (err) {
        corrupt = true
        onParseFail?.(key, err)
      }
    }
    if (corrupt) continue  // preserve the blob for manual repair; don't overwrite createdAt
    const entry = shouldAppendTimeline(existing, alert, now)
    if (!entry) continue
    plans.push({ key, next: appendTimelineEntry(existing, alert, entry, now) })
  }
  return plans
}
