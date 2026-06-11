# Service Status Determination

Per-service status is resolved in `worker/src/services.ts` with this priority:

1. **Multi-component worst-of** (`statusComponentIds`, #379): when configured, look up each id in the page's `components`, normalize each, and pick the worst (`down` > `degraded` > `operational`). Used for coding agents whose user-facing surface spans multiple components — e.g. Cursor IDE primary + Cloud Agents + Automations + CLI; Claude Code component + Claude API dependency. `statusComponentId` (singular) remains the *primary* component for uptime parsing, calendar days, and component-miss alerting; `statusComponentIds` is purely for badge resolution. Convention: list the primary as the first entry of `statusComponentIds`. If none of the ids resolve in the components list, falls through to step 2.
2. **Component match** (`statusComponentId` or `statusComponent`): use that component's status
3. **Component not found**: fall back to overall page indicator
4. **No component configured**: use overall indicator, BUT if no relevant unresolved incidents matched after `incidentExclude`/`incidentKeywords` filtering, treat as `operational` (prevents cross-contamination from unrelated incidents on shared status pages, e.g., ChatGPT incident should not affect OpenAI API status)
5. **`incidentExclude` component bypass** (#359): when an `incidentExclude` pattern matches the incident title, check if the incident's `componentNames` starts with `config.statusComponent` — if it does, include the incident anyway. Prevents "claude.ai and API unavailable" from being dropped from Claude API just because the title contains "claude.ai". Component tagging is more authoritative than title substring matching.
6. **Component-status incident filter** (`filterByComponentStatus`): if component is `operational` but provider bulk-linked incidents to all components, remove unresolved incidents (keep resolved + monitoring). Prevents e.g., Anthropic admin API incident from showing on claude.ai/Claude Code when their components are healthy
7. **Status page fetch failure cross-validation** (post-processing in `fetchAllServices`):
   - If service is `degraded` from fetch failure (no incidents) AND probe RTT is normal → override to `operational`
   - If 70%+ of services on the same platform (Atlassian/incident.io/etc.) fail simultaneously → platform outage → override all to `operational`
   - Conservative: only overrides when evidence is strong (≥2 recent probes healthy, or quorum failure detected)

## Status page URL selection

`apiUrl` (the machine-readable fetch endpoint) and `statusUrl` (the human-facing link) can differ. When selecting `apiUrl`, **verify it is reachable from Cloudflare Workers** — some providers host their status page on a custom domain that blocks Workers IPs while the canonical Atlassian/incident.io host remains accessible.

**Verification method**: `curl -sv "<url>" 2>&1 | head -20` — look for SSL connection reset or HTTP 000 (curl's notation for a connection-level failure — no HTTP response received at all), which indicate Workers-IP blocking even when a browser can reach the page.

### Known case: DeepSeek (2026-05, #498)

`status.deepseek.com/api/v2/summary.json` resets the connection from Workers IPs (Alibaba Cloud CDN with geo/bot filtering). `deepseek.statuspage.io/api/v2/summary.json` is the Atlassian-hosted mirror — identical component IDs and data, always accessible.

**Fix**: set `apiUrl` to the `.statuspage.io` URL; keep `statusUrl` as the branded domain for the dashboard link.

**Symptom pattern**: `fetch-fail:{svcId}` KV key reaches `3` (threshold) and stops refreshing — the write-back guard (`next <= threshold`) skips writes once the counter would exceed 3, so the TTL is last refreshed on the 3rd failure (writes on failures 1, 2, and 3 each extend it; no writes occur after that) and expires 1800s (~30 min) later. After expiry the counter resets; the threshold is crossed again after 3 more cron cycles (~15 min), so the re-alert fires roughly 45 min after the original alert rather than exactly 30 min. Probe cross-validation (Phase 1) may not fully suppress these if the API probe has a concurrent RTT blip, or if fewer than 2 recent probe snapshots are available (e.g., after a probe disruption).

**General rule**: when adding or updating a service with an Atlassian Statuspage, check both `{custom-domain}/api/v2/summary.json` and `{slug}.statuspage.io/api/v2/summary.json`. Use whichever responds with HTTP 200 from a non-browser client. Also confirm that the `statusComponentId` value in the service config resolves correctly against the chosen endpoint's component list — component IDs are not always identical between a custom domain and its `.statuspage.io` mirror.

## Parsers must map incident `impact` — null silently drops the incident from scoring (#556, #564)

A parser that leaves `incident.impact = null` makes the incident **invisible to the AIWatch Score's Incidents component**: `score.ts` excludes null-impact incidents from both `affectedDays` and `weightedAffectedDays` (the #261 filter, intended to drop informational/post-mortem posts). So a real outage parsed with null impact shows **Affected Days 0** and applies **no incident penalty** → an inflated score.

**Instatus is the footgun** (`worker/src/parsers/instatus.ts`): its two SSR formats expose severity under different field names/vocabularies, and both previously yielded null —
- **Nuxt** (e.g. Mistral): incident-level `severity` (`MINOR`/`MEDIUM`/`MAJOR`/`CRITICAL`) — the parser had `impact: null` hardcoded.
- **Next.js** (e.g. Perplexity): component-status `impact` (`OPERATIONAL`/`UNDERMAINTENANCE`/`DEGRADEDPERFORMANCE`/`PARTIALOUTAGE`/`MAJOROUTAGE`) — the parser only handled `MAJOROUTAGE`/`PARTIALOUTAGE`, so `DEGRADEDPERFORMANCE` fell to null.

Both now go through the shared `mapInstatusImpact()` helper: `CRITICAL→critical`, `MAJOR(OUTAGE)/HIGH→major`, `MINOR/MEDIUM/LOW/PARTIALOUTAGE/DEGRADEDPERFORMANCE→minor`, `OPERATIONAL/UNDERMAINTENANCE/MAINTENANCE/NONE/empty→null`, and any **unknown value → `minor` + a warn-once** (an `/incidents`-feed entry is real, so surface it rather than hide it; the warning makes a new Instatus vocabulary value diagnosable). Note `impact:null` excludes from *scoring* only — a null-impact entry still appears in the raw incident list/count.

**BetterStack is the second footgun** (`worker/src/parsers/betterstack.ts`, #564 — Modal/Together/Fireworks/HuggingFace/xAI): both incident paths hardcoded `impact: null`. BetterStack exposes no structured per-incident severity (the RSS `<item>` has only title/description; `index.json` `affected_resources` read `resolved` at rest), and — critically — its automated monitors emit a generic **"X went down" for ANY failed check**, so `"down"` is NOT a reliable severity signal (Together/Fireworks are 20/20 "went down" model-flaps, not declared outages). The shared `mapBetterStackImpact()` therefore maps **major only on explicit broad-outage wording** (`outage`/`unavailable`/`offline`) and **everything else → minor** — deliberately symmetric with the Instatus all-minor outcome, to avoid structurally over-penalizing monitor-flap services. The xAI path additionally needs its own maintenance-title skip (it has no `betterStackUrl`, so the `index.json` maintenance filter doesn't run) and maps from the tag-stripped description (raw CDATA markup like `class="offline-banner"` would false-match). **Display complement (#597)**: because this mapping tags monitor-flaps `minor` (not `null`), the **display** grouping (`groupIncidents` — SPA `src/utils/incidentGrouping.js` + SSR mirror `api/is-down/incident-grouping.ts`) also clusters `minor` `— recovered`/`— down` flap-suffix titles, not just null-impact/generic ones, so the incident history (dashboard Incidents + ServiceDetails + is-X-down) isn't flooded by per-model blips. `major`/`critical` suffix incidents stay individual, and the Score/MTTR keep reading the raw incident list — grouping is display-only.

**General rule**: when adding a parser for a new status-page platform, confirm it maps the platform's severity/impact vocabulary onto `'minor' | 'major' | 'critical'` (reserve `null` for genuinely informational/maintenance entries) — otherwise the service's incidents won't count toward its score.
