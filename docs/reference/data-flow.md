# Status Data Flow

```
Browser (React SPA, 60s polling)
  → Cloudflare Worker (/api/status)
    → parallel fetch (35 services)
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
