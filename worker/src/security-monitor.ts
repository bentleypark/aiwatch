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

const OSV_PACKAGES = [
  { name: 'openai', ecosystem: 'PyPI', service: 'OpenAI' },
  { name: 'anthropic', ecosystem: 'PyPI', service: 'Anthropic (Claude)' },
  { name: 'google-generativeai', ecosystem: 'PyPI', service: 'Google (Gemini)' },
  { name: 'cohere', ecosystem: 'PyPI', service: 'Cohere' },
  { name: 'mistralai', ecosystem: 'PyPI', service: 'Mistral' },
  { name: 'langchain', ecosystem: 'PyPI', service: 'LangChain' },
  { name: 'transformers', ecosystem: 'PyPI', service: 'Hugging Face' },
  { name: 'openai', ecosystem: 'npm', service: 'OpenAI' },
  { name: '@anthropic-ai/sdk', ecosystem: 'npm', service: 'Anthropic (Claude)' },
  { name: '@google/generative-ai', ecosystem: 'npm', service: 'Google (Gemini)' },
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

  return [
    ...hnFinal,
    ...(osvAlerts.status === 'fulfilled' ? osvAlerts.value : []),
  ]
}

// ---------- Discord formatting ----------

const SEVERITY_EMOJI: Record<string, string> = {
  critical: '🔴',
  high: '🟠',
  medium: '🟡',
  low: '🟢',
}

function formatOSVLine(alert: SecurityAlert): string {
  const emoji = SEVERITY_EMOJI[alert.severity || 'medium']
  const serviceTag = alert.service ? `[${alert.service}] ` : ''
  const parts = [`${emoji} ${serviceTag}**${alert.id}** · ${alert.affectedPackage || 'unknown'}`]
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
