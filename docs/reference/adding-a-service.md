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
| **Official uptime %** | **Never in `summary.json`** — fetch the status page HTML. Atlassian (needs `statusComponentId`) → if the HTML carries `data-uptime-lazy="<code>"` placeholders (#1389), `GET …/uptime_showcase?components=<code>` and look for `timelines.<code>.days` — an empty `timelines` means that component is untracked; otherwise the inline `window.uptimeData = {…}` blob (the `window.uptimeData \|\| {}` loader seed alone is not data). incident.io → `component_uptimes` in the `self.__next_f` payload (needs `incidentIoComponentId`). Better Stack → `…/index.json` (`availability`) | a real number | **absent** (gcloud `incidents.json` gives incidents only), or incident.io `"uptime":"$undefined"` |
| **Incident history** | `…/api/v2/incidents.json` count + date span, or the feed's records | populated, recent | **0 / sparse** (gcloud feed is ~3 entries; e.g. Veo/Imagen have 0 ever) |
| **Probeable endpoint** | a public, no-auth GET that returns fast (any HTTP status = alive) | yes → adds latency + Responsiveness score | no (auth-gated) → score relies on uptime only |

- **Identify the platform from the page, not the API (#857).** A Statuspage-compatible `/api/v2/summary.json` does **not** mean Atlassian — incident.io serves one too. Atlassian uses 12-char component ids (`r7tngp2p3sjd`) + `data-uptime-lazy` placeholders or `window.uptimeData`; incident.io uses ULIDs (`01K0Q5QSJV…`) + `component_uptimes`. Getting this wrong sets neither `statusComponentId` nor `incidentIoComponentId`, so `needsHtml` never fetches the page and a **published uptime is silently dropped** — the service then scores on the `/60` no-uptime rescale and looks like it publishes nothing (turbopuffer shipped this way and lost 11 score points for a month).
  - **Fastest check — the response header.** `curl -sI https://status.<vendor>.<tld> | grep -i statuspage` → an `x-statuspage-version:` header means genuine Atlassian. Its absence (typically `server: Vercel`) is strong evidence it is **not**, whatever `summary.json` answers — though absence alone isn't proof, since a CDN/proxy in front could strip vendor headers, so confirm with the id/embed signatures above. One request, no HTML parsing. Confirmed 2026-07-17 in both directions: `status.jina.ai` + `status.minimax.io` carry the header (Atlassian, with `window.uptimeData`); `status.tavily.com` + `status.turbopuffer.com` do not (incident.io — Tavily's CSP names `…incident-io-team.vercel.app` and its HTML is Next.js `__next_f`).
- **For an incident.io page, `display_uptime_mode` does NOT decide whether we can compute uptime.** `'chart_and_percentage'` publishes a number; `'chart_only'` emits `"uptime":"$undefined"`, but that field is not what we read — `computeIncidentIoUptime` derives a figure from `data_available_since` + `component_impacts`, so a `chart_only` page still gets one. Replicate moved to the dedicated Cloudflare Status v3 path in #1384.
- **Thin sources → the service renders like Azure OpenAI** (operational, "No official uptime", `score` withheld at low confidence, ~never an incident) — a near-empty card that lowers dashboard quality. **gcloud-`incidents.json`-only services are thin** (Veo/Imagen/STT/Vertex Vector — #680 held for this reason). Gemini looks rich only because it ALSO merges the AI Studio source (`aistudioStatus`).
- **Prefer candidates that are BOTH data-rich AND fill a single-service category gap** (#601). If a thin category (video/image/vector/observability/embeddings) needs a sibling, pick a Better Stack / Atlassian / incident.io competitor over a gcloud product. The per-category shortlists — and the sources already declined — are in **[service-candidates.md](service-candidates.md)**; a row there means "the page is parseable", NOT that it passes this audit.
- Record the audit verdict (and the source URLs you checked) in the issue before implementing.
- Measure the rows with `node scripts/service-step0.mjs measure` (the card's own component ids, every number
  labelled by its scope) and attach its block to the issue; `check` refuses a block with an unmeasured row.
  Whether each badge component is the card's product, and the category gap, stay manual rows (#1974).
  A new `id:` in `worker/src/services.ts` is denied until the issue carries a Step-0 block the gate accepts (`service-add-gate`, [workflow-hooks.md](workflow-hooks.md)).

## Worker (backend)
1. `worker/src/services.ts` — add `ServiceConfig` entry at correct position in `SERVICES` array (determines API response order: LLM → voice → infra → apps → agents). If the status page hosts unrelated components (multi-tenant Atlassian / incident.io / metastatuspage feeds — e.g. `githubstatus.com`, `status.openai.com`, `status.claude.com`), set `incidentKeywords` to scope the visible incident list — otherwise the service card will surface every incident on the page (#397)
   - **`addedAt: 'YYYY-MM-DD'` (required, #802)** — set today's date. AIWatch holds a service OUT of the Reliability Ranking for its first 30 days (`coverageDays < MIN_COVERAGE_DAYS`) so a thin observed window can't rank it off insufficient data; it auto-rejoins at 30d. WITHOUT `addedAt` the new service ranks immediately on incomplete data. (Established services predating #802 are intentionally absent = full coverage.) #809 — `addedAt` also flows into the monthly archive (`/api/report`, via `SERVICE_ADDED_AT`) so the report-side coverage gate (aiwatch-reports#45) excludes a mid-month-added service from that month's ranking.

   **`apiUrl` reachability check (required)**: verify the chosen `apiUrl` responds from a non-browser client before committing — some providers block Cloudflare Workers IPs on their custom domain while the canonical host remains accessible (DeepSeek case, #498):
   ```bash
   curl -sf --max-time 5 "{apiUrl}" -o /dev/null && echo "OK" || echo "BLOCKED — check .statuspage.io mirror"
   ```
   For Atlassian Statuspage services, if the custom domain is blocked, use `https://{slug}.statuspage.io/api/v2/summary.json` instead. Confirm `statusComponentId` resolves on the chosen endpoint. See `docs/reference/status-determination.md` § "Status page URL selection".

   **Which components the service counts (#1821)** — decide each component on the page by asking in order:
   1. Is it this card's product, or another product's, whether or not AIWatch has a card for that product? The card's product is what its name says: an app and an API of one product are different products only where AIWatch gives them separate cards. The provider's own grouping is the first evidence: a component the provider groups under another card belongs to that card (#1008). Any other product's component → **Excluded**.
   2. Is it where the card's users use the product, or an account / billing / admin screen? Decide from what the component does, whatever its group: Admin → **Reference** (#1669).
   3. Is it something the card's users call or open themselves, or an auxiliary page (marketing site, docs) or internal infrastructure (a queue, a cloud provider's group)? Called or opened → **Counted**; otherwise → **Excluded**.

   For question 3, judge a grouped component with the rest of its official group: the provider's grouping says which surface it belongs to (the product's API, its console, its infrastructure). An auxiliary page (marketing site, docs) is excluded whatever its group.

   The PR that sets a verdict names its evidence, read in this order: the component's description and group on the status page, the incidents tagged on it (title, updates, postmortem), the provider's docs for that surface, and the AIWatch issue that set the card's scope. A name or a category label alone is not evidence. A component with no such evidence is listed in that PR as unresolved, and its setting is not changed.

   **Per-component breakdown (#606, optional but check it)** — if the status page exposes **≥2 availability-relevant components**, configure a per-component breakdown. Pick the right mechanism — full rules in `docs/reference/status-determination.md` § "Per-component snapshot":
   - **Curated allowlist** → `displayComponentIds: [ids]` (a few stable surfaces).
   - **Per-model / many churny components** → `displayAllComponents: true` + `componentDenylist: ['Docs','Website',…]` + `componentSurfaces: [names]` (surfaces stay individual; the rest fold into a collapsible "Models" group). With a `statusComponentId` and no `statusComponentIds`, also set `uptimeOverLiveComponents: true`, or uptime is computed on that one component alone (#1679; e.g. cerebras). On an incident.io page (`incidentIoComponentId` set), set `uptimeOverPageComponents: true` with a single anchor id instead of an id list (#1709; e.g. fireworks).
   - **Shared status page** (multiple AIWatch services on one page, e.g. status.openai.com) → per-service `displayComponentIds` matching the official groups, **disjoint across the sibling services** (add a LEAK-GUARD test); set `componentsUrl` (components.json) whenever the page publishes one and you resolve any component ids against it — summary.json can serve only part of a page and rotate which part, so "the ids I need are in it today" is not a criterion (#1175). The CI guard in `page-components-source.test.ts` only catches the case where a page-mate already set one.
   - **BetterStack page** → `componentDenylist: ['Website']`, plus any resource the criterion above makes Reference (a console): this path shows no reference rows, so a Reference resource is denied (#1829). `parseBetterStackComponents` extracts the breakdown from `index.json` (grouped by section), and the denylist also scopes uptime, status and the calendar.
   - **Instatus page** (`instatusUrl`) → this path carries no reference components, so a component the criterion above makes Reference is left out of `displayComponentIds` and out of the incident scope (`incidentComponents` or `incidentKeywords`). Uptime is read from the one component named in `statusComponent` (`parseInstatusUptime`): set it to the Counted component that is the card's API. When the page has several Counted components and none is the API, the maintainer picks in the issue that adds the service, naming each component and the uptime the page shows for it, with the day read.
   - Skip when the service maps to a single component (≥2 gate suppresses it) or its components are regions already on the Region card (configure `SERVICE_REGIONS` instead). Add a config-sanity test (count + badge-unchanged + disjointness) like the existing `#606` ones in `status-determination.test.ts`.
2. `worker/src/probe.ts` — add `ProbeTarget` if API endpoint exists for RTT measurement
3. `worker/src/fallback.ts` — update ALL of:
   - `EXCLUDE_FALLBACK` — remove if fallback-eligible. A model-hosting platform stays on the list until it can be measured whether a user's model is available on the other services (#1028); the evidence is that measurement, naming what was compared and the day.
   - `API_TIER` — add tier number (membership and what each tier means: [fallback-tiers.md](fallback-tiers.md)). Tier 2 is hosted inference for open models (#1748): a join names, in the issue, the open models the service serves, from its own page, with the day read.
   - `TIER_LABEL` — add label if new tier introduced
   - `buildGroupedFallbackText` uses tier-based grouping — verify Discord alerts show correct labels
   - `SUBSTITUTES` / `OPEN_MODEL_HOSTS` (`api/_shared/substitutes.ts`, #1753) — an entry only where the tier is not the set of real substitutes. `evidence` is optional (a first-party URL and the day it was read; `substitutes.test.ts` checks the shape): write it for any group that claims specific models or capabilities, as the existing ones do; the general-LLM groups carry none. `substitutes.test.ts` requires the groups labelled `LLM` and `LLM Hosting` to equal Tier 1 and Tier 2, so a join to either tier also edits `GENERAL_LLM` or `OPEN_MODEL_HOSTS`.
   - Where the pages do not settle a choice above, it goes to the maintainer in the issue that adds the service, listing the options. A ruling that generalises is written back into this step with its issue number.
4. `worker/src/__tests__/` — update probe target count test, fallback tests, add service-specific tests

## Frontend
5. `src/utils/constants.js` — update ALL of:
   - `API_SERVICE_IDS` — add new service ID
   - `SERVICE_AND_APP_IDS` — add inside the section of the array whose comment header fits (agents live in `AGENT_SERVICE_IDS`)
   - `SERVICE_CATEGORIES` — add to the bucket that fits (#658; read the object, the bucket list grows). This one taxonomy drives the Sidebar filter, the Overview per-category sections (`SECTION_KEYS` in `src/pages/Overview.jsx` — keep in sync), and the is-down footer grouping (mirrored as `group` in `api/_is-down/slug-map.ts`, below). `inference` (shown as "Inference & Infra") is, in the comment's words, a "catch-all for non-LLM API infra". A provider that sells both an LLM API and its own GPU infrastructure is the maintainer's pick in the issue that adds the service, giving the provider's own pages for each product and what the person who asked for the service chose.
   - `EXCLUDE_FALLBACK` / `API_TIER` — nothing to do: imported from `worker/src/fallback.ts` (step 3)
6. `src/hooks/usePolling.js` — add mock entry to `MOCK_SERVICES` at correct position (determines display order via `mergeWithMock`)
7. `src/hooks/useSettings.js` — new services auto-inserted at canonical position in `enabledServices` (no change needed, but verify logic works)
8. `src/utils/statusPageUrls.js` — add the `STATUS_URL` entry for the official status page link. It must equal the service's `statusUrl`: `junie-migration.test.ts` pins every id to it except its `KNOWN_DIVERGENT` set, whose own comment says its entries are "not verified as intentional". Whether a new service whose human-facing page differs from its machine endpoint may join that set is open: the options are a `STATUS_URL` equal to `statusUrl`, or an entry in the set with its comment reworded; the maintainer picks in the issue that adds the service, naming both URLs and the day each was read
9. `src/pages/Overview.jsx` — a new `SERVICE_CATEGORIES` bucket also goes in `SECTION_KEYS` (step 5)
10. `api/is-down.ts` — `EXCLUDE_FALLBACK`: nothing to do, imported from `worker/src/fallback.ts` (step 3)
10a. `api/_is-down/slug-map.ts` — add a `SLUG_TO_SERVICE` entry with BOTH `category` (coarse `api`/`app`/`agent`, mirrors worker `ServiceStatus.category` — `is-down-group.ts` opens an `api` member's error group by default) AND `group` (fine bucket, mirrors `SERVICE_CATEGORIES` — drives the footer "Also check" grouping via `FOOTER_CATEGORY_ORDER`, #658). Also add `RELATED_SLUGS` cross-links. Coverage is pinned by `api/_is-down/__tests__/html-template.test.ts`.
10b. (region-aware services only) Region data lives in TWO cross-mirrored copies — both must update together. The sync is pinned by `worker/src/__tests__/region-status-sync.test.ts`:
   - `src/utils/regionStatus.js` — frontend (ServiceDetails RegionalAvailability card, Overview ActionBanner region line). Canonical source for the sync test.
   - `api/_is-down/region-status.ts` — Edge SSR (Is X Down? region recommendation line). Duplicated because Vercel Edge bundling cannot import from `src/`. Same shape, TS port.
   
   For both: add `SERVICE_REGIONS` entries (one per region with `key` substring-matched against incident title / componentNames + display `label`) and a `REGION_DOCS_URL` pointer to the provider's region docs. Add `ALWAYS_SHOW_REGIONS` membership only if the service should render the per-region card even with zero ongoing incidents (Bedrock / Azure OpenAI pattern). Surfaces on ServiceDetails + Overview ActionBanner via `regionStatusOf` (#422 Phase 1) + on `/is-*-down` SSR via the Edge mirror (#422 Phase 2).

   **Region-AWARE ≠ region-SWITCHABLE (#973).** A `SERVICE_REGIONS` entry only says we can tell *which* region an incident hit. Add the id to **`REGION_SWITCHABLE`** only if a caller can actually move their traffic to another region — that is what unlocks `recommendedRegion`, and with it the Overview banner line, the is-down recommendation, the Discord `buildRegionHint`, and fallback suppression (`hasRegionSwitch`). Get this wrong and AIWatch prints an instruction nobody can follow *and* suppresses the cross-service fallback they could have used. The two properties are independent in both directions: `openai` is aware-but-not-switchable (its region keys were copied from `incidentKeywords` — names OpenAI mentions in incident text, not selectable endpoints), while SpaceXSI (`xai`) is switchable-but-undocumented (`us-east-1.api.x.ai` works; the doc page 404s, #560).

   **Verify a `REGION_DOCS_URL` in a real browser before adding it.** The link must land the reader *on the region list*, not merely return 200 — a retired path that 301s to the top of an unrelated guide still returns 200, which is how pinecone's dead `troubleshooting/available-cloud-regions` survived (#973). Use a section anchor when the regions live inside a larger page. No verified region doc → **no entry**; the card and banner simply omit the link. A doc url for a non-switchable service can never render (the sync test asserts this).

## Documentation — service count ("N AI services")

> **The count + category breakdown are CI-gated (#1074).** `api/__tests__/service-count-lockstep.test.ts`
> derives the total + per-bucket counts from `GROUP_MEMBERS` (`worker/src/service-groups.ts`), and the
> PROBE count from `PROBE_TARGETS`, then fails if `CLAUDE.md`,
> `index.html`, `api/_intro/html-template.ts` or `api/_methodology/html-template.ts` disagrees — per
> locale, and per bucket on `/methodology`. Run `npm run test:src` after the steps below: a miss is a
> red test, not a wrong number in production.
>
> **The probe count is covered here too** — every phrasing of it on `/methodology` plus
> `CLAUDE.md`. The #678 test in `api/_methodology/__tests__/html-template.test.ts` checks it with two
> `toContain` EXISTENCE assertions, so it alone would pass with nearly all of them wrong; it keeps
> ownership of the non-probed service LIST (Azure OpenAI / Modal).
>
> **Also pinned:** the **is-down count** (`TOTAL − 2`
> — every service except Bedrock / Azure OpenAI) in CLAUDE.md; CLAUDE.md's **Status-Data-Flow** sentence
> (`parallel N-service fetch`); the **`/intro` dashboard mock**'s `+ N more services`, which must
> equal `TOTAL −` the cards it actually renders; **`docs/reference/data-flow.md`**'s api-diagram
> `parallel fetch (N services)`; and **`public/llms.txt`**'s lead + dashboard-link counts (#1184).
>
> **Enumerate count occurrences by PHRASING, never by grepping the current value** — that search cannot
> see a stale copy, by construction.
>
> It checks **every** occurrence of each anchored sentence, not just the first — the Edge templates
> carry each KO string twice (inline default + `ko` i18n map) and the map copy is what renders after a
> language toggle. Twinned strings also assert a minimum occurrence count, so **deleting or rewording**
> one copy fails too (deliberately: the guard must be told where to look).
>
> **The rule: pin what a CONSTANT determines; remove what only a live fetch does.** Two counts failed
> that test and were removed (each with a test asserting it stays removed):
> - `/methodology` §3 "Official" said `(30 services)` — `uptimeSource` is assigned at RUNTIME and is a
>   FLOOR (a transient fetch failure moves a service out). Live had already reached 31 after Kimi (#1067).
> - The READMEs said `24 multi-component services` — live was **31**. The set is not config-determined:
>   `resolveSvcComponents` is gated on `displayAllComponents` / `displayComponentIds` /
>   `statusComponentIds` (26 services), but `parseBetterStackComponents` attaches components with no
>   COMPONENT-LIST config gate (it takes only a denylist and self-gates on `>= 2`; reaching it needs
>   only `betterStackUrl`), so 6 unconfigured BetterStack
>   services render one while
>   `characterai` — configured, but its status page is dead (#689/#800) — does not. `26 − 1 + 6 = 31`
>   was a coincidence of the day, not a fact to publish.
>
> By contrast the READMEs' **OSV package count** (`24 AI SDK packages`) IS pinned — `OSV_PACKAGES` is a
> static array, so that number is a config fact.
>
> **Not covered — still hand-checked:** the prose service LISTS themselves (the service NAMES in
> CLAUDE.md's architecture section); the mock's `Issues N` tab (fabricated demo state — `Operational`
> and the stat card are pinned to `TOTAL − Issues`, so they DO sum to `All N`);
> `CONTRIBUTING.md`; and `docs/reference/*` prose counts OTHER than the `data-flow.md` sentence now
> pinned above — including the two probe-count copies (`data-flow.md`'s overlay line and
> `directory-map.md`'s probe.ts line), which `PROBE_TARGETS` determines and which are therefore
> pinnable, just not pinned yet.

11. `CLAUDE.md` — architecture section: service count, service list, category breakdown, probe count. NOTE: the KV schema (`docs/reference/kv-schema.md`) and fallback tier list (`docs/reference/fallback-tiers.md`) moved out of CLAUDE.md — update those files too if affected
12. `README.md` — add the service's row to its category table (pinned per category to `GROUP_MEMBERS`) and its id to `### Available Service IDs` (pinned to `SERVICES`). The README states no service count; its badge reads the live total
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

## Methodology page (`/methodology`, #673)
17. `api/_methodology/html-template.ts` — self-contained Edge SSR, **KO + EN i18n duplicated TWICE** (inline `data-i18n` defaults AND the `i18n` JS maps), so each count appears ~4×. Update ALL:
    - `hero.meta` service count ("N services · polled every 5 min") + the `<meta name="description">` count
    - **`s1.lead` category breakdown** — "N AI services — X LLM APIs, Y coding agents, Z voice, … inference & infra, … observability, … video, … AI apps" (KO `…개` + EN). The sub-counts MUST sum to the total; update the right bucket(s) for the new service's category.
    - **probe count** (only if the new service is probed — search the page for the probe phrasings: "directly-probed" / "are probed" / `probe 세트(N개)` / "N AI services … health-check probes") — kept in **LOCKSTEP with `PROBE_TARGETS.length`** — every occurrence, on this page and in CLAUDE.md, by `api/__tests__/service-count-lockstep.test.ts` (#1074). (`html-template.test.ts`'s #678 check is existence-only and would pass with most of them wrong.)
    - **GOTCHA — quote escaping**: the page is `return \`…\``; a literal apostrophe in an i18n string must be `\\'` (NOT `\'`, which the template literal collapses to `'` → breaks the served inline `<script>` → the lang toggle silently dies). A test asserts every inline `<script>` parses (`new Function`).

## Is X Down (if adding a dedicated page)
18. `api/is-down.ts` — add service to `SERVICES` map
19. `api/_is-down/html-template.ts` — if needed
20. `vercel.json` — add rewrite rule `/is-{service}-down`
21. Sitemap — nothing to add: `/sitemap.xml` (`api/sitemap.ts`, #887) lists every `SLUG_TO_SERVICE` slug
21a. `api/_is-down/seo-content.ts` — the page's copy. Write it from the vendor's own pages and the config, and check each of these (#1028):
    - **Vendor and ownership**, **delivery forms** (API / web / desktop / CLI / IDE — no single-form claim where several exist) and **current product names**.
    - **Status source and component scope** match the service's entry in `worker/src/services.ts`.
    - **FAQ alternatives** name only monitored services of the same capability, as a category ("X and Y offer …"), not as a current recommendation. The answer always renders as written; the live recommendation is the alternatives card's job.
    - **A frequency, comparative or market sentence stays only if** AIWatch's own record shows it, the vendor's own page says it, or it states a first-party-backed causal structure (then as "can"). Otherwise delete it, do not reword it weaker. `npm run lint:seo-copy` fails on the listed words unless the whole sentence is in its `BACKED` list with a source, for that page; it does not see claims built from ordinary words ("share infrastructure", "same backend"), so read for those too.

## Reports site (aiwatch-reports) — commit + push to deploy (GitHub Pages auto-build)
No service count is written by hand: a report's count and category breakdown, and each `index.md` row, are generated from the month's archive, and the README carries a live badge.

27. `scripts/generate-charts.js` — chart names come from `/api/v1/status` (aiwatch-reports#146). Edit only when the service adds a dashboard section (a new `SECTION_KEYS` entry): add that key to `GROUP_ORDER` at the same position

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
