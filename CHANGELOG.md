# Changelog

## v1.3.0 (2026-04-13)

### Features

- **Responsiveness Score** — New AIWatch Score component using probe RTT data: Uptime(40) + Incidents(25) + Recovery(15) + Responsiveness(20). Speed (exponential decay on p50) + Stability (combined CV). Probe-less services capped at 95 points (#132, #167)
- **AI Security Monitoring** — HN Algolia + OSV.dev SDK vulnerability scan + Reddit r/netsec monitoring with Discord digest alerts (#215, #216)
- **Weekly Discord Briefing** — Aggregated changelog RSS (OpenAI/Google/Anthropic) + incident summary + stability trends, sent Sunday UTC 00:00 (#213, #214)
- **Monthly Archive** — Permanent monthly reliability snapshots in KV: uptime, score, incidents, latency per service. API endpoint `/api/report?month=YYYY-MM` (#55, #186)
- **Detection Lead** — Early outage detection via consecutive probe RTT spikes. Discord alerts show detection lead time (e.g., "5m lead") when probe detects before official status page (#123, #144, #184)
- **Recently Resolved Banner** — Independent recovery tracking via `recovered:` KV (decoupled from AI analysis). Per-incident badge matching, service name links to detail page (#128, #224, #225)
- **Contextual AI Fallback** — `needsFallback` flag in AI analysis + Score-based alternative recommendations. Per-category grouping for multi-service incidents (#119, #185)
- **Product Hunt Landing Page** — `/intro` Vercel Edge Function with KO/EN i18n, dashboard preview mock, PH upvote banner (#116)
- **Is X Down** — Added "Is claude.ai Down?" page (8→9 services)
- **New Services** — Added Fireworks AI, Voyage AI, Modal, AssemblyAI, Deepgram (25→30 monitored services) (#126, #148, #149, #150, #151)
- **Web Vitals Monitoring** — Collect LCP/FCP/TTFB/CLS/INP (100% sampling) + daily p75 summary in Discord report (#112)
- **Health Check Probing** — Expanded from 15 to 19 API services with direct RTT measurement every 5 minutes (#123)
- **Webhook Tracking** — Registration tracking with hashed URLs + approximate daily delivery counts in Daily Summary
- **Competitive Monitoring** — Automated Reddit keyword expansion + GitHub repo detection (#207, #208)
- **Service Count Drop Detection** — Discord alert when <80% of expected services return (#221, #222)
- **Platform Monitor** — Atlassian metastatuspage.com health check with preemptive signal for status page outages

### Improvements

- **Probe Cross-Validation** — Override false degraded status when probe RTT is normal during status page fetch failures. Platform quorum detection (70%+ same-platform failures → hold operational) (#187, #188)
- **AI Re-analysis** — Re-trigger analysis after 2h for long-running incidents with timeline context. Boilerplate filtering skips generic "investigating"/"monitoring" updates
- **Tier-based Fallback Priority** — Same-tier services recommended first, then adjacent tiers, sorted by AIWatch Score descending
- **Together AI Alert Merging** — Concurrent model-level alerts merged into single Discord embed (#178, #179)
- **Daily Summary** — Alert count aggregation, Web Vitals p75 grades, Reddit monitoring stats, catch-up on missed runs (#181, #183)
- **Code Splitting** — React.lazy() for non-Overview pages, chart.js split, skeleton minimum 1000→500ms (#173, #174, #176, #177)
- **Cache-first Loading** — `/api/status/cached` for fast initial load, stale KV read optimization

### Bug Fixes

- Fix ChatGPT uptime parsing cross-matching component_impacts section (#217, #218)
- Fix security alert dedup TTL 24h→7d + add service name to Discord format (#223)
- Fix Mistral probe cross-validation for non-probed sub-services (#211, #212)
- Fix BetterStack dailyImpact worst-case bias with 2-pass per-day ratio aggregation (#122)
- Fix OpenAI/ChatGPT incident cross-contamination (#134, #156, #157)
- Fix Cursor statusComponentId after status page migration (#199, #200)
- Fix false degraded alerts from RSS fetch failures
- Fix Claude API probe endpoint to /v1/models for fair RTT measurement (#171, #172)
- Fix `Promise.all` → `Promise.allSettled` for resilient probe KV reads
- Fix mobile layout: Topbar overflow, incident card padding, Latency chart density (#201, #202)

## v1.2.0

Initial public release with AI-powered incident analysis, real-time monitoring dashboard, Discord/Slack alerts, and health check probing.
