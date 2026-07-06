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
raw accumulator live — no rebuild needed there.)

**Caveats:**
- **Effect latency**: the live `/api/status` reflects a new suppression within ≤60s (isolate cache); the
  cached `/api/status/cached` and OG/SEO readers reflect it only after the next `services:latest` write
  (≤~5 min, next cron cycle). Don't re-issue the command expecting instant effect on cached surfaces.
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
