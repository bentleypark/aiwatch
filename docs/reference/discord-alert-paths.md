# Discord Alert Delivery Paths

> Extracted from CLAUDE.md to keep the auto-loaded project file lean. CLAUDE.md links here; this is the canonical reference for how Discord alerts reach the operator and per-user webhooks.

## Two Discord alert paths (#467, #475)

1. **Operator** — the `*/5` cron posts to the single `env.DISCORD_WEBHOOK_URL` secret (always on for the operator).
2. **Per-user** — a visitor's own Discord webhook (Settings → Alerts), delivered **browser-side** by `src/utils/webhookAlerts.js` (`runWebhookAlerts`, from `usePolling` each live poll — 60s visible / 5min hidden — **only while a tab is open**).

### #475 single source of truth
The cron appends every embed it sends the operator to a rolling KV feed (`alert:feed:recent`, built in `worker/src/alert-feed.ts`), surfaced as the `alertFeed` field on `/api/status` (+`/cached`). The browser is a **dumb relay** — it applies the per-user filter and POSTs the worker's embed *verbatim*, so operator/user alerts are **byte-identical** (Detection Lead, AI analysis, grouping, fallback, region all included) and duplicate suppression — incl. the #473 cross-poll status↔incident race — lives server-side and can't reappear in JS.

Consequence: user alerts fire at **cron cadence (≤~5min, same time as the operator)**, not the old browser-computed 60s. The two target *different* webhooks (no cross-source dupe). The server stores only a SHA-256 hash of the user URL (`webhook:reg:{hash}`, count-only), so the worker provides payloads but the browser does the POST.

- `/api/alert` is a CORS/SSRF-guarded Discord proxy (Discord hosts only, #468).
- Slack subscriptions use Slack's native `/feed` RSS app (no webhook stored).
- Per-user filter honors `alertCondition` (`down`/`all`, #470) + `alertTarget` (`all`/`custom` picker) + `alertIncidents` (default on).

### History
#467 restored delivery; #473/#474 chased operator-format parity in JS until #475 moved formatting server-side (#474's `getGroupedFallbacks`/`sanitizeForDiscord`/grouping now run once, in the worker).

## #486 server-side delivery transition (in progress — PR1+PR2 merged, PR3 pending)

The browser relay above is being replaced because it only fires while a tab is open (a structural flaw — an alerting product must notify you when you're *not* watching the dashboard).

- **PR1** (`worker/src/webhook-subscriptions.ts`) + **PR2** (`src/utils/webhookSubscription.js`, Settings subscription UI, `api/confirm.ts`) add a **channel-control double opt-in**: the user pastes their webhook → the worker posts a confirm link *through* the channel (`{CONFIRM_BASE_URL || https://ai-watch.dev}/confirm?h=&c=`) → clicking **[Activate]** (a button POST — the GET is crawler-safe / side-effect-free, so Discord/scanner link-prefetch can't auto-confirm) proves channel control. Channel control = identity; no account, email, or PII.
- The confirmed subscription stores an **AES-GCM-encrypted** webhook URL + filters in `webhook:sub:{hash}` (permanent; deleted via `POST /api/webhook/unsubscribe`, the privacy deletion path) — a deliberate **reversal of #467's hash-only posture**, **fail-closed** on a missing `WEBHOOK_ENC_KEY` (subscriptions simply disabled rather than storing plaintext). KV keys: see [kv-schema.md](kv-schema.md) (`webhook:sub:` / `webhook:pending:` / `webhook:sent:` / `webhook:confirm:budget:`).
- The cron fan-out (`deliverToSubscribers`) is **defined but NOT wired yet**.

### PR3 (pending) wires it + completes the cutover
- Wire `deliverToSubscribers` into the cron fan-out.
- Remove the browser relay (`webhookAlerts.js`) + the legacy `webhook:reg:` ping **in the same release** so the two paths never double-send.
- Update the user-facing **Privacy policy** (`src/components/LegalContent.jsx`) — it still says *"the server does not store your webhook URL"* / *"stored in your browser's localStorage"*, both of which become inaccurate once delivery turns on, so the policy edit **must land with PR3** (#486 acceptance criteria: privacy update merged in the same PR that turns delivery on).

> ⚠️ **Do not deploy the worker for #486 until PR3 is ready** — PR1/PR2 only add storage + UI. Deploying earlier persists encrypted URLs in prod before the Privacy disclosure + actual delivery exist.
