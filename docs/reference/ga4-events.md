# GA4 Analytics & Consent Flow

> Extracted from CLAUDE.md to keep the auto-loaded project file lean. CLAUDE.md links here; this is the canonical reference.

All events use `trackEvent()` from `src/utils/analytics.js`. GA4 is only active when user consents via cookie banner.

**Consent flow across surfaces** (#352): three surfaces load GA4 with different mechanisms but share a single source of truth — the `aiwatch-cookie-consent` localStorage key (`'granted'` | `'denied'` | absent).
- **React SPA (dashboard)** — `src/utils/analytics.js`. Lazy `initGA()` only runs after `setConsent(true)`; gtag.js is not loaded otherwise. Consent Mode v2 defaults set in `initConsentDefault()` before any interaction. `clearAnalyticsCookies()` runs in two paths: (a) `setConsent(false)` — the dominant path, when the user clicks "Essential Only" on the banner — purges immediately; (b) `initConsentDefault()` on boot when `hasConsent() === 'denied'` — handles the manual `localStorage.setItem('aiwatch-cookie-consent','denied')` revoke path documented in the Privacy Policy.
- **Edge SSR pages** (`/is-*-down`, `/intro` — Vercel Edge Functions in `api/`) — gtag.js loads on every page view (needed for inline `onclick` event tracking), but the inline init script sets Consent Mode v2 default-denied first, then upgrades only `analytics_storage` to `granted` if `localStorage.getItem('aiwatch-cookie-consent') === 'granted'`. When the localStorage value is anything other than `'granted'` (denied, absent, or storage unavailable), the same inline script also clears `_ga`/`_gid`/`_gcl_au` (defense-in-depth for stale cookies from before the gate landed). The init payload + cookie banner are factored into shared modules `api/_shared/consent-init.ts` and `api/_shared/cookie-banner.ts` — both Vercel templates import from there to prevent drift between `/intro` and `/is-*-down`.
- **Reports site** (Jekyll, `aiwatch-reports/_includes/head.html` + cookie banner in `_includes/footer.html`) — same default-denied + localStorage opt-in + cleanup pattern as Edge SSR. The Jekyll inline payload is hand-synced with `api/_shared/consent-init.ts` + `api/_shared/cookie-banner.ts` because Jekyll cannot import TypeScript — see those module headers for the sync contract. Direct access at `bentleypark.github.io/aiwatch-reports/*` runs on a different origin so SPA-set consent isn't readable there; that path stays cookieless until first consent on the GH Pages origin itself (rare path, most users hit `ai-watch.dev/reports/*`).
- **Cookie banner on Edge SSR + Jekyll** — inline banner mirrors `src/components/CookieBanner.jsx` UX/copy and writes the same localStorage key. Shown only when localStorage is absent. Same-origin SPA consent is honored without re-prompting on subsequent navigation between surfaces (#352). Accept-click failure handling: if `localStorage.setItem` throws (Safari private mode, quota exhaustion), the Accept branch returns without calling `gtag('consent','update','granted')` and without hiding the banner — prevents a single page-view from running with upgraded consent that was never persisted.
- **`ad_storage` / `ad_user_data` / `ad_personalization` always denied** — AIWatch does not display advertisements; these Consent Mode v2 signals stay `denied` even on Accept. Only `analytics_storage` is upgraded. The Privacy Policy "Advertising" section commits to this contract — diverging here would break that commitment.
- **Identical localStorage key across all three surfaces** is required — diverging it would let one surface ignore the user's choice on another. Verified by two complementary suites: `tests/consent.spec.js` exercises the Edge SSR network — asserts no `_ga` cookie is set and that any `g/collect` ping carries the `gcs=G1*` denied marker; `src/utils/__tests__/analytics.test.js` covers the SPA helpers — asserts `setConsent(false)` denies all four Consent Mode v2 signals and removes `_ga`/`_gid`/`_gcl_au`, that `initConsentDefault()` reconciles stale cookies on the manual-revoke path, and that `setConsent(true)` skips `initGA()` when persistence fails.

| Event | Parameters | Location | Purpose |
|---|---|---|---|
| `page_view` | `page_title`, `service_id?` | App.jsx | SPA page transition |
| `select_service` | `service_id` | Overview (card click) | Service card click |
| `view_service` | `service_id` | Sidebar (service list) | Sidebar service click |
| `view_incident` | `incident_id` | Incidents page | Incident detail open |
| `fallback_click` | `from_service`, `to_service`, `location` | ActionBanner, Is X Down | Fallback recommendation click |
| `change_filter` | `filter` | Overview (filter tabs) | Status filter change |
| `category_filter` | `category` | Sidebar (category) | Category filter change |
| `navigate_page` | `page` | Sidebar (nav) | Page navigation |
| `click_refresh` | — | Topbar | Manual refresh |
| `click_github_header` | — | Topbar | GitHub link click |
| `click_analyze` | `has_analysis?`, `count?` | Topbar | Analyze button click (active: has_analysis=true + count, inactive: no params) |
| `open_legal` | `type` (privacy/terms) | Footer | Legal modal open |
| `save_settings` | — | Settings | Settings saved |
| `webhook_register` | `type` (discord) | Settings | Discord webhook URL added (Slack moved to native /feed, #467) |
| `webhook_remove` | `type` (discord) | Settings | Discord webhook URL removed (Slack moved to native /feed, #467) |
| `region_switch_intent` | `service_id`, `recommended_region`, `location` (`service_details` / `action_banner` / `is_down_page`) | ServiceDetails (Regional) · Overview (ActionBanner) · Is X Down SSR | Region guide link click — `location` distinguishes the surface that drove the click (#422 Phase 1 + Phase 2) |
| `click_reports` | — | Sidebar | Monthly reports link click |
| `click_request_service` | — | Sidebar (request link) | Service request link click |
| `copy_statusline_snippet` | `preset` (degraded_only/compact_badge/full_list/scoped/clickable) | Statusline page (Copy buttons) | Statusline integration adoption signal (#400 Phase 0) |
| `share` | `method` (x/threads/kakao/copy), `item_id` | Is X Down (share buttons) | Social share button click |
| `click_dashboard` | `location`, `source` | Is X Down (header/footer) | Dashboard link click |
| `click_cta_alerts` | `location`, `source?` | Is X Down (CTA/footer) | Set Up Alerts click |
| `click_ranking` | `location`, `source` | Is X Down (header/alternatives) | Ranking link click |
| `click_service_detail` | `location`, `service_id` | Is X Down (footer) | Service detail page click |
| `click_reports` | `location`, `source` | Is X Down (alternatives/footer) | Monthly reports link click (Is X Down) |
| `copy_rss` | `location`, `service_id` | Is X Down (CTA) · ServiceDetails (header) · Settings (Alerts) · Overview (incident banner) · Sidebar (footer) · Landing (alerts section) | RSS feed URL copied to clipboard. `location` ∈ `is_down_page`/`service_details`/`settings`/`action_banner`/`sidebar`/`landing`; `service_id`=`'all'` for the all-services `/feed.xml`, the page slug for per-service feeds (#430, #432, #433, #434) |
| `click_announcement` | `id`, `location` | Landing page (announcement banner) | Campaign announcement banner click-through (`?banner=<key>`, #265). `id`=announcement key |
| `copy_slack_feed` | `location`, `service_id?` | Settings (Alerts) · Is X Down (CTA) | Slack `/feed subscribe <feed-url>` command copied (#467) — zero-config Slack subscription via Slack's native /feed RSS app. `location` ∈ `settings`/`is_down_page`; `service_id` set on the Is X Down per-service command (service ID — equals the slug except for `claude-code`/`github-copilot` etc., matching `copy_rss`) |
| `font_load_failed` | `transport_type: 'beacon'` | index.html `<link>` onerror | Google Fonts CSS preload failed (CDN outage, ad blocker, network) — surfaces silent fallback to system fonts (refs #191) |

Is X Down pages (Edge SSR) and Landing page use inline `gtag()` calls directly since they don't use React.

**Reports site** (served at `ai-watch.dev/reports/` via the `api/reports.ts` proxy; #264) uses the same GA4 ID (`G-D4ZWVHQ7JK`) with event delegation in `_includes/footer.html`:

| Event | Parameters | Trigger | Purpose |
|---|---|---|---|
| `click_dashboard` | `location: reports_site`, `source: footer/body` | ai-watch.dev link click | Dashboard navigation from reports |
| `click_report` | `location: reports_site`, `report_month: YYYY-MM` | Monthly report link click | Report page view intent |
| `click_request_service` | `location: reports_site`, `page` | Service request link click | Request a Service link click |
