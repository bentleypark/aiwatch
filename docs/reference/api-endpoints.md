# Worker HTTP Endpoints

> Extracted from CLAUDE.md to keep the auto-loaded project file lean (#525). CLAUDE.md links here; this is the canonical per-endpoint reference for `worker/src/index.ts` routing.

All served by the Cloudflare Worker (`aiwatch-worker`, domain `aiwatch-worker.p2c2kbf.workers.dev`). CORS, KV, routing, and the `*/5` cron live in `worker/src/index.ts`.

## Status

| Endpoint | Notes |
|---|---|
| `GET /api/status` | Live parallel fetch of all 37 services, normalize, KV write, platform/probe cross-validation. Multi-component services carry a `components: {id,name,status,group?}[]` snapshot for the per-component breakdown — from `statusComponentIds` (#604: cerebras/cursor/runway/langsmith/copilot/windsurf), `displayComponentIds` (#606: elevenlabs/replicate), or dynamic `displayAllComponents` with a `group:'Models'` tag (#606: cohere/groq); absent otherwise. **#575 Phase B**: also carries a gated `reportFeed: {svcId: {cat,desc,ts}[]}` map (`buildReportFeedMap`) — recent crowd reports, ONLY for services where an independent signal corroborates (status not operational, or a probe spike + crowd ≥ baseline; `shouldSurfaceReports`). The dashboard Overview panel + ServiceDetails section render from it. Each service also carries `probeSpike?` (active consecutive RTT spike, the cross-match signal). Absent (omitted) when no service qualifies — so it never contradicts an operational board. **#574**: also a `supplyChainBanner` object (`{cloud,severity,regions,affectedNow,mayBeAffected}`) when an AWS infra region is degraded AND a dependent AI service is degraded AND attributes it to AWS in its own incident text (`buildSupplyChainBanner`, StatusGator-style cross-check); omitted otherwise. bedrock carries `awsRegionHealth` (AWS infra region health ex-BEDROCK, from the same AWS Health fetch) |
| `GET /api/status/cached` | KV-only (no live fetch), includes `probe24h` — for "Is X Down" SSR + initial load. **`?src=statusline-*`** returns a ~KB id/name/status-only projection via `buildStatuslinePayload` (`worker/src/statusline.ts`) — skips the ~2 MB probe/latency/AI reads. Statusline snippets (#400) poll this with the tag and target the Worker domain directly, **not** the Vercel-proxied `ai-watch.dev` path, so per-prompt polls don't burn Vercel Fast Data Transfer (#438) |
| `GET /api/uptime?days=30` | Daily uptime counters |
| `GET /api/probe/history?days=30` | Daily probe RTT summaries (90d max) |
| `GET /api/report?month=YYYY-MM` | Monthly archive JSON (permanent). For the **current** month (no built archive until the 1st of next month) it returns a `partial:true` archive synthesized read-only from the `incidents:monthly:{month}` accumulator (incidentList only) so the dashboard 90-day filter shows current-month incidents that rolled out of the live feed (#587). A KV read/parse error → 502 (not an empty 200); a genuinely absent accumulator → 200 empty partial. Past months with no archive → 404 |
| `GET /api/v1/status` (+ `/status/:id`) | Public API (lightweight, CORS `*`, rate-limited 60/min/IP). Each served (non-429) request is recorded in Analytics Engine via `recordV1Traffic` (#518) so call volume is queryable via the AE SQL API. **#713**: `aiwatchScore`/`scoreGrade` are **nullable** — a low-confidence service (no official uptime AND no probe, e.g. Bedrock/Azure) returns `null` (score withheld, not 0); `scoreConfidence` (`high`/`medium`/`low`) is included on BOTH the list and single-service responses to disambiguate a withheld score from a missing/errored one |

## Badges / images

| Endpoint | Notes |
|---|---|
| `GET /badge/:serviceId` | SVG status badge |
| `GET /api/og` | Dynamic OG image PNG (1200×630, resvg-wasm). Purely query-param-driven (`service`/`status`/`score`/`uptime`/`v`) — no live status re-fetch. The is-down page sets the `status` param from the share `?e=` hint when present (pins a tweet's card to the post moment, see status-determination.md), else from live status |

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
| `POST /api/report-issue` | — (CORS, per-IP rate-limit) | Crowd "Report an issue" collect endpoint (#575). Body `{svcId, category, description?}` — validates svcId + category, sanitizes description, IP-hash per-day dedup, increments `report:count:*` + appends `report:feed:*`. Always returns an honest 200 ack (never a count). COLLECT only — display is gated, see below |
| `GET /api/report-feed?svc=:id` | — (CORS, `max-age=30`) | Recent 24h crowd reports for one service (#575). The **is-down Edge** fetches this (gate at the call site). The **dashboard** does NOT use it — it reads the centralized gated `reportFeed` map on `/api/status` instead (no per-service fan-out). A public list never contradicts an `operational` page either way |
