// Security incident monitoring for AI services
// Sources: Hacker News Algolia API, OSV.dev vulnerability database (SDK/package CVEs),
//          NVD (first-party product CVEs — Claude Code, Codex, ChatGPT app, … — #949)
// Runs hourly alongside Reddit security monitoring

// ---------- Types ----------

export interface SecurityAlert {
  source: 'hackernews' | 'osv' | 'nvd'
  id: string             // HN story ID, OSV vuln ID, or NVD CVE ID
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

// Security concepts split by confidence (#892). STRONG signals are self-sufficient
// — a match is a security event on its own. WEAK signals ("leak", "unauthorized")
// are high-collision: "leak" trips on model/product leaks ("Mistral model leak",
// "The Claude Code Leak") and "unauthorized" on billing / behavior ("unauthorized
// API usage", "unauthorized change to Grok"), so they only count when a data/access
// context word co-occurs (HN_DATA_ACCESS_CONTEXT below). (Lawsuit framings like
// "unauthorized use of DATA" carry a context word and are handled by HN_TITLE_VETO,
// not this gate.)
const HN_SECURITY_STRONG = [
  'breach', 'hacked', 'vulnerability', 'CVE', 'exploit', 'security incident',
  'data exposure', 'compromised', 'RCE', 'injection', 'exfiltration',
]
const HN_SECURITY_WEAK = ['leak', 'unauthorized']
// Upgrades a WEAK signal to a genuine security match. (Keep exact word forms — the
// matcher is word-boundary'd; "expose"→"exposed" needs the concrete variant.)
const HN_DATA_ACCESS_CONTEXT = [
  'data', 'credential', 'credentials', 'token', 'tokens', 'access', 'secret',
  'secrets', 'password', 'passwords', 'private', 'exposed', 'exposure',
  'exfiltration', 'exfiltrated', 'stolen', 'steal', 'dump', 'dumped', 'database',
  'records', 'PII', 'key', 'keys', 'source code',
]

// HN Algolia treats `query` as plain keyword text with all-words-AND semantics —
// it does NOT parse OR/AND/parentheses as boolean operators (#720). The old
// `("openai" OR ...) AND ("breach" ...)` string therefore required every keyword
// (incl. the literal words "OR"/"AND") to co-occur, which no story ever does, so
// HN returned 0 hits for its entire lifetime. We instead query the AI keyword set
// with `optionalWords` (Algolia's OR knob — any subset may match), pull a broad
// recent batch, and apply the real (AI AND security) precision filter client-side
// in `titleMatchesAiSecurity` below.
export function buildHNQuery(): string {
  return HN_AI_KEYWORDS.join(' ')
}

// Build a single case-insensitive word-boundary matcher for a keyword set. Word
// boundaries are essential: a substring filter matched "rce" inside "sou**rce**"
// and "leak" inside "**leak**ed" (financial-loss stories), producing ~80% false
// positives (#720). All keywords are alphanumeric/space, so `\b` behaves.
function buildKeywordMatcher(keywords: string[]): RegExp {
  const alternation = keywords
    .map(k => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|')
  return new RegExp(`\\b(?:${alternation})\\b`, 'i')
}

const AI_KEYWORD_RE = buildKeywordMatcher(HN_AI_KEYWORDS)
const SEC_STRONG_RE = buildKeywordMatcher(HN_SECURITY_STRONG)
const SEC_WEAK_RE = buildKeywordMatcher(HN_SECURITY_WEAK)
const DATA_ACCESS_RE = buildKeywordMatcher(HN_DATA_ACCESS_CONTEXT)

// Non-security framings that trip the (AI + security-keyword) match yet are not a
// security event (#892): legal disputes and pure speculation. A 6-year HN corpus
// audit showed these dominate the false positives — "Reddit SUES Anthropic, ALLEGES
// unauthorized use of DATA" (passes weak-context via "data"), "Elon Musk Hits OpenAI
// with Breach of Contract LAWSUIT", "POSSIBLE Mistral model leak". Verified findings
// usually carry a CVE or firmer, un-hedged language, so vetoing the hedges costs
// little recall on the operator feed (and a hedged title with a CVE is still withheld
// from the PUBLIC surface anyway — the CVE gate is a separate reader-side check).
const HN_TITLE_VETO = [
  'sue', 'sues', 'sued', 'suing', 'lawsuit', 'lawsuits', 'antitrust', 'copyright',
  'alleges', 'alleged', 'allegedly', 'allegation', 'allegations',
  'rumor', 'rumors', 'rumour', 'rumours', 'reportedly', 'possible', 'possibly',
]
const TITLE_VETO_RE = buildKeywordMatcher(HN_TITLE_VETO)

// A handful of AI service NAMES collide with unrelated non-AI subjects that also
// attract security keywords (#892). Requiring a positive AI-context token instead
// was rejected — it drops real findings whose only AI mention is the ambiguous name
// ("We hacked Gemini's Python sandbox", "Grok can leak your data", "M365 Copilot
// Data Exfiltration"). We instead veto the SPECIFIC non-AI collision contexts:
//   - "Gemini" the crypto EXCHANGE → a co-mentioned peer exchange (coinbase/binance)
//     or an explicit "crypto/cryptocurrency exchange|wallet|trading" phrase. NOT a bare
//     "crypto" — that also means cryptOGRAPHY, a core security topic (a real "weak crypto
//     in the Claude SDK" finding must still reach the operator).
//   - "cursor" the mouse pointer   → "cursor position/overlap/blink/movement"
const HN_NAME_COLLISION_RE = /\b(?:coinbase|binance)\b|\bcrypto(?:currency)?\s+(?:exchange|wallet|trading)\b|\bcursor\s+(?:position|overlap|blink|movement)\b|\bmouse\s+cursor\b/i

// True when a title carries a real security signal: a STRONG keyword, or a WEAK
// keyword ("leak"/"unauthorized") paired with a data/access context word.
export function hasSecuritySignal(title: string): boolean {
  if (SEC_STRONG_RE.test(title)) return true
  return SEC_WEAK_RE.test(title) && DATA_ACCESS_RE.test(title)
}

// A story qualifies only if its title mentions an AI service AND a real security
// signal, and is not vetoed as legal/speculative or a name-collision. This is the
// AND-of-groups the Algolia query string cannot express — see buildHNQuery. The
// veto/collision guards (#892) lift precision from ~50% on the raw keyword AND.
export function titleMatchesAiSecurity(title: string): boolean {
  if (TITLE_VETO_RE.test(title) || HN_NAME_COLLISION_RE.test(title)) return false
  return AI_KEYWORD_RE.test(title) && hasSecuritySignal(title)
}

// "Show HN" / "Launch HN" posts are, by HN convention, "here's a thing I built"
// announcements (#821). A tool that integrates with or DEFENDS a provider names
// that provider as an integration TARGET, not as the subject of a breach — e.g.
// "Show HN: Lelu – gate OpenAI agent actions on confidence and prompt injection"
// trips titleMatchesAiSecurity (openai + prompt injection) but is a third-party
// promo, not an OpenAI security event. Drop these from the security feed.
const SHOW_LAUNCH_HN_RE = /^\s*(?:show|launch)\s+hn[:\s]/i
export function isShowOrLaunchHN(title: string): boolean {
  return SHOW_LAUNCH_HN_RE.test(title)
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
  const params = new URLSearchParams({
    query: buildHNQuery(),
    tags: 'story',
    numericFilters: `created_at_i>${oneDayAgo}`,
    // optionalWords turns the default all-words-AND into "any subset may match",
    // so the query behaves like (kw1 OR kw2 OR ...) across the AI keyword set.
    optionalWords: HN_AI_KEYWORDS.join(','),
    // Wider page than the old 10 — the (AI AND security) post-filter is strict, so
    // we need a broad recent pull to avoid relevance-ranking burying real findings.
    hitsPerPage: '50',
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
    .filter(hit => hit.title && hit.objectID && titleMatchesAiSecurity(hit.title) && !isShowOrLaunchHN(hit.title))
    .map(hit => ({
      source: 'hackernews' as const,
      id: hit.objectID,
      title: hit.title,
      url: hit.url || `https://news.ycombinator.com/item?id=${hit.objectID}`,
      kvKey: `security:seen:hn:${hit.objectID}`,
    }))
}

// ---------- OSV.dev (AI SDK vulnerabilities) ----------

// Keep the OSV_SERVICE_MAP in src/utils/securityAlerts.js in sync when editing
// — its keys must cover every `service` label used here or the Security Alerts
// card will silently drop entries for the unmapped service. The cross-layer
// invariant is enforced at test time in src/utils/securityAlerts.test.js (#821).
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

// ---------- NVD first-party CVE source (#949) ----------
//
// OSV covers *package* CVEs (SDK deps); it never surfaces CVEs in the AI vendors'
// OWN products — Claude Code, OpenAI Codex, ChatGPT desktop, etc. Those are exactly
// the "security" signal users expect on a service card, and they live in NVD keyed by
// vendor product name, not by an npm/PyPI package.
//
// Strategy: ONE `lastModStartDate..lastModEndDate` query per cron cycle (hourly) over a
// FIXED rolling window, then filtering client-side to first-party products. A single
// request/hour sits far under NVD's unauthenticated 5-req/30s limit, so no NVD_API_KEY is
// needed. See NVD_WINDOW_MS below for why the window is fixed (and short) rather than
// cursor-driven. The #949 PoC found precision ≈ 75-80% on the raw vendor match; three noise
// classes — rejected CVEs, third-party clones/wrappers, and AI-authorship-credited
// kernel patches — are filtered by the pure predicates below, measured live at 37 → 30.

const NVD_ENDPOINT = 'https://services.nvd.nist.gov/rest/json/cves/2.0'
// Fixed rolling window, NO cursor — deliberately mirrors fetchOSVAlerts (a 7-day rolling
// window + `security:seen:*` dedup, no persisted position). A cursor that advanced to
// `now` inside the fetcher would make NVD *consume-once*: if the caller's Discord send
// throws before it writes the seen-markers (index.ts sends first, marks second —
// "duplicate better than lost"), the cursor would already have moved past those CVEs and
// they'd be lost forever. A fixed window keeps NVD re-derivable like OSV: an undelivered
// CVE stays in-window (≈6 hourly retries) until it's delivered AND seen-marked, and the
// 7d seen-marker dedup stops re-surfacing once it is. Window is kept small because NVD's
// lastMod response time is super-linear (measured 2026-07-16: 2h→0.26MB/2.4s, 6h→0.36MB/
// 1.5s, 12h→1.8MB/10s, 24h→7.8MB/51s) — a wide window would blow the fetch timeout.
const NVD_WINDOW_MS = 6 * 3600 * 1000           // fetch CVEs modified in the last 6h (~95 CVEs / 0.36MB / 1.5s)
const NVD_FETCH_TIMEOUT_MS = 20000              // ample headroom over the ~1.5s 6h-window fetch, well under cron limits
const NVD_RESULTS_PER_PAGE = 2000               // NVD's max page size (one page covers a 6h window many times over)
const NVD_MAX_PAGES = 4                          // 8000-CVE/cycle ceiling — an unreachable backstop given the 6h window

// First-party product → AIWatch service. `strong` phrases identify the product on
// their own (multi-word, low-collision); `weak` single tokens ('grok', 'gemini',
// 'codex' — each also a common English/unrelated word) match ONLY when a `context`
// vendor marker co-occurs, so the generic sense doesn't false-positive. The `service`
// label is carried on the alert and mapped to a service id by NVD_SERVICE_MAP in
// src/utils/securityAlerts.js (dashboard side) — keep the two in sync. Order = priority
// when a description names more than one product (the subject is listed first).
export const NVD_FIRST_PARTY: Array<{
  service: string
  strong: string[]
  weak: string[]
  context: string[]
}> = [
  { service: 'Claude Code',    strong: ['claude code'], weak: [], context: [] },
  { service: 'Claude Desktop', strong: ['claude desktop', 'claude for windows', 'claude for mac', 'claude for macos', 'claude cowork'], weak: [], context: [] },
  { service: 'OpenAI Codex',   strong: ['openai codex', 'codex cli', 'codex desktop', 'codex ide', 'codex extension'], weak: ['codex'], context: ['openai'] },
  { service: 'ChatGPT',        strong: ['chatgpt desktop', 'chatgpt atlas', 'chatgpt for windows', 'chatgpt for macos', 'chatgpt app'], weak: ['chatgpt'], context: ['openai'] },
  { service: 'Azure OpenAI',   strong: ['azure openai'], weak: [], context: [] },
  { service: 'Gemini',         strong: ['gemini cli', 'gemini code assist'], weak: ['gemini'], context: ['google'] },
  { service: 'Grok',           strong: [], weak: ['grok'], context: ['xai', 'x.ai'] },
  { service: 'Perplexity',     strong: ['perplexity comet', 'comet browser'], weak: ['perplexity'], context: ['perplexity ai', 'perplexity.ai'] },
]

// Minimal shape of a CVE object from the NVD 2.0 `vulnerabilities[].cve` payload.
interface NvdCve {
  id: string
  vulnStatus?: string
  descriptions?: Array<{ lang: string; value: string }>
  metrics?: Record<string, Array<{ cvssData?: { baseScore?: number; baseSeverity?: string } }>>
  weaknesses?: Array<{ description?: Array<{ lang: string; value: string }> }>
}

// English description (NVD always ships `lang:'en'`; fall back to the first entry).
export function extractNvdDescription(cve: NvdCve): string {
  const descs = cve.descriptions ?? []
  return (descs.find(d => d.lang === 'en') ?? descs[0])?.value ?? ''
}

// CVSS base score → our severity band. Prefer the newest metric version present
// (v4.0 → v3.1 → v3.0 → v2); undefined when the CVE carries no score yet (e.g.
// "Awaiting Analysis" without a CNA-provided vector) — severity is optional on the alert.
export function extractNvdSeverity(cve: NvdCve): SecurityAlert['severity'] | undefined {
  const metrics = cve.metrics ?? {}
  for (const key of ['cvssMetricV40', 'cvssMetricV31', 'cvssMetricV30', 'cvssMetricV2']) {
    const score = metrics[key]?.[0]?.cvssData?.baseScore
    if (typeof score === 'number') {
      if (score >= 9.0) return 'critical'
      if (score >= 7.0) return 'high'
      if (score >= 4.0) return 'medium'
      return 'low'
    }
  }
  return undefined
}

export function extractNvdCwes(cve: NvdCve): string[] | undefined {
  const cwes = new Set<string>()
  for (const w of cve.weaknesses ?? []) {
    for (const d of w.description ?? []) {
      if (d.lang === 'en' && /^CWE-\d+$/.test(d.value)) cwes.add(d.value)
    }
  }
  return cwes.size > 0 ? [...cwes] : undefined
}

// A CVE the CNA has withdrawn — `vulnStatus:"Rejected"`, or the description carries
// NVD's canonical rejection preamble. These are not real vulnerabilities (#949 noise class 1).
export function isRejectedCve(cve: NvdCve): boolean {
  if ((cve.vulnStatus ?? '').toLowerCase() === 'rejected') return true
  const d = extractNvdDescription(cve).toLowerCase().trimStart()
  return d.startsWith('rejected reason:') || d.startsWith('** reject')
}

// Vendor product tokens that anchor the "<3P noun> for <product>" rule below.
const NVD_PRODUCT_TOKENS = '(?:claude|chatgpt|codex|gemini|grok|perplexity)'

// A third-party clone / wrapper / router whose SUBJECT is not the vendor's own product
// (#949 noise class 2). The lastMod stream is polluted by tools that merely NAME a
// first-party product — verified against live NVD 2026-07-16: WordPress "ChatGPT" plugins,
// `claude-code-router`, `AgentAPI` ("HTTP API for Claude Code, …"), `MCP Manager for Claude
// Desktop`, `LibreChat` ("an enhanced ChatGPT clone"). Dropping these took the live set
// 37 → 29 with no genuine findings lost.
//
// Every marker is ANCHORED rather than a bare noun, because this predicate tests the WHOLE
// description: a bare `\bplugin\b` or `<noun> for` would veto genuine first-party CVEs on an
// incidental mention. Concretely — Claude Code ships AS a JetBrains plugin and has a plugin
// marketplace (#920), so "the Claude Code plugin for JetBrains IDEs is vulnerable" must
// survive; and 'claude for windows' / 'chatgpt for windows' are first-party product names in
// NVD_FIRST_PARTY itself, so "client for macOS" must survive. A dropped CVE is invisible
// (there is no feedback channel), so each rule is pinned by a keeps-genuine test.
const NVD_THIRD_PARTY_RE = new RegExp([
  'wordpress',                                                        // WP plugins wrapping the vendor API
  '\\bclone\\b',                                                      // "an enhanced ChatGPT clone"
  '\\b\\w+-router\\b',                                                // "claude-code-router" (a named 3P router tool)
  '\\baka\\b[^.]{0,60}\\b(ui|clone|wrapper|proxy|fork|mirror)\\b',
  '\\b(un ?official|third[- ]party)\\b[^.]{0,40}\\b(client|wrapper|clone|proxy|port|ui|plugin)\\b',
  '\\bis\\s+(?:a|an)\\s+(?:clone|fork|wrapper|reverse[- ]proxy|proxy|unofficial)\\b',
  // "<3P noun> for <vendor product>" — the product anchor is what keeps first-party
  // phrasings like "client for macOS" / "REST API for model inference" alive.
  `\\b(manager|wrapper|gateway|proxy|client|dashboard|ui|sdk|api)\\s+for\\s+(?:the\\s+)?${NVD_PRODUCT_TOKENS}\\b`,
].join('|'), 'i')
export function isThirdPartyCloneSubject(description: string): boolean {
  return NVD_THIRD_PARTY_RE.test(description)
}

// An OSS/kernel patch that merely CREDITS an AI tool (#949 noise class 3) — e.g. a
// Linux-kernel CVE whose commit credits "Claude Code" as the tool that found it. The
// subject is the kernel, not the AI product. Two signals: a kernel/firmware subject that a
// first-party product CVE never is, or explicit "found/generated by <tool>" credit phrasing.
// Deliberately NOT a general OSS-library list (openssl/glibc/systemd/…): a real first-party
// CVE can legitimately name a bundled lib ("Claude Code ships a vulnerable OpenSSL"), and
// dropping those would defeat the feature — only kernel/bootloader subjects are safe to veto.
const NVD_OSS_SUBJECT_RE = /\b(linux kernel|the kernel\b|u-boot)\b/i
const NVD_AI_CREDIT_RE = /\b(found|discovered|reported|identified|generated|written|authored|fixed)\s+(using|with|by)\s+(claude code|codex|chatgpt|gemini|grok)\b/i
export function isAiCreditedOssPatch(description: string): boolean {
  return NVD_OSS_SUBJECT_RE.test(description) || NVD_AI_CREDIT_RE.test(description)
}

// Attribute a description to a first-party product (the attribution gate). Returns the
// service label or null. `strong` phrases match as substrings; `weak` tokens are
// word-boundary'd AND require a context marker so 'grok'/'gemini'/'codex' don't trip on
// their generic senses. First matching TABLE entry wins (deterministic + precision-favoring;
// this is table order, not description position — a desc naming two products attributes to
// whichever appears earlier in NVD_FIRST_PARTY).
export function matchNvdFirstParty(description: string): string | null {
  const lc = description.toLowerCase()
  for (const entry of NVD_FIRST_PARTY) {
    if (entry.strong.some(p => lc.includes(p))) return entry.service
    if (entry.weak.length > 0) {
      const hasWeak = entry.weak.some(p => new RegExp(`\\b${p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(lc))
      if (hasWeak && entry.context.some(c => lc.includes(c))) return entry.service
    }
  }
  return null
}

export function nvdCveToAlert(cve: NvdCve, service: string): SecurityAlert {
  const desc = extractNvdDescription(cve)
  // Title = CVE id + first sentence, capped — the long NVD description is unwieldy in a
  // Discord digest / card row, and the full text stays one click away at the NVD URL.
  const firstSentence = desc.split(/(?<=\.)\s/)[0] ?? desc
  const summary = firstSentence.length > 140 ? `${firstSentence.slice(0, 137)}...` : firstSentence
  return {
    source: 'nvd',
    id: cve.id,
    title: summary ? `${cve.id}: ${summary}` : cve.id,
    url: `https://nvd.nist.gov/vuln/detail/${cve.id}`,
    severity: extractNvdSeverity(cve),
    kvKey: `security:seen:nvd:${cve.id}`,
    service,
    cweIds: extractNvdCwes(cve),
  }
}

// Full candidate pipeline: rejected/clone/kernel filters → first-party attribution →
// alert. Pure over the CVE list so it's exhaustively unit-testable without network.
export function filterNvdCves(cves: NvdCve[]): SecurityAlert[] {
  const alerts: SecurityAlert[] = []
  for (const cve of cves) {
    if (isRejectedCve(cve)) continue
    const desc = extractNvdDescription(cve)
    if (!desc) continue
    if (isThirdPartyCloneSubject(desc)) continue
    if (isAiCreditedOssPatch(desc)) continue
    const service = matchNvdFirstParty(desc)
    if (!service) continue
    alerts.push(nvdCveToAlert(cve, service))
  }
  return alerts
}

// Format an epoch-ms as the ISO-8601 string NVD's lastMod params accept (verified:
// `new Date().toISOString()` with the trailing `Z` and millis is honored).
function nvdDate(ms: number): string {
  return new Date(ms).toISOString()
}

// Fetch first-party CVEs modified in the last NVD_WINDOW_MS, self-deduped against prior
// cycles' `security:seen:nvd:*` markers (mirrors fetchOSVAlerts so detectSecurityAlerts
// needs no extra nvd dedup). Throws on HTTP error so the outer allSettled logs it and the
// window simply re-opens next cycle (no state to leave inconsistent). `kv = null` for tests.
export async function fetchNvdAlerts(kv: KVNamespace | null = null): Promise<SecurityAlert[]> {
  const now = Date.now()
  const startISO = encodeURIComponent(nvdDate(now - NVD_WINDOW_MS))
  const endISO = encodeURIComponent(nvdDate(now))

  const cves: NvdCve[] = []
  let startIndex = 0
  let total = Infinity
  let pages = 0
  while (startIndex < total && pages < NVD_MAX_PAGES) {
    const url = `${NVD_ENDPOINT}?lastModStartDate=${startISO}&lastModEndDate=${endISO}&resultsPerPage=${NVD_RESULTS_PER_PAGE}&startIndex=${startIndex}`
    const res = await fetch(url, {
      headers: { 'User-Agent': 'AIWatch/1.0 (ai-watch.dev; security monitoring)' },
      signal: AbortSignal.timeout(NVD_FETCH_TIMEOUT_MS),
    })
    if (!res.ok) {
      res.body?.cancel()
      throw new Error(`NVD HTTP ${res.status}`)
    }
    const json = await res.json() as { totalResults?: number; resultsPerPage?: number; vulnerabilities?: Array<{ cve?: NvdCve }> }
    total = json.totalResults ?? 0
    const batch = json.vulnerabilities ?? []
    for (const item of batch) if (item?.cve) cves.push(item.cve)
    pages++
    if (batch.length === 0) break
    startIndex += json.resultsPerPage ?? NVD_RESULTS_PER_PAGE
  }
  // Truncation is unreachable at an 8000-CVE cap over a 6h window (~95 CVEs), but if NVD
  // ever spiked past it the overflow is simply re-fetched next cycle (the window re-opens
  // from page 0 — there is no cursor to skip it), so a warn is all that's warranted.
  if (startIndex < total && pages >= NVD_MAX_PAGES) {
    console.warn(`[security] NVD window truncated at ${startIndex}/${total} (${NVD_MAX_PAGES}-page cap); overflow re-fetched next cycle`)
  }

  let alerts = filterNvdCves(cves)

  // Pre-dedup against seen markers (fail-open on KV error, mirrors OSV).
  if (kv && alerts.length > 0) {
    const seen = await Promise.allSettled(alerts.map(a => kv.get(a.kvKey)))
    alerts = alerts.filter((a, i) => {
      const r = seen[i]
      if (r?.status === 'rejected') {
        console.error('[security] NVD pre-dedup KV read failed; treating as unseen:', a.id, r.reason instanceof Error ? r.reason.message : r.reason)
        return true
      }
      return !(r?.status === 'fulfilled' && r.value)
    })
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

  // OSV + NVD alerts are pre-deduped inside their fetchers (OSV avoids per-vuln detail
  // fetches for seen entries; NVD avoids re-surfacing across rolling-window overlap). HN
  // still needs dedup here since fetchHNSecurityPosts doesn't touch KV.
  const [hnAlerts, osvAlerts, nvdAlerts] = await Promise.allSettled([
    fetchHNSecurityPosts(),
    fetchOSVAlerts(kv),
    fetchNvdAlerts(kv),
  ])

  if (hnAlerts.status === 'rejected') {
    console.error('[security] HN Algolia fetch failed:', hnAlerts.reason instanceof Error ? hnAlerts.reason.message : hnAlerts.reason)
  }
  if (osvAlerts.status === 'rejected') {
    console.error('[security] OSV.dev fetch failed:', osvAlerts.reason instanceof Error ? osvAlerts.reason.message : osvAlerts.reason)
  }
  if (nvdAlerts.status === 'rejected') {
    console.error('[security] NVD fetch failed:', nvdAlerts.reason instanceof Error ? nvdAlerts.reason.message : nvdAlerts.reason)
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
    ...(nvdAlerts.status === 'fulfilled' ? nvdAlerts.value : []),
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

// NVD first-party product CVE (#949). Unlike OSV there's no affectedPackage/fixedVersion
// remediation — just the mapped service, severity, and the CVE (already embedded in title).
function formatNvdLine(alert: SecurityAlert): string {
  const emoji = SEVERITY_EMOJI[alert.severity || 'medium']
  const serviceTag = alert.service ? `[${alert.service}] ` : ''
  // alert.title is `CVE-YYYY-NNNN: <summary>`, so the id is already present — don't repeat it.
  return `${emoji} ${serviceTag}${alert.title}\n[Details](${alert.url})`
}

/**
 * Format all security alerts into a single Discord embed.
 * Groups OSV SDK vulnerabilities, NVD first-party product CVEs (#949), and HN news.
 */
export function formatSecurityDigest(alerts: SecurityAlert[]): {
  title: string
  description: string
  color: number
} {
  const osvAlerts = alerts.filter(a => a.source === 'osv')
  const nvdAlerts = alerts.filter(a => a.source === 'nvd')
  const hnAlerts = alerts.filter(a => a.source === 'hackernews')

  const sections: string[] = []

  if (osvAlerts.length > 0) {
    sections.push(`**SDK Vulnerabilities (${osvAlerts.length})**`)
    for (const alert of osvAlerts) {
      sections.push(formatOSVLine(alert))
    }
  }

  if (nvdAlerts.length > 0) {
    if (sections.length > 0) sections.push('')
    sections.push(`**First-Party CVEs (${nvdAlerts.length})**`)
    for (const alert of nvdAlerts) {
      sections.push(formatNvdLine(alert))
    }
  }

  if (hnAlerts.length > 0) {
    if (sections.length > 0) sections.push('')
    sections.push(`**Security News (${hnAlerts.length})**`)
    for (const alert of hnAlerts) {
      sections.push(formatHNLine(alert))
    }
  }

  // Color: highest severity wins across the CVE-backed sources (OSV + NVD; HN severity is
  // keyword-inferred and unreliable, so it doesn't drive the embed color).
  const cveAlerts = [...osvAlerts, ...nvdAlerts]
  const hasCritical = cveAlerts.some(a => a.severity === 'critical')
  const hasHigh = cveAlerts.some(a => a.severity === 'high')
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

// Explicit CVE identifier in a title — a concrete, externally-checkable claim. The
// sequence number is "4 or more digits" with no upper bound, so `\d{4,}` (not a capped
// `\d{4,7}`, which would silently reject an 8+ digit id via the trailing \b).
export const CVE_ID_RE = /\bCVE-\d{4}-\d{4,}\b/i

/**
 * Whether a stored finding is verified enough for the PUBLIC surfaces (Overview
 * banner + ServiceDetails card, via /api/status[/cached] `securityAlerts`) — #892.
 *
 * OSV entries are CVE-backed vuln-DB records → always public. NVD entries are
 * first-party CVEs straight from the national DB (#949) → likewise always public. HN
 * entries are unverified community chatter matched by title keywords → public ONLY when
 * the title carries an explicit CVE id. The operator Discord digest is unaffected: it
 * sends `detectSecurityAlerts` output directly and never passes through this reader,
 * so operators keep full visibility of every DETECTED HN finding (i.e. this CVE gate
 * adds no restriction to the operator path beyond the existing `titleMatchesAiSecurity`
 * / `isShowOrLaunchHN` filters). Unknown source → withheld (fail-closed for exposure).
 */
export function isPubliclyVerifiedAlert(meta: Pick<SecurityAlertMeta, 'source' | 'title'>): boolean {
  if (meta.source === 'osv' || meta.source === 'nvd') return true
  if (meta.source === 'hackernews') return CVE_ID_RE.test(meta.title ?? '')
  return false
}

/**
 * Invariant: `/api/status` and `/api/status/cached` must emit the same `securityAlerts`
 * shape. Asymmetric responses would flap the dashboard banner on 60s silent polls (#304).
 *
 * Returns at most `MAX_PUBLIC_SECURITY_ALERTS` alerts; malformed entries and legacy `"1"`
 * marker values are skipped. #892 — also drops unverified HN chatter (`isPubliclyVerifiedAlert`)
 * so the public surfaces show only CVE-backed findings; the operator Discord digest is
 * unaffected. NOTE the filter runs BEFORE the display cap: KV `list` returns keys in
 * lexicographic order, so `security:seen:hn:*` sorts ahead of `security:seen:osv:*` — a
 * pre-filter 20-key window let unverified HN keys displace always-verified OSV keys out of
 * the result. We therefore list a wide window (`SECURITY_LIST_LIMIT`) and cap only AFTER
 * filtering. Swallows KV list/get errors — security data is optional display, not a hard dependency.
 */
const MAX_PUBLIC_SECURITY_ALERTS = 20
const SECURITY_LIST_LIMIT = 100  // wide enough that verified OSV keys are never displaced by HN chatter

export async function readRecentSecurityAlerts(kv: KVNamespace | null): Promise<SecurityAlertMeta[]> {
  if (!kv) return []
  const alerts: SecurityAlertMeta[] = []
  try {
    const secKeys = await kv.list({ prefix: 'security:seen:', limit: SECURITY_LIST_LIMIT })
    if (secKeys.keys.length === 0) return alerts
    const results = await Promise.allSettled(
      secKeys.keys.map(k => kv.get(k.name)),
    )
    for (const r of results) {
      if (r.status !== 'fulfilled' || !r.value || r.value === '1') continue
      try {
        const meta = JSON.parse(r.value) as SecurityAlertMeta
        if (!isPubliclyVerifiedAlert(meta)) continue  // #892 — unverified HN chatter stays operator-only
        alerts.push(meta)
        if (alerts.length >= MAX_PUBLIC_SECURITY_ALERTS) break
      } catch { /* skip malformed */ }
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
