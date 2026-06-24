# Discord Alert Delivery Paths

> Extracted from CLAUDE.md to keep the auto-loaded project file lean. CLAUDE.md links here; this is the canonical reference for how Discord alerts reach the operator and per-user webhooks.

## Two Discord alert paths (#467, #475, #486)

1. **Operator** — the `*/5` cron posts to the single `env.DISCORD_WEBHOOK_URL` secret (always on for the operator).
2. **Per-user** — a visitor's own Discord webhook (Settings → Alerts), delivered **server-side** by the same cron via `deliverToSubscribers` (`worker/src/webhook-subscriptions.ts`) — tab-independent (#486 PR3 replaced the old browser relay).

### Single source of truth (#475)
The cron appends every embed it sends the operator to a rolling KV feed (`alert:feed:recent`, built in `worker/src/alert-feed.ts`), surfaced as the `alertFeed` field on `/api/status` (+`/cached`) for external readers. In the same cron cycle it fans those exact entries out to confirmed subscribers, so operator/user alerts are **byte-identical** (Detection Lead, AI analysis, grouping, fallback, region all included) and duplicate suppression — incl. the #473 cross-poll status↔incident race — lives server-side.

Consequence: user alerts fire at **cron cadence (≤~5min, same time as the operator)** whether or not a tab is open. The two target *different* webhooks (no cross-source dupe).

- Per-subscriber delivery is isolated (`Promise.allSettled`) — one dead webhook never blocks the rest. Dead webhooks (Discord 410/404, or `MAX_FAIL_COUNT` consecutive failures) are pruned. Per-sub per-alert dedup via `webhook:sent:{hash}:{alertKey}` (2h).
- `postEmbed` re-validates the decrypted URL with `isAllowedAlertWebhook` (defense in depth) before POSTing.
- `/api/alert` is a CORS/SSRF-guarded Discord proxy (Discord hosts only, #468) — still used by the Settings "Send test alert" button.
- Slack subscriptions use Slack's native `/feed` RSS app (no webhook stored). **#724 — the `/feed` item structure is aligned with the Discord operator embed**: it carries the 🤖 AI analysis summary (the `/feed` handler reads `ai:analysis:*` for active incidents → `RssAiAnalysisMap`), uses a **provider-grouped title** for shared incidents (mirroring "Anthropic (Claude API, claude.ai, Claude Code)"), and ranks "Try instead" identically (the handler attaches `aiwatchScore` to `services:latest` via `scoreFor` first, since `getFallbacks` needs it). The feed is **public**, so the operator-only 🐦 tweet draft is deliberately never emitted there (Discord operator embed only). Delivery model still differs: Discord is real-time cron push; Slack `/feed` polls on its own cadence. **#759/#768 — Slack /feed dedup hardening**: Slack dedups by guid but re-notifies on item *content* change, and historically posted a freshly-detected incident BEFORE its AI analysis landed, then re-posted it on each status transition. #759 **holds** an AI-less active item (≤6 min) so the first post carries AI; #768 makes the active item's description **status-invariant** (severity + impact label + AI + fallback only — no status word / running duration / per-update timeline text, which now render on the resolved item only) so investigating→identified no longer re-posts. Net per incident: 1 active post (with AI) + an optional monitoring re-post (AI dropped by #724) + 1 resolved post.
- Per-user filter honors `alertCondition` (`down`/`all`, #470) + `alertTarget` (`all`/`custom` picker) + `alertIncidents` (default on); the filter (`shouldDeliver`) is byte-parity with the former client `shouldRelay`.
- **Per-user link target (#726)** — a deliberate exception to byte-identical (alongside the operator-only tweet draft): the stored embed's "View on AIWatch" link is the **operator dashboard** (`ai-watch.dev/#{svc}`), correct for the operator; the per-user relay rewrites it to the **is-down page** (`ai-watch.dev/is-{slug}-down`) via `toPerUserEntry` before `postEmbed`, since general subscribers want the friendlier public page (matching Slack `/feed`). The is-down URL comes from the shared `isDownUrl` (rss.ts, single source of truth); `NO_IS_DOWN_PAGE` services (bedrock/azureopenai) keep the dashboard hash (no-op). Operator delivery is a direct cron post (not via `deliverToSubscribers`), so its link is unchanged.

### History
#467 restored delivery; #473/#474 chased operator-format parity in JS until #475 moved formatting server-side; #486 moved **delivery** server-side too (PR1 backend + PR2 Settings/confirm UI + PR3 cutover).

## #486 server-side delivery (channel-control double opt-in)

The per-user webhook is registered via a **channel-control double opt-in**: the user pastes their webhook → the worker posts a confirm link *through* the channel (`{CONFIRM_BASE_URL || https://ai-watch.dev}/confirm?h=&c=`) → clicking **[Activate]** (a button POST — the GET is crawler-safe / side-effect-free, so Discord/scanner link-prefetch can't auto-confirm) proves channel control. Channel control = identity; no account, email, or PII.

- The confirmed subscription stores an **AES-GCM-encrypted** webhook URL + filters in `webhook:sub:{hash}` (permanent; deleted via `POST /api/webhook/unsubscribe`, the privacy deletion path) — a deliberate **reversal of #467's hash-only posture**, **fail-closed** on a missing `WEBHOOK_ENC_KEY` (subscriptions simply disabled rather than storing plaintext). KV keys: see [kv-schema.md](kv-schema.md) (`webhook:sub:` / `webhook:pending:` / `webhook:sent:` / `webhook:confirm:budget:`).
- The active-webhook count in the daily summary comes from `listConfirmedHashes` (confirmed `webhook:sub:*` subscriptions).
- The Privacy policy (`src/components/LegalContent.jsx`, EN + KO) documents that the webhook URL is AES-GCM-encrypted + stored server-side, used only for alert delivery + filters, and deleted immediately on unsubscribe.

### Removed in the PR3 cutover
- `src/utils/webhookAlerts.js` (browser relay) + `src/utils/webhookRegistration.js` (legacy `webhook:reg:` ping) and their tests.
- The worker `POST/DELETE /api/webhook/ping` endpoint and the `webhook:reg:` count.
