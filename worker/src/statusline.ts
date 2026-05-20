import type { ServiceStatus } from './types'

// Minimal status-only projection for terminal statusline integrations (#438).
//
// The Claude Code statusline snippets (#400, src/pages/Statusline.jsx) poll the
// status endpoint on (roughly) every prompt and `jq` out only id/name/status.
// The full /api/status/cached response is ~2 MB (services + probe:24h +
// latency:24h + AI analysis) — downloaded and discarded on every poll — which
// made /api/status/cached the single largest Vercel Fast Data Transfer route
// (17.8 GB/cycle). This projection drops everything but id/name/status so each
// poll is ~KB. Served when the request carries the `?src=statusline-*` tag.

// The field set is a contract: the Statusline.jsx snippet `jq` filters read
// exactly `.services[].id`, `.name`, `.status`. Renaming/dropping any of these
// silently breaks every installed statusline (jq emits nothing; the snippet's
// `2>/dev/null || true` swallows the error). statusline.test.ts pins the keys.
export interface StatuslineService {
  id: string
  name: string
  status: ServiceStatus['status']
}

export interface StatuslinePayload {
  services: StatuslineService[]
  cachedAt: string | null
}

export function buildStatuslinePayload(
  cached: { services: ServiceStatus[]; cachedAt?: string } | null,
): StatuslinePayload {
  return {
    services: (cached?.services ?? []).map((s) => ({ id: s.id, name: s.name, status: s.status })),
    cachedAt: cached?.cachedAt ?? null,
  }
}

// True when a request to /api/status/cached is a statusline poll (carries the
// `?src=statusline-<preset>` tag set by Statusline.jsx). Used to short-circuit
// the heavy KV reads and return buildStatuslinePayload instead.
export function isStatuslineRequest(searchParams: URLSearchParams): boolean {
  return (searchParams.get('src') ?? '').startsWith('statusline-')
}
