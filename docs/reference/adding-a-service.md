---
type: runbook
title: "Adding a New Service — Full Checklist"
description: "Full checklist for adding a monitored service — the worker/frontend/docs/SEO/methodology/reports files that must update in lockstep, starting with the Step-0 data-richness audit."
tags: [worker, checklist, service, sync-invariant]
---

# Adding a New Service — Full Checklist

> Extracted from CLAUDE.md to keep the auto-loaded project file lean. CLAUDE.md links here; this is the canonical reference.

When adding a new monitored service, update ALL of the following:

## 0. Pre-flight — data-richness audit (do this BEFORE writing any code, #601/#680)

A service is only worth adding if its source carries real signal. **Fetch the candidate's status source directly and grade it** — don't assume:

| Signal | How to check | Rich | Thin (avoid) |
|---|---|---|---|
| **Official uptime %** | **Never in `summary.json`** — fetch the status page HTML. Atlassian → `window.uptimeData` (needs `statusComponentId`). incident.io → `component_uptimes` in the `self.__next_f` payload (needs `incidentIoComponentId`). Better Stack → `…/index.json` (`availability`) | a real number | **absent** (gcloud `incidents.json` gives incidents only), or incident.io `"uptime":"$undefined"` |
| **Incident history** | `…/api/v2/incidents.json` count + date span, or the feed's records | populated, recent | **0 / sparse** (gcloud feed is ~3 entries; e.g. Veo/Imagen have 0 ever) |
| **Probeable endpoint** | a public, no-auth GET that returns fast (any HTTP status = alive) | yes → adds latency + Responsiveness score | no (auth-gated) → score relies on uptime only |

- **Identify the platform from the page, not the API (#857).** A Statuspage-compatible `/api/v2/summary.json` does **not** mean Atlassian — incident.io serves one too. Atlassian uses 12-char component ids (`r7tngp2p3sjd`) + `window.uptimeData`; incident.io uses ULIDs (`01K0Q5QSJV…`) + `component_uptimes`. Getting this wrong sets neither `statusComponentId` nor `incidentIoComponentId`, so `needsHtml` never fetches the page and a **published uptime is silently dropped** — the service then scores on the `/60` no-uptime rescale and looks like it publishes nothing (turbopuffer shipped this way and lost 11 score points for a month).
- **For an incident.io page, check `display_uptime_mode` before concluding "no uptime".** `'chart_and_percentage'` publishes a number; `'chart_only'` emits `"uptime":"$undefined"` and genuinely has none (Stability/ElevenLabs/Replicate).
- **Thin sources → the service renders like Bedrock/Azure** (operational, "No official uptime", `score` withheld at low confidence, ~never an incident) — a near-empty card that lowers dashboard quality. **gcloud-`incidents.json`-only services are thin** (Veo/Imagen/STT/Vertex Vector — #680 held for this reason). Gemini looks rich only because it ALSO merges the AI Studio source (`aistudioStatus`).
- **Prefer candidates that are BOTH data-rich AND fill a single-service category gap** (#601). If a thin category (video/image/vector/observability/embeddings) needs a sibling, pick a Better Stack / Atlassian / incident.io competitor over a gcloud product.
- Record the audit verdict (and the source URLs you checked) in the issue before implementing.

## Worker (backend)
1. `worker/src/services.ts` — add `ServiceConfig` entry at correct position in `SERVICES` array (determines API response order: LLM → voice → infra → apps → agents). If the status page hosts unrelated components (multi-tenant Atlassian / incident.io / metastatuspage feeds — e.g. `githubstatus.com`, `status.openai.com`, `status.claude.com`), set `incidentKeywords` to scope the visible incident list — otherwise the service card will surface every incident on the page (#397)
   - **`addedAt: 'YYYY-MM-DD'` (required, #802)** — set today's date. AIWatch holds a service OUT of the Reliability Ranking for its first 30 days (`coverageDays < MIN_COVERAGE_DAYS`) so a thin observed window can't rank it off insufficient data; it auto-rejoins at 30d. WITHOUT `addedAt` the new service ranks immediately on incomplete data. (Established services predating #802 are intentionally absent = full coverage.) #809 — `addedAt` also flows into the monthly archive (`/api/report`, via `SERVICE_ADDED_AT`) so the report-side coverage gate (aiwatch-reports#45) excludes a mid-month-added service from that month's ranking.

   **`apiUrl` reachability check (required)**: verify the chosen `apiUrl` responds from a non-browser client before committing — some providers block Cloudflare Workers IPs on their custom domain while the canonical host remains accessible (DeepSeek case, #498):
   ```bash
   curl -sf --max-time 5 "{apiUrl}" -o /dev/null && echo "OK" || echo "BLOCKED — check .statuspage.io mirror"
   ```
   For Atlassian Statuspage services, if the custom domain is blocked, use `https://{slug}.statuspage.io/api/v2/summary.json` instead. Confirm `statusComponentId` resolves on the chosen endpoint. See `docs/reference/status-determination.md` § "Status page URL selection".

   **Per-component breakdown (#606, optional but check it)** — if the status page exposes **≥2 availability-relevant components**, configure a display-only breakdown (the badge is unaffected; `resolveSvcStatus` never reads these). Pick the right mechanism — full rules in `docs/reference/status-determination.md` § "Per-component snapshot":
   - **Curated allowlist** → `displayComponentIds: [ids]` (a few stable surfaces; e.g. elevenlabs, replicate, assemblyai).
   - **Per-model / many churny components** → `displayAllComponents: true` + `componentDenylist: ['Docs','Website',…]` + `componentSurfaces: [names]` (surfaces stay individual; the rest fold into a collapsible "Models" group; e.g. cohere, groq).
   - **Shared status page** (multiple AIWatch services on one page, e.g. status.openai.com) → per-service `displayComponentIds` matching the official groups, **disjoint across the sibling services** (add a LEAK-GUARD test); set `componentsUrl` (components.json) if summary.json omits some.
   - **BetterStack page** → no config beyond `componentDenylist: ['Website']`; `parseBetterStackComponents` extracts the breakdown from `index.json` (grouped by section).
   - Skip when the service maps to a single component (≥2 gate suppresses it) or its components are regions already on the Region card (configure `SERVICE_REGIONS` instead). Add a config-sanity test (count + badge-unchanged + disjointness) like the existing `#606` ones in `status-determination.test.ts`.
2. `worker/src/probe.ts` — add `ProbeTarget` if API endpoint exists for RTT measurement
3. `worker/src/fallback.ts` — update ALL of:
   - `EXCLUDE_FALLBACK` — remove if fallback-eligible
   - `API_TIER` — add tier number (API: 1=Major LLM, 2=LLM, 3=Infra, 4=Voice; agents: 11=CLI, 12=IDE, 13=Plugin)
   - `TIER_LABEL` — add label if new tier introduced
   - `buildGroupedFallbackText` uses tier-based grouping — verify Discord alerts show correct labels
4. `worker/src/__tests__/` — update probe target count test, fallback tests, add service-specific tests

## Frontend
5. `src/utils/constants.js` — update ALL of:
   - `API_SERVICE_IDS` — add new service ID
   - `SERVICE_AND_APP_IDS` — add at correct display position (app → LLM → voice → inference → video → agent)
   - `SERVICE_CATEGORIES` — add to correct category filter (`apps`/`llm`/`voice`/`inference`/`video`/`agents`, #658). This same 6-way taxonomy drives the Sidebar filter, the Overview per-category sections (`SECTION_KEYS` in `src/pages/Overview.jsx` — keep in sync), and the is-down footer grouping (mirrored as `group` in `api/_is-down/slug-map.ts`, below)
   - `EXCLUDE_FALLBACK` — keep in sync with `worker/src/fallback.ts`
   - `API_TIER` — add tier number (keep in sync with `worker/src/fallback.ts`)
6. `src/hooks/usePolling.js` — add mock entry to `MOCK_SERVICES` at correct position (determines display order via `mergeWithMock`)
7. `src/hooks/useSettings.js` — new services auto-inserted at canonical position in `enabledServices` (no change needed, but verify logic works)
8. `src/pages/ServiceDetails.jsx` — add `STATUS_URL` entry for official status page link
9. `src/pages/Overview.jsx` — verify `TIER_LABEL` (keep in sync with `worker/src/fallback.ts`; `API_TIER` + `getFallbacks` imported from `src/utils/constants.js`)
10. `api/is-down.ts` — add to `API_TIER` + `EXCLUDE_FALLBACK` (keep in sync with `worker/src/fallback.ts`)
10a. `api/_is-down/slug-map.ts` — add a `SLUG_TO_SERVICE` entry with BOTH `category` (coarse `api`/`app`/`agent`, mirrors worker `ServiceStatus.category` — used by the is-down fallback filter) AND `group` (fine 6-way `apps`/`llm`/`voice`/`inference`/`video`/`agents`, mirrors `SERVICE_CATEGORIES` — drives the footer "Also check" grouping via `FOOTER_CATEGORY_ORDER`, #658). Also add `RELATED_SLUGS` cross-links. Coverage is pinned by `api/_is-down/__tests__/html-template.test.ts`.
10b. (region-aware services only) Region data lives in TWO cross-mirrored copies — both must update together. The sync is pinned by `worker/src/__tests__/region-status-sync.test.ts`:
   - `src/utils/regionStatus.js` — frontend (ServiceDetails RegionalAvailability card, Overview ActionBanner region line). Canonical source for the sync test.
   - `api/_is-down/region-status.ts` — Edge SSR (Is X Down? region recommendation line). Duplicated because Vercel Edge bundling cannot import from `src/`. Same shape, TS port.
   
   For both: add `SERVICE_REGIONS` entries (one per region with `key` substring-matched against incident title / componentNames + display `label`) and a `REGION_DOCS_URL` pointer to the provider's region docs. Add `ALWAYS_SHOW_REGIONS` membership only if the service should render the per-region card even with zero ongoing incidents (Bedrock / Azure OpenAI pattern). Surfaces on ServiceDetails + Overview ActionBanner via `regionStatusOf` (#422 Phase 1) + on `/is-*-down` SSR via the Edge mirror (#422 Phase 2).

## Documentation — service count ("N AI services")
11. `CLAUDE.md` — architecture section: service count, service list, category breakdown, probe count. NOTE: the KV schema (`docs/reference/kv-schema.md`) and fallback tier list (`docs/reference/fallback-tiers.md`) moved out of CLAUDE.md — update those files too if affected
12. `README.md` — service count, service table (add row), API Services header count, feature description, API endpoint comment
13. `README.ko.md` — same as README.md (Korean)
14. `CONTRIBUTING.md` — if Project Structure section exists

## SEO & Meta tags
15. `index.html` — `<meta name="description">`, `og:title`, `og:description`, `twitter:title`, `twitter:description`, JSON-LD (~6 occurrences)

## Landing page
16. `api/_intro/html-template.ts` — update ALL of:
    - meta description
    - hero pill number ("N AI Services")
    - dashboard preview mock: services running count, "All N", "Operational N", "+ N more" (KO/EN)
    - i18n strings KO/EN with service count (~12+ occurrences)
17. `docs/aiwatch-landing.html` — same as intro template (design draft)

## Methodology page (`/methodology`, #673)
17a. `api/_methodology/html-template.ts` — self-contained Edge SSR, **KO + EN i18n duplicated TWICE** (inline `data-i18n` defaults AND the `i18n` JS maps), so each count appears ~4×. Update ALL:
    - `hero.meta` service count ("N services · polled every 5 min") + the `<meta name="description">` count
    - **`s1.lead` category breakdown** — "N AI services — X LLM APIs, Y coding agents, Z voice, … inference & infra, … observability, … video, … AI apps" (KO `…개` + EN). The sub-counts MUST sum to the total; update the right bucket(s) for the new service's category.
    - **probe count** (only if the new service is probed — search the page for the probe phrasings: "directly-probed" / "are probed" / `probe 세트(N개)` / "N AI services … health-check probes"; currently 31) — kept in **LOCKSTEP with `PROBE_TARGETS.length`** by `api/_methodology/__tests__/html-template.test.ts` (#678); that test FAILS until the methodology count matches the new probe-target count.
    - **GOTCHA — quote escaping**: the page is `return \`…\``; a literal apostrophe in an i18n string must be `\\'` (NOT `\'`, which the template literal collapses to `'` → breaks the served inline `<script>` → the lang toggle silently dies). A test asserts every inline `<script>` parses (`new Function`).

## Is X Down (if adding a dedicated page)
18. `api/is-down.ts` — add service to `SERVICES` map
19. `api/_is-down/html-template.ts` — if needed
20. `vercel.json` — add rewrite rule `/is-{service}-down`
21. `public/sitemap.xml` — add URL entry (`lastmod` is auto-bumped to build date by `scripts/bump-sitemap-lastmod.mjs` via `prebuild` hook — #337 — so any placeholder date works for the initial commit)

## Reports site (aiwatch-reports) — commit + push to deploy (GitHub Pages auto-build)
22. `README.md` — service count, category breakdown (e.g., "N LLM APIs, N voice & inference")
23. `_config.yml` — description
24. `_templates/monthly-report.md` — service count, category breakdown
25. Current month report (e.g., `2026-03/index.md`) — service count, category breakdown
26. `index.md` — top-level index page
27. `scripts/generate-charts.js` — service count in comments

## Assets (after deploy)
28. `scripts/generate-og-intro.mjs` — update `SERVICE_COUNT`, run `node scripts/generate-og-intro.mjs` (generates both `public/og-intro.png` + `docs/social-preview.png`), then commit + push
29. `docs/screenshot.png` — recapture desktop dashboard
30. `docs/screenshot-mobile.png` — recapture mobile dashboard
31. GitHub Settings → Social preview — re-upload

## Deployment
32. `npx wrangler deploy --config worker/wrangler.toml --dry-run` — build check
33. `npm run deploy:worker` — deploy after user approval
34. `git push origin main` — Vercel auto-deploy for frontend

## Post-deploy verification (probe-warm / coverage gate)
35. A newly-added service has two **machine-checkable** production-gated checks — add them as
    `verify-after` lines **with Tier-A `assert:` clauses** (#873) so the daily `verify-reminders` job
    auto-verifies them instead of pinging (grammar: **[verify-assertions.md](verify-assertions.md)**):
    ```
    - [ ] verify-after <+7d> — probe warmed → medium confidence + a real score
          assert: GET /api/status/cached | services[id=<id>].scoreConfidence == "medium"
    - [ ] verify-after <+30d> — #802 coverage gate lifts → rejoins the ranking
          assert: GET /api/status/cached | services[id=<id>].coverageDays >= 30
    ```
    (Only if the service is a probe target for the first line. Validate before shipping:
    `node scripts/verify-assertions.mjs --issue N --dry-run`.)
