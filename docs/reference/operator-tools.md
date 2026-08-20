---
type: runbook
title: "Operator Tools — `POST /api/admin/analyze` (#299)"
description: "Operator runbook for POST /api/admin/analyze — force a Sonnet re-analysis on an active incident; secret setup, flags, request/response, failure codes, security posture."
tags: [worker, operator, admin]
---

# Operator Tools — `POST /api/admin/analyze` (#299)

Force a Sonnet analysis on a specific active incident when the cron's default (Gemma-first) produced low-signal output. Motivated by the 2026-04-20 ChatGPT outage where Gemma called a systemic infra failure a "service availability issue". Before this endpoint the override required hand-editing a local Node script + `wrangler kv key put --remote`.

```bash
# One-time secret setup (do NOT commit the value anywhere)
npx wrangler secret put ADMIN_API_KEY --config worker/wrangler.toml

# During an outage — helper script parses CLI args, handles UA / error hints,
# and avoids the shell-quoting pitfalls of raw curl.
export ADMIN_API_KEY=...  # paste locally from 1Password / keychain
node scripts/admin-analyze.mjs chatgpt 01KPNN2V2SMP3TAN3MCJK87W50
# Optional flags:
#   --model gemma         (default: sonnet — manual trigger implies escalation)
#   --sticky false        (default: true — prevents cron from re-analyzing with Gemma)
# See scripts/admin-analyze.mjs header for full usage + error-code hints.

# Or raw curl (same endpoint — use --data @file to avoid zsh brace-expansion issues):
# curl -X POST https://aiwatch-worker.p2c2kbf.workers.dev/api/admin/analyze \
#   -H "X-Admin-Key: $ADMIN_API_KEY" -H "Content-Type: application/json" \
#   --data '{"svcId":"chatgpt","incidentId":"01KPNN2V2SMP3TAN3MCJK87W50"}'
```

**Request body** (JSON): `svcId` (required), `incidentId` (required, must be an active incident present in `services:latest`), `model` (`'sonnet' | 'gemma'`, default `'sonnet'`), `sticky` (default `true` — cron skips re-analysis until the incident resolves).

**Response**: `{ ok: true, wrote, ttl, analysis }` on 200. Failure modes: 401 `unauthorized` (missing/wrong `X-Admin-Key` — never leaks whether the secret is even configured), 400 (malformed body), 404 (IDs don't match an active incident — scope guard against arbitrary KV writes), 429 (1-req-per-60s-per-incident rate limit via `admin:ratelimit:{hash}`), 502 (upstream model failure or unparseable response), 503 (`ANTHROPIC_API_KEY` not configured).

**#955 — a 502 now says WHY.** The operator reaches for this endpoint precisely when the automated path is broken, so a bare `"analysis returned null"` was the worst possible answer: it's the same ambiguity that let a retired model id 404 for weeks. The 502 body now carries `kind` (`permanent` / `transient` / `aborted` / `unknown`) and, on the `model=sonnet` path, the upstream `status` + a 300-char `detail` from the Anthropic error body — so a retired-model 404 (`kind: "permanent"`, fix the model id) is immediately distinguishable from a 529 overload (`kind: "transient"`, just retry). A failed manual analysis is also booked into `ai:usage` now (it used to increment the counter only on success, under-reporting exactly the failures the counter exists to surface).

**Security posture**: the endpoint accepts only IDs that match an active incident in `services:latest`, so a leaked secret can't be used to write arbitrary `ai:analysis:*` keys. Per-incident rate limit bounds damage to ~1 Sonnet call per incident per minute ≈ $0.01-level cost. Rotate `ADMIN_API_KEY` independently of `ANTHROPIC_API_KEY` if ever suspected compromised. Never paste the secret value into issues, PR bodies, or commit messages — only the variable name `$ADMIN_API_KEY` should appear in docs.

---

# Operator Tools — `GET/POST /api/admin/suppress` (#904)

Hide a **correctly-attributed** incident from the live list, the Score, the monthly accumulator, and
rebuilt archives — **no deploy, reversible**. This is for the recurring "an incident surfaced, then for
some (policy/operational) reason must be un-exposed" case (e.g. OpenAI's FedRAMP "degraded performance",
which is gov-compliance-scoped, not general-API availability). It is a SEPARATE layer from
`incidentExclude` (which is compile-time **source attribution** — "this belongs to another service");
suppression says "this IS ours but hide it". See [status-determination.md](status-determination.md).

Two entry scopes:
- **`incident`** — hide ONE specific incident by id (ad-hoc one-off). `{ scope:'incident', incId }`.
- **`service-pattern`** — hide any incident on a service whose title contains `match` (recurring surface;
  a runtime-editable `incidentExclude`). `{ scope:'service-pattern', svcId, match }`.

```bash
# List current suppressions
ADMIN_API_KEY=... node scripts/suppress-incident.mjs list

# FedRAMP first use — recurring surface, so a service-pattern (covers all future FedRAMP incidents):
ADMIN_API_KEY=... node scripts/suppress-incident.mjs add --scope service-pattern \
  --svc openai --match fedramp --reason "gov-compliance scope, not general-API availability"

# Hide one specific incident by id:
ADMIN_API_KEY=... node scripts/suppress-incident.mjs add --scope incident --incId 01ABC... --reason "..."

# Un-hide (restore) — same flags as the matching add:
ADMIN_API_KEY=... node scripts/suppress-incident.mjs remove --scope service-pattern --svc openai --match fedramp
```

**Where it applies** (all read the single `incident:suppressions` KV key): (1) `fetchAllServices` return —
covers the live `/api/status` list, `scoreFor`, the go-forward `accumulateMonthlyIncidents`, and the
`services:latest` cache in one shot; (2) `buildMonthlyArchive` **build-time** — so a
`POST /api/admin/rebuild-archive` of a PAST month drops the suppressed incident + recomputes
count/downtime/longest from survivors, **without deleting the accumulator KV** (rebuild-safe). The badge
is unaffected (suppression runs after status determination — it only removes the incident from the LIST +
Score inputs).

**After adding a suppression for a past month**, run `POST /api/admin/rebuild-archive` for that month so the
archive + dashboard 90-day history reflect it. (The CURRENT month's 90-day view + weekly briefing filter the
raw accumulator live — no rebuild needed there.) The rebuild reads the suppression list, so this shrink is
expected and passes the guard below without a `force`.

### The rebuild refuses when it would hold less than what is stored (#1260)

`archive:monthly:{YYYY-MM}` has no TTL because nothing else holds a month's per-service figures — but every
source the rebuild reads *does* expire: `history:` at 90 days, `incidents:` / `security:` /
`probe-degradation:` at **60**. So a rebuild of an older month can produce an archive that is strictly worse
than the one it replaces, and before #1260 it wrote it and answered `200`.

The endpoint now builds first (the build performs no writes), compares the result against the stored
archive, and answers:

| | when |
|---|---|
| **`503` `retryable:true`** | one of the three reads taken BEFORE the build failed — the stored archive, `services:latest`, or the suppression list. Retry; `force` does not override these. A fault in the month's own sources is NOT distinguished from expiry (the helpers below the build swallow their own reads), so it lands in the `409` below. |
| **`500` `retryable:false`** | the suppression list is present but malformed. Retrying never clears it — repair the KV value by hand. |
| **`409`** | the rebuild measurably holds less than what is stored — `regressed` names what, alongside `prior` and `rebuilt`. Incidents the suppression list accounts for are NOT a loss, so the suppress-then-rebuild flow above passes without a `force`. |
| **`409`** | the stored archive is unparseable, so the comparison could not be made at all. |
| **`400`** | the month is not a real calendar month, or has not happened yet. |
| **`200`** | otherwise — including a first-ever build of an old month, where nothing is stored and so nothing can be lost. |

`{"force": true}` overrides the `409`s. **Every** overwrite of an existing archive — forced or not —
first copies the prior bytes to `archive:monthly:{period}:prev:{ts}` (90d) and is refused outright if
that copy fails. The comparison counts presence rather than value (it cannot see a real 99.97%
replaced by a computed 100%), so the copy, not the comparison, is what makes a mistake recoverable.
A forced overwrite also returns `forcedOver` / `priorUnreadable` and logs what it lost. The `409` states
no cause on purpose: this endpoint cannot tell an aged-out key from a KV blip, and guessing points at
`force` when a retry would have done.

**Caveats:**
- **Effect latency**: the live `/api/status` reflects a new suppression within ≤60s (isolate cache); the
  cached `/api/status/cached` and OG/SEO readers reflect it only after the next `services:latest` write
  (≤~5 min, next cron cycle). Don't re-issue the command expecting instant effect on cached surfaces.
- **Rebuilt-archive browser cache (#908)**: after `rebuild-archive`, the dashboard's archived-incident
  view (`/api/report`) served a client's PRE-rebuild copy stale for up to 24h (the old `max-age=86400`).
  Now the archive emits a weak ETag + `max-age=300`, so a client that had cached the month revalidates
  and re-fetches within ~5 min of the rebuild. It does NOT retroactively refresh a browser that cached
  the response under the OLD 24h `max-age` (pre-#908 entries clear on their own expiry / a hard reload);
  the fix bounds the window for FUTURE rebuilds. Live `/api/status` is real-time and unaffected either way.
- **Status pill vs list (general mechanism)**: suppression removes the incident from the LIST + Score but
  does NOT change the service's `status`. For FedRAMP this is fine (the `openai` badge is already scoped by
  #741 → operational). But suppressing an incident that DROVE a `degraded`/`down` status would leave the
  service showing a non-operational pill with an empty incident list — prefer fixing the attribution/badge
  scoping for that case rather than suppressing.

**Request body** (POST, JSON): `action` (`'add' | 'remove'`), `scope` (`'incident' | 'service-pattern'`),
plus `incId` (incident scope) or `svcId` + `match` (service-pattern scope), optional `reason`. **Response**:
`{ ok, changed, suppressions }` on 200; `add` is idempotent (`changed:false` on a duplicate target).
Failure modes: 401 `unauthorized`, 400 (missing/invalid scope or fields), 502 (KV read/write failed),
503 (`STATUS_CACHE` unavailable). Auth reuses `X-Admin-Key` / `ADMIN_API_KEY`. The isolate caches the list
for 60s (a write invalidates its own isolate immediately; others converge within ≤60s).

# Operator Tools — `GET/POST /api/admin/duration-override` (#1019)

**Sibling of suppress, different verb.** Suppress HIDES an incident; a duration override KEEPS it but
PINS its `duration` to an operator-stated value. Use it when a provider left an incident open long AFTER
the affected component recovered, so the paperwork `duration` (`resolved_at − created_at`) overstates real
impact — inflating MTTR/Recovery and the monthly report's `longestIncidentMin`/`totalDowntimeMin`.
Reference case: Cursor `h71m65my586h` (2026-07-14) reads 13h 20m; the component actually recovered in
~18 min (sibling `96m8j04k15r5` resolved in 18 min). See [status-determination.md](status-determination.md).

```bash
# List current overrides
curl -s https://<worker>/api/admin/duration-override -H "X-Admin-Key: $ADMIN_API_KEY"

# Pin an incident's duration (minutes). Re-adding the same id UPDATES its value (a correction, not idempotent):
curl -s -X POST https://<worker>/api/admin/duration-override -H "X-Admin-Key: $ADMIN_API_KEY" \
  -d '{"action":"add","id":"h71m65my586h","durationMin":18,"reason":"provider left incident open ~13h after IDE recovered; real window ~18m (sibling Sol)"}'

# Remove (restore the provider duration):
curl -s -X POST https://<worker>/api/admin/duration-override -H "X-Admin-Key: $ADMIN_API_KEY" \
  -d '{"action":"remove","id":"h71m65my586h"}'
```

**Where it applies** (all read the single `incident:duration-overrides` KV key, each right after
suppression): `buildMonthlyArchive` build-time (rebuild-safe — run `POST /api/admin/rebuild-archive` for a
past month), the `/api/report` current-month partial (dashboard 30/90-day list), and the weekly briefing.
It recomputes `totalMinutes`/`longestMinutes` from the `durations` map, updates `incidents[].durationMin`,
and (for a resolved entry) sets `incidents[].resolvedAt = startedAt + durationMin` so the grouped-incident
row + Uptime calendar span agree. It also lands in the calendar-month `monthlyScore` (#993) — its MTTR
reads the same durations — so the report's Score/ranking is corrected too, not just the display stats.

**Caveats:**
- **Applied on READ/BUILD, never by editing the accumulator** — `accumulateMonthlyIncidents`'s monotonic
  `if (dur > oldDur)` guard would re-inflate a raw KV edit on the next cron while the incident is still in
  the live feed. So a plain `wrangler kv put` correction does NOT stick; use this endpoint.
- **Current-month dashboard lag**: for a still-live current-month incident, the live `/api/status` value
  wins in `mergeArchiveIntoMap`, so the corrected duration shows on the dashboard only once the incident
  ages out of the upstream feed. The permanent archive (built on the 1st) is unaffected.
- **Live Score not overridden**: MTTR/Recovery on `/api/status` still uses the provider duration (median is
  robust at ≥3 resolved incidents). General MTTR robustness is #1019 Part B.

**Request body** (POST, JSON): `action` (`'add' | 'remove'`), `id`, `durationMin` (add only, finite ≥ 0),
optional `reason`. **Response**: `{ ok, changed, overrides }` on 200. Failure modes mirror suppress
(401/400/502/503). No isolate cache (the apply sites read fresh).

# Operator Tools — `GET /api/admin/withdrawals` (#1106 Part 5)

**Read-only, unlike its siblings above.** Suppress and duration-override are controls; this is a
*record*. It answers the one question #1106 left open after Parts 1–4 shipped: **did the ⚪ withdrawal
path ever actually fire in production, and did every announced thread get closed?**

That question was unanswerable before, and not for want of logging. A withdrawal leaves
`incidents:withdrawn` (48h), `alerted:wd:{incId}` (7d), `alert:feed:recent` (2h) and Workers Logs
(~3d) — and the accumulator row is gone by definition, since its prune is what starts the sequence.
Past a week there was nothing left to read, while the event itself is **unschedulable** (it needs a
provider to delete an announced incident), so a `verify-after` date would have fired on an absence.

```bash
# This month
curl -s "https://<worker>/api/admin/withdrawals" -H "X-Admin-Key: $ADMIN_API_KEY"

# A specific month
curl -s "https://<worker>/api/admin/withdrawals?month=2026-07" -H "X-Admin-Key: $ADMIN_API_KEY"

# "Did this EVER fire?" — walk back N months (1-24) in one call
curl -s "https://<worker>/api/admin/withdrawals?months=12" -H "X-Admin-Key: $ADMIN_API_KEY"
```

**Reading the answer.** Every row is one provider-deleted incident:

| Field | Means |
|---|---|
| `announced` | The ⚪ notice was accepted by Discord — the thread was closed. Working as designed |
| `pending` | Not announced YET, and still inside the tombstone's 48h. Normally a `withdrawalHold` (the provider re-published the id, an incident is still running, or the status source was unreadable) — benign, re-evaluated every 5 min |
| `neverClosed` | **#1106 recurring.** No operator ⚪ notice went out, and `prunedAt` is older than 48h, so the tombstone it would render from is gone and nothing can send it now. Scoped to the OPERATOR webhook (see below) — subscribers may still have received it |
| `malformedTimestamp` | An un-announced row whose `prunedAt` is unparseable, so it cannot be aged — counted apart rather than sitting in `pending` forever |
| `partial` / `ok` | `partial: true` (and `ok: false`) means the counts are computed over LESS than the requested range — some month could not be opened, or some rows failed the shape check. Branch on `ok`; the rows are still returned |
| `unreadableMonths` | Months whose KV value could not be read at all |
| `malformedByMonth` | Rows excluded by the shape check, per month — that month's key is the one to repair |

These four buckets partition `count`: `announced + pending + neverClosed + malformedTimestamp === count`.

A `neverClosed > 0` is the signal to investigate — pair it with the cron's own
`[cron] #1106 withdrawal notice held — <reason>` lines if they are still inside the Workers Logs window.

`announced` means Discord accepted the **operator** ⚪ message: the stamp is written after that send
and gated on its result, so a rejected send leaves the row un-announced and logs `⚪ withdrawal notice
FAILED to send to the OPERATOR webhook and will never retry`. That is the only dispatch whose result
is known at the stamp point — the #486 per-user relay and the `alert:feed` projection fan out after
the send loop, so a `neverClosed` row can coexist with subscribers who *did* get the notice. The
error direction is the safe one (it over-reports a failure, loudly), but read the bucket as "no
operator notice went out", not "nobody was told".

**Failure modes:** 401 `unauthorized` (no/incorrect `X-Admin-Key`), 400 (`month` not `YYYY-MM` with a
real 01-12 month, or `months` outside 1-24), 503 (`STATUS_CACHE` unavailable), 502 when **every** month
in the range is unreadable. That 502 is deliberate and is **not transient**: both writers refuse to
start from `[]` (an empty start would republish the month and erase its history), so a corrupt value
freezes that month permanently — no further withdrawal is recorded in it until the KV value is
repaired or deleted by hand. There is no POST: nothing an operator could edit here would be anything
but a falsified history.
