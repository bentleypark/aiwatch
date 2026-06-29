# Content-Security-Policy (CSP) — #482

AIWatch ships a CSP across the Vercel-served surfaces (SPA + Edge SSR). Rolled out **phased**:
**Report-Only first → refactor inline → enforce**, so a strict policy never breaks the live site.

## Current state — Phase 3 (Edge SSR ENFORCING; SPA still Report-Only)

- **Edge SSR pages ENFORCE their own per-response CSP** (#823/#828/#829 + the Phase-3 flip): badges /
  methodology / intro via a **nonce** (`api/_shared/csp-nonce.ts`, `Cache-Control: no-store`), is-down
  via a **content hash** (`api/_shared/csp-hash.ts` `cspForHtml`, keeps `s-maxage=60`). Each handler
  sets `Content-Security-Policy` (enforcing) itself; every inline `on*=` handler was refactored to a
  delegated listener first, so nothing breaks.
- **SPA still `Content-Security-Policy-Report-Only`** via `vercel.json` `source: "/(.*)"`. That global
  header ALSO co-applies on the Edge routes, but Report-Only never blocks — the Edge's own enforcing
  policy is what gates those pages (verified). Enforcing the SPA is the remaining #482 work: `index.html`
  has inline `<link onload/onerror>` handlers + an inline `<script>` that must be hashed/refactored
  first; only then flip vercel.json to enforcing AND scope its `/(.*)` source to exclude the Edge
  routes (so two enforcing policies don't intersect-block the Edge scripts).
- `Reporting-Endpoints: csp="/api/csp-report"` is still set; both the SPA Report-Only header and each
  Edge enforcing header point their `report-uri`/`report-to` at the same sink.
- **Sink**: **`api/csp-report.ts`** (Vercel Edge Function) receives violation reports via the policy's
  `report-uri` (legacy `application/csp-report`) + `report-to` (modern `application/reports+json`),
  normalizes both wire formats (`parseCspReports`), and logs one compact line per violation
  (`summarizeCspReport`) → reviewable in Vercel function logs. Always `204`s; `GET` → `405`.
  Unauthenticated by design (a report sink takes anonymous browser beacons); it only logs, no KV/fan-out.

### The policy (Phase 1 target, shipped as Report-Only)

```
default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; form-action 'self';
script-src 'self' https://www.googletagmanager.com https://t1.kakaocdn.net;
connect-src 'self' https://aiwatch-worker.p2c2kbf.workers.dev https://www.google-analytics.com https://region1.google-analytics.com https://www.googletagmanager.com;
img-src 'self' data: https://ai-watch.dev https://aiwatch-worker.p2c2kbf.workers.dev;
style-src 'self' https://fonts.googleapis.com 'unsafe-inline';
font-src 'self' https://fonts.gstatic.com;
report-uri /api/csp-report; report-to csp
```

**Why these choices:**
- **`script-src` deliberately OMITS `'unsafe-inline'`** — this is the *inventory mechanism*. Report-Only
  then flags every inline `<script>` (theme init, GA4 config, Kakao loader, i18n) and every inline
  `onclick`/`onerror`/`onmouseover` handler (~30 across is-down + intro) — exactly the surfaces Phase 2
  must refactor before enforcing. Adding `'unsafe-inline'` would suppress those reports and defeat the phase.
- **`style-src` KEEPS `'unsafe-inline'`** — inline `style=` attributes are pervasive in the SSR templates
  and are low XSS risk; CSP3 `'unsafe-hashes'` for style attributes is brittle. Kept indefinitely.
- **Allowlisted origins** (browser-loaded only): GA4 `googletagmanager.com` (gtag.js) in script+connect;
  `google-analytics.com` + `region1.google-analytics.com` (GA4 beacons) in connect; Kakao
  `t1.kakaocdn.net` (share SDK, injected on is-down) in script; the **Worker origin** in connect (`/api/*`
  fetches) AND img (the status/uptime **badges** on ServiceDetails load from `<worker>/badge/<id>` — #482
  review); Google Fonts `fonts.googleapis.com` (stylesheet) in style, `fonts.gstatic.com` (files) in font;
  `ai-watch.dev` (OG images, icons) + `data:` in img. The many `status.*` provider origins are *server-side
  Worker fetches*, not browser loads — correctly excluded.

### Reviewing violations
Read the Vercel function logs for `[csp-report]` lines (`directive=… blocked=… doc=… src=file:line`).
Each is what an enforcing policy would block. Triage: a **legit origin** → add to the policy; an **inline
script/handler** → refactor in Phase 2.

### Known expected reports (not bugs to chase)
- Every inline `<script>` + `onclick`/`onerror` handler (the Phase 2 refactor list).
- Kakao share (`connect-src`): clicking KakaoTalk share on an is-down page hits `*.kakao.com` API hosts
  not yet in `connect-src` — left to be surfaced here, then allowlisted once the exact host is confirmed.

## Roadmap

- **Phase 2 — IN PROGRESS (per-surface, still Report-Only).** Each Edge SSR page now sets its OWN CSP
  header (so the per-surface nonce/hash works) and refactors every inline `on*=` handler → delegated
  `addEventListener`. The mechanism splits by **whether the page is cached**:
  - **Low-traffic, no-store pages → per-response NONCE** (`api/_shared/csp-nonce.ts`): badges +
    methodology (#823), intro (#828). The handler mints a nonce, stamps it on each inline `<script>`,
    and sets `Cache-Control: no-store` — a nonce is incompatible with caching (a cached page would
    reuse one nonce for all visitors). Fine here: these pages are low-traffic, self-contained SSR.
  - **High-traffic /is-down → per-response HASH** (`api/_shared/csp-hash.ts`, #482 PR3): the handler
    hashes the rendered inline scripts (`cspForHtml`) into `script-src 'sha256-…'`. A content hash is
    derived from the served bytes, so it stays valid when the page is **edge-cached** — `/is-down`
    keeps its `s-maxage=60` cache (it's the busiest, outage-viral SEO surface). The delegated handlers
    are a single always-rendered dispatcher (`[data-ga]` for GA4 + `[data-action]` for copy/share);
    this retired the `escJsForAttr` JS-string-in-attribute footgun.
  - The SPA keeps the static `vercel.json` Report-Only header.
- **Phase 3** — flip each surface's own header to enforcing `Content-Security-Policy`, and **scope the
  `vercel.json` `/(.*)` CSP to exclude the migrated Edge routes** (else its nonce/hash-less policy
  co-applies and the browser, enforcing the intersection of all delivered policies, blocks the inline
  scripts). Keep the allowlist + `object-src 'none'` / `base-uri 'self'` / `frame-ancestors 'none'`.
- **Verification is log-free**: each surface is checked by serving its own header in ENFORCING mode
  locally and confirming zero console CSP violations + every control still works (the prod-log review
  is infeasible on the free Vercel plan; that's why the original Phase-2 gate was re-scoped).

## Tests
- `api/__tests__/csp-report.test.ts` — `parseCspReports` (both wire formats + garbage → no throw) +
  `summarizeCspReport` (kebab ↔ camel field names).
- `api/__tests__/csp-headers.test.ts` — reads `vercel.json` and asserts: Report-Only (not enforcing),
  `script-src` without `'unsafe-inline'`, origins allowlisted (incl. the Worker origin in `img-src`),
  hardening directives + sink wiring.

## Local verification note
`vercel dev` applies the `vercel.json` headers, so the header is visible on the Edge SSR routes
(`/is-*-down`, `/intro`). The **SPA root `/` 307-loops in `vercel dev`** (a pre-existing routing quirk
reproducible with the headers block removed too — unrelated to CSP); the SPA's CSP is verified on a
real Vercel Preview deployment, not `vercel dev`.
