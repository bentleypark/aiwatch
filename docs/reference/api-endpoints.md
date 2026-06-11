# Worker HTTP Endpoints

> Extracted from CLAUDE.md to keep the auto-loaded project file lean (#525). CLAUDE.md links here; this is the canonical per-endpoint reference for `worker/src/index.ts` routing.

All served by the Cloudflare Worker (`aiwatch-worker`, domain `aiwatch-worker.p2c2kbf.workers.dev`). CORS, KV, routing, and the `*/5` cron live in `worker/src/index.ts`.

## Status

| Endpoint | Notes |
|---|---|
| `GET /api/status` | Live parallel fetch of all 34 services, normalize, KV write, platform/probe cross-validation |
| `GET /api/status/cached` | KV-only (no live fetch), includes `probe24h` — for "Is X Down" SSR + initial load. **`?src=statusline-*`** returns a ~KB id/name/status-only projection via `buildStatuslinePayload` (`worker/src/statusline.ts`) — skips the ~2 MB probe/latency/AI reads. Statusline snippets (#400) poll this with the tag and target the Worker domain directly, **not** the Vercel-proxied `ai-watch.dev` path, so per-prompt polls don't burn Vercel Fast Data Transfer (#438) |
| `GET /api/uptime?days=30` | Daily uptime counters |
| `GET /api/probe/history?days=30` | Daily probe RTT summaries (90d max) |
| `GET /api/report?month=YYYY-MM` | Monthly archive JSON (permanent) |
| `GET /api/v1/status` (+ `/status/:id`) | Public API (lightweight, CORS `*`, rate-limited 60/min/IP). Each served (non-429) request is recorded in Analytics Engine via `recordV1Traffic` (#518) so call volume is queryable via the AE SQL API |

## Badges / images

| Endpoint | Notes |
|---|---|
| `GET /badge/:serviceId` | SVG status badge |
| `GET /api/og` | Dynamic OG image PNG (1200×630, resvg-wasm) |

## Incident RSS feed (#54, #467)

| Endpoint | Notes |
|---|---|
| `GET /feed.xml` | All-services incident RSS 2.0; served as `text/xml` with an `<?xml-stylesheet href="/feed.xsl"?>` PI so browsers render a friendly page (#467). A multi-surface incident (one incidentId across several services) is collapsed to ONE item via `dedupeSharedIncidents` (#520) |
| `GET /feed/:slug` | Per-service incident RSS — slug matches `/is-{slug}-down`. KV-unavailable → 503, unknown slug → 404 (#54) |
| `GET /feed.xsl` | Static client-side XSLT for feed rendering (#467) |

## Alerts / operator / internal

| Endpoint | Auth | Notes |
|---|---|---|
| `POST /api/alert` | — | CORS/SSRF-guarded Discord proxy (Discord hosts only, #468) |
| `POST /api/admin/analyze` | `X-Admin-Key` (`ADMIN_API_KEY`) | Operator Sonnet override on a specific active incident (#299). Accepts only IDs matching an active incident in `services:latest` (scope guard), per-incident rate-limited, `sticky:true` by default so cron won't auto-replace. Use the `scripts/admin-analyze.mjs` helper, not raw curl. Full runbook in [operator-tools.md](operator-tools.md) |
| `POST /api/admin/rebuild-archive` | `X-Admin-Key` | Operator regenerate of `archive:monthly:{YYYY-MM}` after a bug-fix deploy |
| `POST /api/internal/edge-fallback` | Bearer `EDGE_ALERT_TOKEN` | Called by Vercel Edge Functions on a degraded fallback render; dedups via `alerted:edge-fallback:*` and fires Discord (#378) |
