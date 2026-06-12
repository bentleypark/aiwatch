# Status Data Flow

```
Browser (React SPA, 60s polling)
  → Cloudflare Worker (/api/status)
    → parallel fetch (37 services)
    → gemini dual-source (#310): gcloud Vertex feed + aistudio.google.com/status MakerSuite RPC — merged with vertex:/aistudio: ID prefixes
    → normalize to ServiceStatus[]
    → write to KV (cache + daily counters)
    → (Mistral-only probe corroboration filter removed in #373 — same-title incident grouping in `src/utils/incidentGrouping.js` now consolidates auto-monitoring noise uniformly across all services)
    → metastatuspage preemptive signal: platform:status:atlassian KV non-operational → hold all Atlassian services operational
    → platform quorum detection: 70%+ same-platform fetch failures → platform outage → hold operational for all affected services
    → probe cross-validation: individual probe RTT normal → hold operational (prevents false positives during status page failures)
  → React state (usePolling hook via PollingContext)
    → overlay probe RTT onto service.latency (20 probe services)
    → non-probe services (bedrock, azureopenai, pinecone) keep status page latency
  → all pages read from context

Cron Trigger (*/5 min)
  → health check probing (direct RTT to API endpoints, stored in probe:24h)
  → probe spike detection (3+ consecutive RTT spikes) → record to detected:{svcId} as earliest detection
  → platform monitor: check metastatuspage.com → store platform:status:atlassian → Discord alert on outage/recovery
  → read KV cache → detect incidents/status changes
  → record detection timestamps (detected:{serviceId}); probe-spike rising edge also increments probe-degradation:daily(+:nostatus) RTT-degradation counters (#464)
  → KV ID-based dedup → Discord alerts (single embed per incident; rare genuine early-RTT signal appended when probe flagged degradation before the official update)
  → incident detected → AI analysis via Gemma 4 (Workers AI, primary) or Sonnet (AI Gateway, fallback) (8s timeout) + early-RTT signal (1-60min, rare → "⚡ Early signal: Xm") → merged into incident embed + persisted to detection:lead:{date} audit log (#256, dedup by incId). NOTE (#464): status-page polling is structurally later than the official publish, so the "faster than official" headline is retired — honest framing is MTTD (alerted within ~5-min polling cycle) + RTT degradation detection (degradations status pages don't report); aggregate average gated by MIN_LEAD_SAMPLE_SIZE
  → recovery detected → mark ai:analysis:{svcId}:{incId} with resolvedAt (2h TTL, powers "Recently Resolved" UI)
  → active incidents: refresh analysis TTL / re-analyze if expired / dedup sibling services
  → alert count tracked in KV (alert:count:{date}) for Daily Summary
  → daily summary at UTC 09:00 (KST 18:00) with alert count aggregation + Web Vitals p75 + early-RTT detections (24h sliding window) + RTT degradation counts (probe-degradation:daily, #464) + fetch-failure observability (#500/#501)
  → daily summary also accumulates incidents:monthly:{YYYY-MM} (dedup by incident ID, 60d TTL)
  → monthly archive on 1st of month (UTC 00:00) → aggregate history:* + probe:daily:* + incidents:monthly:* + security:monthly:* + detection:lead:monthly:* (#369) + probe-degradation:monthly:* (#511) → archive:monthly:{YYYY-MM} (permanent)
  → archive-ready Discord ping → links to `aiwatch-reports/generate-report.yml` workflow_dispatch so operator clicks "Run workflow" to open draft PR; dedup via archive:notified:{YYYY-MM} (aiwatch-reports#4)
  → changelog RSS/HTML collection (hourly at :00) → KV accumulate new entries from OpenAI/Google/Anthropic
  → security monitoring (hourly at :00) → HN Algolia + OSV.dev SDK vulnerability scan (24 AI SDK packages · two-phase: querybatch → KV dedup → per-vuln GET enrichment; #323/#325) → EPSS enrichment via GitHub Advisories (24h KV cache, #326) → Discord digest on findings
  → weekly briefing on Sunday UTC 00:00 (KST 09:00) → aggregate changelog + incidents + stability → Discord embed

Web Vitals Pipeline (per-request, 100% collection):
  Browser (web-vitals) → POST /api/vitals → Worker → KV merge (vitals:{date})
  Daily Summary cron reads vitals KV → Discord embed (p75 + grade)
```

## DeepSeek Flashduty Feed Pipeline (#618 / #619)

DeepSeek's status page migrated to Flashduty (`status.deepseek.com`, #507), which blocks
**non-browser TLS fingerprints** — a Worker `fetch()` is reset at the TLS layer regardless of egress
IP (a real Chromium from the same IP succeeds → JA3/bot wall, not an IP block). The Worker therefore
cannot read it directly. A scheduled GitHub Action acts as a **browser-fingerprint proxy**:

```
[GitHub Action]  cron */10 min  (.github/workflows/deepseek-feed.yml — GH cron is best-effort + often delayed)
  Playwright headless Chromium (official mcr.microsoft.com/playwright container, pinned)
  → goto status.deepseek.com         ← real browser TLS/HTTP fingerprint clears the bot wall
  → in-page fetch() of the clean Flashduty JSON API (scripts/scrape-deepseek-feed.mjs):
       /api/status-page/{pageId}/summary/active            (active incidents + components)
       /api/status-page/{pageId}/change/list   (90d window)  (full incidents incl. timelines)
       /api/status-page/{pageId}/summary/structure (90d)     (per-component outage windows + uptime% — 90d to match the page)
  → POST /api/internal/deepseek-feed  (Authorization: Bearer DEEPSEEK_FEED_TOKEN)
                                  │
                                  ▼
[Worker]  handleDeepseekFeed → validate token + shape (reject empty) → KV `deepseek:feed` (3h TTL, ~18 missed-run tolerance)
                                  ▲
                                  │  read each */5 cron + each /api/status fan-out
[Worker]  fetchService('deepseek' | 'deepseekapp')  (services.ts readFlashdutyStatus)
  → parseFlashdutyFeed(feed, { primaryComponentId })   ← option A: scope to ONE component
       deepseek    → API Service component   (api.deepseek.com)  → category api
       deepseekapp → Web Chat Service component (chat.deepseek.com) → category app (DeepSeek App, #619)
  → FRESH feed (≤1h)   → live data, incidentSourceStale cleared (ranked)
  → AGING feed (1–3h)  → live badge/incidents but incidentSourceStale re-asserted (ranking-excluded)
  → ABSENT/expired feed (>3h KV TTL):
       deepseek    → fall back to the frozen Atlassian mirror (deepseek.statuspage.io) + incidentSourceStale
       deepseekapp → empty stale base (feed-only, no apiUrl) — never fetches the bot-walled URL
```

Two timers interlock: the **Action (*/10)** refreshes the KV data source; the **Worker cron (*/5)**
reads it + recomputes `services:latest`. So DeepSeek **status-page** incident detection lags ~10 min
behind the 5-min-polled services — but DeepSeek **API RTT degradation** is still caught at */5 by the
direct probe (`api.deepseek.com`, which bypasses the bot-walled status host). Shared incidents (a
"Web/API" outage) carry the same `flashduty:{change_id}` id across both services, so the existing
cross-surface grouping (Incidents page dedup→affectedNames, Analyze modal, RSS `dedupeSharedIncidents`)
collapses them to one. Go-live ops: `DEEPSEEK_FEED_TOKEN` Worker secret + GH Action secrets
(`DEEPSEEK_FEED_TOKEN`, `DEEPSEEK_FEED_WORKER_URL`).
