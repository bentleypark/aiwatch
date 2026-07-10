---
type: architecture
title: "Discord Alert Delivery Paths"
description: "How operator + per-user Discord alerts are delivered server-side by the cron — single-source alert feed, per-user filters, channel-control opt-in, tweet-draft exception."
tags: [worker, alerts, discord]
---

# Discord Alert Delivery Paths

> Extracted from CLAUDE.md to keep the auto-loaded project file lean. CLAUDE.md links here; this is the canonical reference for how Discord alerts reach the operator and per-user webhooks.

## Two Discord alert paths (#467, #475, #486)

1. **Operator** — the `*/5` cron posts to the single `env.DISCORD_WEBHOOK_URL` secret (always on for the operator).
2. **Per-user** — a visitor's own Discord webhook (Settings → Alerts), delivered **server-side** by the same cron via `deliverToSubscribers` (`worker/src/webhook-subscriptions.ts`) — tab-independent (#486 PR3 replaced the old browser relay).

### Operator phone-push side-channel (#778)
Independent of Discord, immediately after the operator Discord send the cron fires an **ntfy.sh phone push** (`sendPushAlert`) when `pushTargetFor(alert, scored)` returns a target — gated to a **NEW** (`alerted:new`) **down/degraded** (incident impact non-null, never informational) incident on a **PUSH_SCOPE** service (`claude`/`openai`/`gemini`/`chatgpt`/`claudeai` — deliberately narrower than the #777 search scope; `claudecode`/`codex` excluded as low-virality). Purpose: the operator Discord buries a real Tier-1 outage under 41 services + daily/changelog/security noise, and the Twitter-reply window is short (~1–2h) — a `Priority: urgent` push that fires *only* for the high-value moment cuts through. The ntfy `Click:` header is the #777 `buildTweetSearchUrl` Top-search URL, so **push → tap → viral "is X down" tweets to reply to**. Config: `NTFY_TOPIC` secret (bare topic name or full `https://ntfy.sh/<topic>` URL); absent → **fail-soft skip** (the Discord alert is unaffected). The push is in its own try-guard isolated from the operator send, ntfy headers are ASCII-only (no emoji in title/body), per-incident dedup is inherited from the `alerted:new` roster (one push per incident), and v1 is new-incidents-only (no recovery push). Operator-only — never reaches the per-user path.

### Single source of truth (#475)
The cron appends every embed it sends the operator to a rolling KV feed (`alert:feed:recent`, built in `worker/src/alert-feed.ts`), surfaced as the `alertFeed` field on `/api/status` (+`/cached`) for external readers. In the same cron cycle it fans those exact entries out to confirmed subscribers, so operator/user alerts are **byte-identical** (Detection Lead, AI analysis, grouping, fallback, region all included) and duplicate suppression — incl. the #473 cross-poll status↔incident race — lives server-side.

Consequence: user alerts fire at **cron cadence (≤~5min, same time as the operator)** whether or not a tab is open. The two target *different* webhooks (no cross-source dupe).

- Per-subscriber delivery is isolated (`Promise.allSettled`) — one dead webhook never blocks the rest. Dead webhooks (Discord 410/404, or `MAX_FAIL_COUNT` consecutive failures) are pruned. Per-sub per-alert dedup via `webhook:sent:{hash}:{alertKey}` (2h).
- `postEmbed` re-validates the decrypted URL with `isAllowedAlertWebhook` (defense in depth) before POSTing.
- `/api/alert` is a CORS/SSRF-guarded Discord proxy (Discord hosts only, #468) — still used by the Settings "Send test alert" button.
- Slack subscriptions use Slack's native `/feed` RSS app (no webhook stored). **#724 — the `/feed` item structure is aligned with the Discord operator embed**: it carries the 🤖 AI analysis summary (the `/feed` handler reads `ai:analysis:*` for active incidents → `RssAiAnalysisMap`), uses a **provider-grouped title** for shared incidents (mirroring "Anthropic (Claude API, claude.ai, Claude Code)"), and ranks "Try instead" identically (the handler attaches `aiwatchScore` to `services:latest` via `scoreFor` first, since `getFallbacks` needs it). The feed is **public**, so the operator-only 🐦 tweet draft — and its #777 companion `🔎 FIND TWEETS TO REPLY TO` block (an `is {service} down` Top-tab X-search link to find the viral outage tweet, plus ONE casual copy-paste reply for replying to it) — are deliberately never emitted there (Discord operator embed only, appended after the per-user feed entry is built). **#936** — the reply is no longer an in-embed ``` code block (one-click copy on Discord DESKTOP only; mobile long-press copies the whole embed). The embed now shows a one-line pointer (`💬 REPLY DRAFT in the message below ↓`) and the cron sends the reply text as its **own plain-text operator message** right after the embed (`sendDiscordMessage`, `flags:4` SUPPRESS_EMBEDS), so mobile "Copy Text" grabs exactly the reply. Operator channel only; isolated try-guard (a send failure never affects the alert). `buildReplyDraft` also now leads the reply with a status circle (🔴/🟠/🟢). Delivery model still differs: Discord is real-time cron push; Slack `/feed` polls on its own cadence. **#759/#768 — Slack /feed dedup hardening**: Slack dedups by guid but re-notifies on item *content* change, and historically posted a freshly-detected incident BEFORE its AI analysis landed, then re-posted it on each status transition. #759 **holds** an AI-less active item (≤6 min) so the first post carries AI; #768 makes the active item's description **status-invariant** (severity + impact label + AI + fallback only — no status word / running duration / per-update timeline text, which now render on the resolved item only) so investigating→identified no longer re-posts. Net per incident: 1 active post (with AI) + an optional monitoring re-post (AI dropped by #724) + 1 resolved post.
- Per-user filter honors `alertCondition` (`down`/`all`, #470) + `alertTarget` (`all`/`custom` picker) + `alertIncidents` (default on); the filter (`shouldDeliver`) is byte-parity with the former client `shouldRelay`.
- **Per-user link target (#726)** — a deliberate exception to byte-identical (alongside the operator-only tweet draft): the stored embed's "View on AIWatch" link is the **operator dashboard** (`ai-watch.dev/#{svc}`), correct for the operator; the per-user relay rewrites it to the **is-down page** (`ai-watch.dev/is-{slug}-down`) via `toPerUserEntry` before `postEmbed`, since general subscribers want the friendlier public page (matching Slack `/feed`). The is-down URL comes from the shared `isDownUrl` (rss.ts, single source of truth); `NO_IS_DOWN_PAGE` services (bedrock/azureopenai) keep the dashboard hash. **#936** — both the operator link and the rewritten per-user link are UTM-tagged (`utm_source=discord&utm_medium=notification&utm_campaign=outage`, via `appendUtm`) so alert clicks attribute to the notification channel instead of `(direct)`; the tag's query goes before the `#` on the dashboard hash link, and `toPerUserEntry`'s regex tolerates that query. Operator delivery is a direct cron post (not via `deliverToSubscribers`), so its link is unchanged.

- **Auto-monitor repeat bursts — the `autoMonitor` tag (#983)** — a provider whose Statuspage auto-monitor opens a **brand-new incident per blip** (same title, minutes long) defeats both existing suppressors: `flapSuppression` matches only the BetterStack `— down`/`— recovered` title shape, and `holdShortIncidents` bails on `impact === 'major'` — which Statuspage assigns whenever ONE sub-component reads `major_outage`. Twelve Labs published four such incidents in 7 hours on 2026-07-09 → **4 New + 4 Resolved** operator messages. The fix tags the incident at the source (`ServiceConfig.autoMonitorTitles` → `Incident.autoMonitor`, see [status-determination.md](status-determination.md)); on the alert path the tag makes the incident **hold-eligible and flap-suppressible regardless of `impact`**. Net for that burst: the sub-`FLAP_HOLD_MS` (9min) blip is swallowed entirely (neither New nor Resolved — the #835/#792 accepted symmetry), and a repeat inside the 60-min `alerted:flap:` window is deduped, leaving ~2 alert pairs instead of 4. **`critical` and Tier-1 are never held**, tagged or not.
  - **`FLAP_SUPPRESSION_ESCAPE_MS` (30min) — a flap is SHORT by definition.** Tagging a service's `major` incidents as flap-suppressible created a new exposure: flap suppression silences **both** halves (New *and* Resolved) of any same-titled incident inside the 60-min window, so a genuine sustained outage that reused the machine title minutes after a blip could have been muted for up to an hour. `isFlapSuppressible` now **escapes** any incident whose *run length* (`incidentRunMs` — `startedAt`→`resolvedAt`, or →now while ongoing) reaches 30 min, which is comfortably past every auto-monitor blip observed on either platform (5–16m). The escape is symmetric across the ongoing and resolved halves, so an escaped incident that alerted New can never lose its Resolved and strand an "ongoing" card. It **generalizes** to the pre-existing BetterStack flap services (modal/together/fireworks/huggingface/luma/helicone): a 3-hour `— down` is no longer treated as a flap there either, and a first sight of an already->30min incident on those services now alerts instead of being held. Because this feeds a *suppression* guard it **fails open**: an unparseable `startedAt` returns `Infinity` (→ escapes → the alert ships) plus a `console.warn`, since returning 0 would pin a real outage below the threshold on every cron cycle and mute it for the whole window; an unparseable `resolvedAt` degrades to measuring against now; only a *future* `startedAt` (clock skew) clamps to 0, and it self-corrects as `nowMs` advances. `nowMs` is a **required** parameter, not optional — an optional clock would let a call site silently keep the old always-suppressible behavior and reproduce the exact silent drop the guard exists to prevent (#970).
  - **Suppression is logged.** The cron emits `[cron] #283/#983 flap-suppressed (same-title window active): <svc> <incId> autoMonitor=<bool> "<title>"` whenever it drops an incident into `suppressedIncIds` via the flap window. Dropping there kills BOTH the New and the Resolved alert, so without the line a post-incident triage cannot distinguish *"AIWatch suppressed it"* from *"AIWatch never saw it"* — the exact forensics gap #970 hit.

- **Discord and Slack DISAGREE on sub-poll-interval incidents, by design (#983)** — expect this and do not chase it as a dedup bug. Discord is a **cron push**: the `*/5` handler sees every incident that exists at any tick, so a burst of four 5–16m incidents produces four alerts. Slack `/feed` is a **poll**: the `active` item exists only while the incident is live, and #793's orphan-resolution guard suppresses a `resolved` item whose `active` was never served (no `feed:active-emitted:{incId}` marker). Slack's RSS poller backs off to a long cadence (#860, a Slack-side behavior AIWatch cannot influence), so during the Twelve Labs burst it missed three of the four live windows entirely and emitted **one** item — the fourth incident's resolution. Symptom to recognize: *"Discord alerted N times, Slack once and late."* Both surfaces are behaving correctly; only the Discord side is worth suppressing (which #983 does).

- **Service-status edge alerts are a Tier-1-only safety net (#767)** — `buildServiceAlerts` (🔴 Service Down / 🟠 Partially Degraded / 🟢 Service Recovered, which fire only in the incident-less gap `!hasOngoingIncident`) is emitted **only for claude/openai/gemini** (`API_TIER[id]===1`). Non-Tier-1 services rely on the canonical incident alerts (`buildIncidentAlerts`) alone — the status-edge alert otherwise produced a redundant second message when the provider flipped its status indicator one cron cycle before publishing the incident object (the #759 AssemblyAI "Service Down" 6:18 → "New Incident" 6:23 double). Tier-1 keeps it so a Tier-1 hard-down with NO parseable incident still pages.

- **Informational (`impact: none`) incidents DO alert, and look different (#970)** — a provider can open an incident that degrades no component (Statuspage `impact: none`), e.g. Runway's 2026-07-08 "Aleph 2.0 delayed generations". These used to reach **no channel at all**: `filterByComponentStatus` dropped the ACTIVE incident because the service's own component was still `operational` (see [status-determination.md](status-determination.md) rule 6), so `buildIncidentAlerts` never saw it — and the resolved path needs a prior `alerted:new:` roster entry, so the 🟢 Resolved alert stayed silent too; the incident only appeared on the dashboard once it resolved. Now such an incident alerts when it names a component in the service's badge group. Consequences to expect in the operator channel: the embed is the normal `🔴 {service} — New Incident`, but (a) the **service badge stays `operational`** (correct — the provider degraded nothing), so `buildIncidentAlerts` attaches **no "Try instead" fallback block** (it gates on `firstSvc.status !== 'operational'`), and (b) the **#767/#778 phone push never fires** (`pushTargetFor` requires `inc.impact != null` — informational incidents are explicitly out of scope). Slack `/feed` emits the active item as usual. So an `impact: none` alert is a *notification*, not a page.

- **New-incident AI-hold — non-Tier-1 only (#882)** — the cron runs a new incident's AI analysis **inline with a cancellable 15s budget** (`INLINE_ANALYSIS_BUDGET_MS`; an uncancellable 8s `Promise.race` until #955) so it can merge into the embed. When that call overruns, the alert historically shipped **AI-less on BOTH surfaces** (operator embed + per-user relay are built from the same `description`), and since the send is fire-and-forget (no message ID captured) neither could be patched once the end-of-cron `refreshOrReanalyze` backfilled `ai:analysis` — so the alert permanently disagreed with the dashboard modal (which reads the backfilled KV). #882 applies the **#759 publish-before-analysis hold to the Discord push path**: on a fresh `alerted:new:` whose AI isn't ready, a **non-Tier-1** incident is **HELD** (the send loop `continue`s before the roster write / feed append / send / push, stamping a write-once `pending:ai:{incId}` first-seen marker) instead of shipping AI-less. The next cron cycle's `refreshOrReanalyze` backfills the analysis; a later cycle's **KV-first read** (`ai:analysis` preferred over a fresh inline call — `formatAnalysisEmbedSection` renders both identically) then releases the alert WITH the AI section. Decision is the pure `shouldHoldForAiAnalysis` (`alerts.ts`): holds only when AI is genuinely pending (not `merged`/`no-model`/`generic` — those never get AI) and only within the bounded window (`AI_HOLD_MS = 10min ≈ 2 cron cycles); **past the window it fail-opens** (ships AI-less so an alert is never lost), and a KV-read error (`firstSeenMs=0`) also fail-opens. **Tier-1 (claude/openai/gemini) is NEVER held** — the operator alert + #778 phone push stay immediate; apps/agents (chatgpt/claudeai/claudecode/codex) are non-Tier-1 and hold-eligible. Held keys are excluded from the `alert:count:{date}` daily tally (they weren't sent). Net delay: **~5min typical** (only on a cycle where the inline budget actually overran — no hold when Gemma answers in time), **~10min worst-case then AI-less**; the dashboard/modal show the incident live throughout, so only the Discord alert is delayed. Distinct from the #633/#835 flap hold (`pending:new:`, which suppresses a *phantom* short/flap alert) — this holds a *real* alert briefly for completeness; the two markers never clobber (`pending:ai:` vs `pending:new:`). Slack `/feed`'s counterpart is the #759 `AI_HOLD_MS=6min` hold in `rss.ts`.
  - **Efficiency/safety details**: the inline AI call fires **only on the incident's first sighting** — a held incident on a later cycle relies on the KV-first `ai:analysis` read + `refreshOrReanalyze`'s backfill, so a hold doesn't burn a second Gemma/Sonnet call every cycle. And because the fail-open window can only elapse if the `pending:ai` marker persists, a **failed first-sight marker write fail-opens immediately** (ships AI-less) rather than risk an unbounded hold (a re-stamped first-sight window would never advance if the write kept failing AND AI never landed).
  - **Accepted tradeoff — a sub-cycle flash incident held then resolved emits nothing on Discord/feed** (code-review #882): a held incident whose roster (`alerted:new:`) was never written, if it **resolves within the hold window** (~one cron cycle, before `refreshOrReanalyze` backfills AI), fires **neither New nor Resolved** (the resolved branch is `alertedNewMap.has`-gated, which cleanly avoids a #793-style orphan "Resolved" but means the incident is silent on the alert surfaces). This is **symmetric with the already-accepted #835/#792 flap-hold** behavior (a held blip that self-recovers emits neither), now extended to any non-Tier-1 service. It requires BOTH an 8s AI overrun AND a sub-~5min resolution, the dashboard shows the incident live throughout, and such a brief outage is typically over before an alert would be read — so it's accepted, not fixed. (Tier-1 is never held, so a Tier-1 flash incident still alerts immediately.)

- **🎯 recovery-prediction line — two placements (#827 F4 + #846)** — the "how our AI estimate held up" line (`🎯 AI prediction: 45m (within ~45m est.)`, from `predictedVsActualText`) appears on BOTH resolution surfaces, but was built in different places. Slack `/feed` renders it for **every** resolved incident carrying a numeric estimate (`rss.ts` `descHtml`, tier-agnostic). Discord originally attached it (`recoverySection`) **only** to the Tier-1 status-edge `alerted:recovered:` path (#827 F4) — which fires rarely (incident-less gap only) — so the canonical **`alerted:res:` "Incident Resolved" embed** (the resolution path for ALL services) showed no prediction, and Discord effectively never displayed it while Slack did. **#846** attaches the SAME single-line wording to the `alerted:res:` embed, computed live from the still-warm `ai:analysis:{svcId}:{incId}` estimate + the resolved incident's actual duration. The two surfaces now share `resolvedAtOf` + the `estimatedRecoveryHours == null → omit` gate (both in `incident-history.ts`) so wording and actual-duration derivation are identical; a missing/`N/A` estimate omits the line on both. The Discord block is best-effort (a KV/parse failure logs + omits, never aborts the send) and `!recoverySection`-guarded so it never double-emits alongside the Tier-1 path.
  - **#847 — corpus accrual fix**: the same `alerted:res:` block now ALSO writes the durable **#827 incident-history record** (`buildHistoryRecord` → `appendIncidentHistoryBatch`) for **each affected service**, so the corpus accrues on normal incident resolutions. It was previously written ONLY in the `alerted:recovered:` block (Tier-1 status-edge, incident-less gap) → normal resolutions recorded nothing, starving the accuracy ledger (F1/F3) + RAG corpus (F2). Idempotent (dedups by incId, so the two alert paths can't double-record); a grouped incident records once per surface (each surface's own RAG corpus grows), and `summarizeAccuracy` **dedups by incId** so the shared prediction is counted once — per INCIDENT, not per affected surface — in the accuracy metric.

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

## #955 — why the AI section went missing (silent analysis failures)

The #882 hold assumes `refreshOrReanalyze` will backfill `ai:analysis` on a later cron cycle. Four
independent defects broke that assumption, and each was invisible on its own. Symptom: `ai:usage`
showed 7 of 16 calls `failed` on 2026-07-08 with **zero Sonnet successes on any day**, while
`ANTHROPIC_API_KEY` was set and correctly threaded to `refreshOrReanalyze`.

| # | Defect | Effect |
|---|--------|--------|
| 1 | `claude-sonnet-4-20250514` hardcoded in `ai-analysis.ts` **and** `monthly-narrative.ts` (pinned #21, 2026-03-26) reached its **2026-06-15 retirement** | Every Sonnet call 404'd. `analyzeWithSonnet` swallowed it (`if (!res.ok) return null`), so the fallback was dead for weeks |
| 2 | The cron's inline analysis was `Promise.race([analyzeIncident, 8s])`, but `analyzeWithSonnet` carried its own 10s `AbortSignal.timeout` | Sonnet only ever got the budget Gemma hadn't already spent, and the race **cancelled nothing** — a response landing at 9s was paid for, discarded, and booked as `failed` |
| 3 | No retry anywhere in the AI path. `analyzeWithSonnet` returned `null` on *any* `!res.ok` | A 429/500/529 (exactly the retryable classes) was treated identically to a permanent 404 |
| 4 | On failure, `refreshOrReanalyze` wrote `ai:reanalysis-skip:{svcId}:{incId}` with a flat **1800s** TTL | The five-minute cron skipped the next six cycles. The lock is per-INCIDENT, so one transient Gemma parse failure froze the incident for 30min. It outlived `AI_HOLD_MS` (~10min), so the held alert was *guaranteed* to ship AI-less |

Observed timeline before the fix — a non-Tier-1 incident could never get its AI section:

| t | what happened |
|---|---|
| 0 | first sight → inline 8s race → Gemma fails → Sonnet cannot finish → `null` → `failed++`, #882 hold starts |
| 5m | `firstSight=false` → no inline call (#882 avoids double-spend) → `refreshOrReanalyze` tries → Sonnet 404 → `null` → **30min lock written** |
| 10m | `AI_HOLD_MS` expires → alert ships **AI-less** (fail-open) |
| 10–40m | lock active → `result.skipped`; nothing runs |
| 40m | retry → same 404 |

Fixes, in the same order: the model id + request shape moved into `anthropic.ts` (one place, pinned by
test — Sonnet 5 also gets an explicit `thinking:{type:'disabled'}`, since omitting it selects adaptive
thinking whose tokens come out of `max_tokens`; a determinism guard, not a fix for an observed
truncation — see the verification note below); the inline race became a real `AbortController` budget (`INLINE_ANALYSIS_BUDGET_MS`
= 15s) propagated into the fetch; `callAnthropicMessages` classifies each HTTP status and retries the
transient ones once, honouring `retry-after`; and `reanalysisLockTtlSec` scales the cooldown by failure
kind — **only `permanent` earns 30min**, `transient`/`aborted` write no lock at all so the very next cron
cycle retries *inside* the hold window.

Two supporting changes make the next regression visible instead of silent. `wrangler.toml` gained an
`[observability]` block — `console.error` was previously emitted and immediately lost, which is why a
404 loop left no trace. And `ai:usage` now records **attempts** per model, not just successes: a
fallback that is always reached and never succeeds reads `Sonnet: 0/7` and raises a `⚠️ Sonnet fallback:
7 attempts, 0 successes` line in the daily summary, whereas the old counters printed a bare `Sonnet: 0`
whether the fallback was broken or simply never needed. `calls` is also booked from the returned
attempt on *every* path now, including the throw path: the old `usage.calls++` sat after the `await`
inside the `try`, so a thrown error incremented neither `calls` nor `failed` and vanished from the
ledger entirely.

### Verification (2026-07-09, pre-merge)

Root cause was **confirmed against the production Cloudflare AI Gateway route with a real Anthropic
key** before the fix shipped, rather than inferred from the counters:

| Probe | Result |
|---|---|
| `claude-sonnet-4-20250514` (what production had been sending since #21) | `HTTP 404 not_found_error — model: claude-sonnet-4-20250514` |
| `claude-sonnet-5` + `thinking:{type:'disabled'}` (what this PR ships) | `HTTP 200` |
| `analyzeWithSonnetDetailed` end-to-end on a realistic incident prompt | `outcome.kind === 'ok'`, parseable `AIAnalysisResult` (`estimatedRecovery: "1–3h"`, 134 output tokens of a 600 budget) |

One expectation did **not** hold and is recorded here so it isn't re-asserted: omitting `thinking`
did **not** truncate. On the same prompt at `max_tokens: 600`, Sonnet 5 emitted no thinking block in
either configuration (134 vs 149 output tokens, both parsed). Adaptive thinking is the model's own
per-request choice, so `thinking:{type:'disabled'}` remains the right call — it makes the output
budget deterministic on a harder incident — but it is a **guard, not a repair**.

### Two things the verification disproved

Both were plausible, both were wrong, and both are recorded so nobody re-asserts them.

**1. `thinking: {type:'disabled'}` does not fix an observed truncation.** On the same incident prompt
at `max_tokens: 600`, Sonnet 5 emitted no thinking block whether or not `thinking` was sent (134 vs
149 output tokens, both parsed). Adaptive thinking is the model's own per-request choice. Disabling
it makes the output budget deterministic on a harder incident — a guard, not a repair.

**2. Wrapping `ai.run()` does not hang it.** An intermediate revision of this fix raced the Gemma
leg's I/O promise inside a hand-rolled `new Promise(...)`, saw every inline analysis abort at the
full budget, and concluded the wrapper broke the Workers-AI subrequest. It did not. Measured against
the real binding through `wrangler dev --remote`, `env.AI.run()` latency is simply enormous and
wildly variable:

| | run 1 | run 2 | run 3 |
|---|---|---|---|
| awaited directly | 110.7s | 61.2s | >115s (timeout) |
| wrapped in `new Promise` + `.then()` | 0.76s | 0.32s | 60.5s |

The wrapped calls were *faster*. The 15s aborts were Gemma being slow, not the wrapper hanging. The
wrapper was still removed — it only bounded how long we wait, which `analyzeIncidentWithBudget`
already does one level up by racing an ordinary promise, and it left an orphaned `ai.run()` whose
eventual rejection had no handler. **Race the analysis's ordinary promise; await the Workers-AI
subrequest plainly.**

The consequence for tuning: `INLINE_ANALYSIS_BUDGET_MS` cannot be set from first principles, because
Gemma sometimes takes minutes. Some inline calls will always overrun. That is now cheap — an overrun
books `timedOut` (not `failed`), writes no re-analysis lock, and the next cron cycle retries inside
the #882 hold window. The `timedOut` counter in the daily summary is the only legitimate input to
changing that number.

Note the measurements above come from `wrangler dev --remote`, which proxies each subrequest through
a preview tunnel; production latency may be lower. That is precisely why the counter exists.
