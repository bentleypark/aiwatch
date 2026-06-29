// Security Alerts → service matching (#785, refined #821).
//
// Two alert sources reach the dashboard via `securityAlerts`:
//   - OSV (SDK CVEs): carry a `service` label → matched to a specific AIWatch service id.
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
  // OSV: match by mapped service ID (e.g. "Anthropic (Claude)" → "claude", not "claudeai").
  if (alert.service) return OSV_SERVICE_MAP[alert.service] === service.id
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

// The single service whose NAME the alert tag should show in the Overview banner (one line
// per alert). Name match wins; otherwise the provider's primary service; null if neither.
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
