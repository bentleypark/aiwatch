---
type: reference
title: "GA4 CLI access — querying reports without the dashboard (#998)"
description: "How to query the AIWatch GA4 property's reports from the command line via a service account + the Data API — setup already done, what's still missing, and the reusable script."
tags: [analytics, ga4, cli, tooling]
---

# GA4 CLI access — querying reports without the dashboard

There is **no official "GA4 CLI"**. `gcloud` is a general Google Cloud CLI and has no GA4-reporting
subcommand. What follows is the closest equivalent: a service account + the [Google Analytics Data
API](https://developers.google.com/analytics/devguides/reporting/data/v1) (`runReport`), driven by
`scripts/ga4-report.mjs`. Born out of **#998**'s verify-after, whose own body says the required
measurement (a GA4 Hostname report) "is not an AIWatch JSON endpoint" and therefore can't have a
Tier-A `assert:` — this makes it scriptable, though still not CI-assertable (it needs a live service
account, not something CI should hold).

## What's already provisioned

- **Service account**: `ga4-reporter@aiwatch-ga4-10072.iam.gserviceaccount.com`, in GCP project
  `aiwatch-ga4-10072`. Its key lives at
  `~/.config/gcloud/legacy_credentials/ga4-reporter@aiwatch-ga4-10072.iam.gserviceaccount.com/adc.json`
  on the machine this was set up on — **local-only, never committed**, same discipline as
  `worker/.dev.vars`. If that path doesn't exist on a different machine, this tooling doesn't work
  there until the key is placed there (or `--key` points elsewhere).
- **GA4 property access**: the service account has **Viewer** access on the AIWatch GA4 property,
  granted via GA4 Admin → Property Access Management. Without this, every API call 200s but every
  report comes back with zero rows — that empty-but-200 response is what "no property access yet"
  looks like, not an error.
- **Property identity**: account `145080382` ("p2c2kbf") → property `529375750` ("AIWatch",
  `propertyType: PROPERTY_TYPE_ORDINARY`). This is the numeric property ID the Data API needs —
  distinct from the Measurement ID (`G-D4ZWVHQ7JK`) used everywhere else in this codebase
  (`docs/reference/ga4-events.md`). `scripts/ga4-report.mjs` defaults to it.

## Usage

```bash
# Default: sessions by hostname, last 30 days — "how much non-production traffic hit prod GA4"
node scripts/ga4-report.mjs

# #998's actual check: hostname × the Testing-filter dimension, since #999
node scripts/ga4-report.mjs --dimensions hostName,testDataFilterName --metrics sessions,screenPageViews --start 2026-07-14 --end today

# Per-day breakdown, to see whether pollution is a steady drip or a few bad sessions — raise --limit
# above the 50 default for a multi-week range, since runReport orders by the first metric descending
# and a truncated table silently drops the LOW-count days first (the "steady drip" signal)
node scripts/ga4-report.mjs --dimensions date,hostName --metrics sessions --start 2026-07-14 --end today --limit 200

# Event-level check, e.g. re-running the 2026-07-15 outage-CTA-channel decision's CTA read over ITS
# OWN window (2026-06-18 → 2026-07-15 — a fresh window gives different numbers, see below): which
# is-down button gets used (copy_slack_feed / copy_rss / click_cta_alerts, see
# api/_is-down/html-template.ts). No --filter flag exists, so scope with a second dimension and read
# the relevant rows off the table — an unscoped global total is not comparable to the baseline here
# (property-wide copy_rss matches exactly, 24 vs 24 — that's the scoping lesson this reproduces).
# **The is-down-scoped digits do NOT reproduce exactly**: the decision page recorded 13+5=18 vs 1
# (18:1); re-running this same command on 2026-08-13 got 14+6=20 vs 1 (20:1) — close, not identical,
# most likely GA4 processing/attribution drift between the original pull and the re-run, not a bug in
# this command. Treat the ratio and the scoping lesson as what's reproducible, not the exact digits.
# The target rows are typically the LOW end of the count (click_cta_alerts was 1) — raise --limit and
# check formatTable's "(showing N of M rows)" line; a truncated read silently drops exactly these rows
# first (runReport orders by the first metric descending; 103 rows returned for this query on
# 2026-08-13, so the default --limit 50 would have truncated it).
node scripts/ga4-report.mjs --dimensions eventName,pagePath --metrics eventCount --start 2026-06-18 --end 2026-07-15 --limit 300

# Raw API response instead of a table
node scripts/ga4-report.mjs --json
```

Any [GA4 Data API dimension/metric `apiName`](https://developers.google.com/analytics/devguides/reporting/data/v1/api-schema)
works — the property's actual available names are queryable at
`GET https://analyticsdata.googleapis.com/v1beta/properties/{id}/metadata` (same auth) if a name is
unclear or property-specific (custom dimensions, `testDataFilterName`/`testDataFilterId`, etc.).

## `growth:daily` — a different data source, for a different question

`growth:daily` (KV) is **not** queryable through this CLI or GA4 — it's AIWatch's own consent-free
pipeline: an `audienceBeaconScript` beacon on the **is-down pages only**
(`api/_is-down/html-template.ts`, `api/is-down-group.ts` — no other surface emits it) posts
cross-origin to the worker's `/api/pageview`, `worker/src/outage-audience.ts`'s `classifyReferrer()` buckets each view by
referrer/UTM (`direct`/`reddit`/`hn`/…) into Analytics Engine, and `worker/src/growth-series.ts` rolls
that up into **one `growth:daily:{YYYY-MM}` KV key per month, holding one row per day** — not one key
per day. Each row carries `audienceBySource` (the channel-mix field) alongside `subscribers`,
`referralTotal`, `audienceActiveTotal` (the sponsor-evidence axis), and `incidentsStartedInWindow` — it
isn't only channel mix. Read it directly:

```bash
npx wrangler kv key get "growth:daily:$(date -u +%Y-%m)" --namespace-id e49508d80bb144e9a7ff872f2be771a4 --remote
```

**`--remote` is required.** Omit it and wrangler reads local Miniflare state instead of production:
`Value not found`, exit code 0, no error — or a stale value if a `wrangler dev` session left local
state behind. Seeing `Value not found` here means a missing `--remote` far more often than a missing
key.

**Verified 2026-08-13 to actually work** — both this command and the GA4 CLI example above were run
for real, not just read. One false trail worth recording: a first attempt at this exact command 401'd,
and simply re-running it — same token, same namespace, no changes — succeeded immediately.
`wrangler kv key list` on the same namespace had worked throughout, and `wrangler whoami` showed
`workers_kv (write)` (wrangler's only KV scope; there's no separate read scope to be missing). The
cause of that single 401 was never isolated. **Retry once before diagnosing a 401 here as a
permissions gap.**

**GA4 and `growth:daily` answer different questions and must not be swapped.** `growth:daily` is
**where is-down-page traffic came from** (referrer/UTM channel mix) — this is what
`initiative_growth`'s `direct`/`reddit`/`hn` numbers already cite, and it covers is-down views only,
not the whole site. GA4 *can* also report source dimensions (`sessionSource`,
`sessionDefaultChannelGroup` — it isn't incapable of this), but on the is-down surface its sample is
far smaller than the beacon's (measured 2026-08-13: GA4 `page_view` on `-down` paths over
2026-08-01→08-12 was **69**; the beacon's `audienceTotal` over the same 12 days was **1806**) and the
mechanism behind that gap has not been isolated — don't assume a cause. Neither side is a clean
population either: GA4 drops traffic it classifies as bots, and the beacon (`recordOutageView` in
`worker/src/outage-audience.ts`) does no bot filtering at all, so a GA4 number and a `growth:daily`
number are not comparable in either direction. Use GA4 for what `growth:daily` can't answer instead:
**what a visitor did on a page** (which button they clicked, per-event counts) — the question behind
the `eventName`/`pagePath` example above.

## What this can't do — and why

**Read-only is a real ceiling, not a "not implemented yet."** `runReport` only queries. Writing GA4
config — creating/editing a Data Filter, defining an Internal Traffic Rule's IP list, changing a
filter's state (Testing/Active/Inactive) — has **no API surface at all**. Checked 2026-08-13 against
the live discovery document (`https://analyticsadmin.googleapis.com/$discovery/rest?version=v1alpha`,
the broadest version GA4's Admin API shipped as of that check) — an external, evolving surface owned
by Google, not something this repo controls: neither `internalTrafficRules` nor `dataFilters` appeared
as a resource in it. As of that check, these are GA4 Console-only settings — re-run the same
discovery-doc fetch before assuming this is still true; don't build a write path on faith alone. Point
the user at GA4 Admin → Data Filters in the meantime.

## Known gap as of 2026-08-13 (context for #998)

Everything in this section is a snapshot, not a live fact — re-run the commands below for current
numbers/state before relying on anything here past the date in the heading.

An Internal Traffic **Data Filter** already exists on the property and is in **Testing** state — but
its underlying **Internal Traffic Rule has no IP address registered**. Confirmed by querying
`testDataFilterName` alongside `hostName`: every row (including real `ai-watch.dev` production
traffic) comes back `(not set)`, meaning the filter currently evaluates against zero traffic. Testing
state with an empty IP rule is a no-op, not a lighter version of Active — nothing gets tagged until an
IP (or CIDR range, for a non-static connection) is added under the data stream's "Define internal
traffic" setting, which is also GA4 Console-only (see above). This could change independently of any
code change in this repo (e.g. someone adds the IP in the console) — re-check with the
`testDataFilterName` query above rather than assuming this is still the state.

Measured **2026-07-14 → 2026-08-13** (a clean window starting the day after #999 landed, queried on
2026-08-13 — re-run for current numbers): `ai-watch.dev` 236 sessions vs. `localhost` **141** sessions
— a ~37% contamination rate, concentrated on a handful of specific days (`07-15`: 4, `07-18`: 26,
`07-26`: 1, `07-31`: 59, `08-04`: 51) rather than a steady drip (re-verified with `--limit 200`, well
above the default 50, to rule out the per-day breakdown itself having been silently truncated — the
shape held). That shape reads as a few local/MCP screen-check sessions where consent got granted by
mistake, not a systemic remaining code gap — see `docs/reference/ga4-events.md`'s #998 section for the
cookieless-Edge-ping gap this was originally measuring, which is a separate, smaller concern from this
session-level leakage.

## Security

The service account key is a real credential — same handling as any other secret in this repo:
never commit it, never paste its contents into a prompt, `chmod 600` on disk (already true). The
script reads it from disk at call time and only ever requests the `analytics.readonly` scope (hardcoded
in `scripts/ga4-report.mjs` — it cannot write, even if a future call site tried).
