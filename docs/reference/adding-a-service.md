# Adding a New Service — Full Checklist

> Extracted from CLAUDE.md to keep the auto-loaded project file lean. CLAUDE.md links here; this is the canonical reference.

When adding a new monitored service, update ALL of the following:

## Worker (backend)
1. `worker/src/services.ts` — add `ServiceConfig` entry at correct position in `SERVICES` array (determines API response order: LLM → voice → infra → apps → agents). If the status page hosts unrelated components (multi-tenant Atlassian / incident.io / metastatuspage feeds — e.g. `githubstatus.com`, `status.openai.com`, `status.claude.com`), set `incidentKeywords` to scope the visible incident list — otherwise the service card will surface every incident on the page (#397)

   **`apiUrl` reachability check (required)**: verify the chosen `apiUrl` responds from a non-browser client before committing — some providers block Cloudflare Workers IPs on their custom domain while the canonical host remains accessible (DeepSeek case, #498):
   ```bash
   curl -sf --max-time 5 "{apiUrl}" -o /dev/null && echo "OK" || echo "BLOCKED — check .statuspage.io mirror"
   ```
   For Atlassian Statuspage services, if the custom domain is blocked, use `https://{slug}.statuspage.io/api/v2/summary.json` instead. Confirm `statusComponentId` resolves on the chosen endpoint. See `docs/reference/status-determination.md` § "Status page URL selection".
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
   - `SERVICE_AND_APP_IDS` — add at correct display position (app → LLM → voice → inference → agent)
   - `SERVICE_CATEGORIES` — add to correct category filter (e.g., `llm`, `inference`)
   - `EXCLUDE_FALLBACK` — keep in sync with `worker/src/fallback.ts`
   - `API_TIER` — add tier number (keep in sync with `worker/src/fallback.ts`)
6. `src/hooks/usePolling.js` — add mock entry to `MOCK_SERVICES` at correct position (determines display order via `mergeWithMock`)
7. `src/hooks/useSettings.js` — new services auto-inserted at canonical position in `enabledServices` (no change needed, but verify logic works)
8. `src/pages/ServiceDetails.jsx` — add `STATUS_URL` entry for official status page link
9. `src/pages/Overview.jsx` — verify `TIER_LABEL` (keep in sync with `worker/src/fallback.ts`; `API_TIER` + `getFallbacks` imported from `src/utils/constants.js`)
10. `api/is-down.ts` — add to `API_TIER` + `EXCLUDE_FALLBACK` (keep in sync with `worker/src/fallback.ts`)
10b. (region-aware services only) Region data lives in TWO cross-mirrored copies — both must update together. The sync is pinned by `worker/src/__tests__/region-status-sync.test.ts`:
   - `src/utils/regionStatus.js` — frontend (ServiceDetails RegionalAvailability card, Overview ActionBanner region line). Canonical source for the sync test.
   - `api/is-down/region-status.ts` — Edge SSR (Is X Down? region recommendation line). Duplicated because Vercel Edge bundling cannot import from `src/`. Same shape, TS port.
   
   For both: add `SERVICE_REGIONS` entries (one per region with `key` substring-matched against incident title / componentNames + display `label`) and a `REGION_DOCS_URL` pointer to the provider's region docs. Add `ALWAYS_SHOW_REGIONS` membership only if the service should render the per-region card even with zero ongoing incidents (Bedrock / Azure OpenAI pattern). Surfaces on ServiceDetails + Overview ActionBanner via `regionStatusOf` (#422 Phase 1) + on `/is-*-down` SSR via the Edge mirror (#422 Phase 2).

## Documentation — service count ("N AI services")
11. `CLAUDE.md` — architecture section: service count, service list, category breakdown, probe count. NOTE: the KV schema (`docs/reference/kv-schema.md`) and fallback tier list (`docs/reference/fallback-tiers.md`) moved out of CLAUDE.md — update those files too if affected
12. `README.md` — service count, service table (add row), API Services header count, feature description, API endpoint comment
13. `README.ko.md` — same as README.md (Korean)
14. `CONTRIBUTING.md` — if Project Structure section exists

## SEO & Meta tags
15. `index.html` — `<meta name="description">`, `og:title`, `og:description`, `twitter:title`, `twitter:description`, JSON-LD (~6 occurrences)

## Landing page
16. `api/intro/html-template.ts` — update ALL of:
    - meta description
    - hero pill number ("N AI Services")
    - dashboard preview mock: services running count, "All N", "Operational N", "+ N more" (KO/EN)
    - i18n strings KO/EN with service count (~12+ occurrences)
17. `docs/aiwatch-landing.html` — same as intro template (design draft)

## Is X Down (if adding a dedicated page)
18. `api/is-down.ts` — add service to `SERVICES` map
19. `api/is-down/html-template.ts` — if needed
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
