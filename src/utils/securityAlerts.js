// Security Alerts → service matching (#785, refined #821).
//
// Three alert sources reach the dashboard via `securityAlerts`:
//   - OSV (SDK CVEs): carry a `service` label → matched to a specific AIWatch service id.
//   - NVD (first-party product CVEs, #949): carry a `service` label too → matched via
//     NVD_SERVICE_MAP (Claude Code / Codex / ChatGPT / … → service id).
//   - HN (Hacker News): no `service` → matched by the service NAME or PROVIDER appearing
//     in the title.
//
// #821 refinement: a provider-only match (the title names the provider but NOT a specific
// service, e.g. "OpenAI agent actions") used to fan the SAME item out to every sibling
// service sharing that provider (openai/chatgpt/codex). It now attaches to a single
// representative ("primary") service per provider, so the item shows once. Name-matched
// items still attach to the exact service.

// Maps an OSV `service` label → specific AIWatch service ID (SDK alerts are API-specific).
// Keep in sync with OSV_PACKAGES in worker/src/security-monitor.ts.
export const OSV_SERVICE_MAP = {
  'OpenAI': 'openai', 'Anthropic (Claude)': 'claude', 'Google (Gemini)': 'gemini',
  'Cohere': 'cohere', 'Mistral': 'mistral', 'Hugging Face': 'huggingface',
  'Together': 'together', 'Groq': 'groq', 'Replicate': 'replicate',
  'AssemblyAI': 'assemblyai', 'Deepgram': 'deepgram',
  'LangChain': 'langsmith', // #561 — langchain ecosystem CVEs now have a detail-page home
}

// Maps an NVD `service` label → specific AIWatch service ID (#949). The label is set by
// NVD_FIRST_PARTY in worker/src/security-monitor.ts — keep the two in sync. Some products
// have no exact monitored card (Claude Desktop is not a tracked service, "Gemini" here is
// the vendor product not only the API), so they map to the closest same-provider service.
export const NVD_SERVICE_MAP = {
  'Claude Code': 'claudecode',
  'Claude Desktop': 'claudeai',  // no dedicated desktop card — nearest Anthropic app surface
  'OpenAI Codex': 'codex',
  'ChatGPT': 'chatgpt',
  'Azure OpenAI': 'azureopenai',
  'Gemini': 'gemini',
  'Grok': 'xai',
  'Perplexity': 'perplexity',
}

// A `service` label from either CVE source → its AIWatch service id (labels don't collide
// across the two maps).
export function serviceIdForAlertLabel(label) {
  return OSV_SERVICE_MAP[label] ?? NVD_SERVICE_MAP[label] ?? null
}

// #949 — the card labels every finding by WHAT it is about, not by which feed it came from:
// a CVE in the product itself (NVD) reads distinctly from a CVE in an SDK you install (OSV)
// or from community news (HN). Naming the *source* ("NVD"/"first-party") was rejected — the
// former is jargon, and "first-party"/"자사" is ambiguous about whose company is speaking
// (AIWatch's? the vendor's?). Returns a label token, or null for an unknown source so an
// unrecognized feed renders no badge rather than a wrong one.
const SECURITY_SOURCE_LABELS = {
  nvd: 'product',
  osv: 'sdk',
  hackernews: 'news',
}

export function securitySourceLabel(source) {
  return SECURITY_SOURCE_LABELS[source] ?? null
}

// The representative service id for a provider: its first `api`-category service, else its
// first service in list order. Deterministic given a stable `allServices` order — so a
// provider-only HN item resolves to exactly one service id.
export function primaryServiceIdForProvider(provider, allServices) {
  if (!provider) return null
  const sameProvider = (allServices ?? []).filter((s) => s.provider === provider)
  if (sameProvider.length === 0) return null
  const apiFirst = sameProvider.find((s) => s.category === 'api')
  return (apiFirst ?? sameProvider[0]).id
}

// Whether a single security alert should render on `service`'s detail page.
export function securityAlertMatchesService(alert, service, allServices) {
  // OSV/NVD: match by mapped service ID (e.g. "Anthropic (Claude)" → "claude", not
  // "claudeai"; "Claude Code" → "claudecode").
  if (alert.service) return serviceIdForAlertLabel(alert.service) === service.id
  // HN: name match → exact service; provider-only match → the provider's primary service only.
  const titleLC = alert.title?.toLowerCase() ?? ''
  const nameLC = service.name?.toLowerCase() ?? ''
  const providerLC = service.provider?.toLowerCase() ?? ''
  if (nameLC && titleLC.includes(nameLC)) return true
  if (providerLC && titleLC.includes(providerLC)) {
    return service.id === primaryServiceIdForProvider(service.provider, allServices)
  }
  return false
}

// All security alerts that should render on `service`'s detail page.
export function filterSecurityAlertsForService(alerts, service, allServices) {
  return (alerts ?? []).filter((a) => securityAlertMatchesService(a, service, allServices))
}

// The single service whose NAME the alert tag should show. Name match wins; otherwise the
// provider's primary service; null if neither.
// #950 — CURRENTLY UNUSED in production: the Overview aggregate banner (its only consumer)
// was removed; retained (with its unit test) to ease re-surfacing once #949 first-party CVE
// data lands. ServiceDetails uses filterSecurityAlertsForService, not this.
export function tagServiceForAlert(alert, allServices) {
  if (alert.service) return null // OSV uses its own service label as the tag
  const titleLC = alert.title?.toLowerCase() ?? ''
  const byName = (allServices ?? []).find((s) => {
    const n = s.name?.toLowerCase() ?? ''
    return n && titleLC.includes(n)
  })
  if (byName) return byName
  const byProvider = (allServices ?? []).find((s) => {
    const p = s.provider?.toLowerCase() ?? ''
    return p && titleLC.includes(p)
  })
  if (!byProvider) return null
  const primaryId = primaryServiceIdForProvider(byProvider.provider, allServices)
  return (allServices ?? []).find((s) => s.id === primaryId) ?? byProvider
}
