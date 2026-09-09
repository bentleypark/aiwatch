---
type: reference
title: "Bluesky outage-chatter measurement — access path and gotchas (#1374)"
description: "How to count 'is X down' posts on Bluesky per day: app-password auth, which appview host actually serves searchPosts, and the 2026-09-09 baseline the next reading compares against."
tags: [marketing, measurement, bluesky, atproto, cli]
---

# Bluesky outage-chatter measurement

A 2026-07-23 channel survey listed Bluesky as a low-cost candidate but left its central question
open — whether "is X down" talk actually clusters there during an outage was **inferred, not
measured**. It is measurable, and `scripts/bsky-outage-chatter.mjs` is the tool.

This page exists because the access path has failures that **present as authentication problems and
are not**. Each costs about an hour to rediscover.

## The three gotchas

### 1. `public.api.bsky.app` edge-blocks `searchPosts`, even with a valid token

This is the one that misleads, because the same host answers other endpoints fine.

| host | `app.bsky.feed.searchPosts` (valid token) |
|---|---|
| `public.api.bsky.app` | **403**, HTML body |
| `api.bsky.app` | 200 |
| `bsky.social` | 200 |

On `public.api.bsky.app`, `com.atproto.identity.resolveHandle` and `app.bsky.actor.getProfile` both
answer **200 unauthenticated** — so the 403 looks endpoint-specific in a way that suggests auth.

A browser `User-Agent` changes nothing on any of the three hosts, so it is not UA filtering.
`scripts/bsky-outage-chatter.mjs` defaults to `api.bsky.app`.

**Do not try to infer the cause from the response shape.** An HTML body looks like it should mean
"edge block, wrong host", but `api.bsky.app` — the host that works — also answers `403 text/html`
when the `Authorization` header is absent, while `bsky.social` answers `401 application/json` for
the same request. The shape depends on the host AND the credential state, so any rule mapping one to
the other has to be re-verified against every combination. The script reports the status, the
content-type and a body excerpt, and asserts nothing about the cause.

*(Verified 2026-09-09 across all three hosts, with and without a browser User-Agent.)*

### 2. `docs.bsky.app` 301s to `bsky.network`

A fetcher that does not follow redirects sees a 0-byte 301 and reads it as missing documentation.
Following it does not reliably help either: `curl -sL` on a deep docs path lands on a 316-byte
meta-refresh stub with no readable text. Read the source instead:
[`bluesky-social/bsky-docs`](https://github.com/bluesky-social/bsky-docs) for the guides,
[`bluesky-social/atproto`](https://github.com/bluesky-social/atproto/tree/main/lexicons) for the
lexicons.

### 3. A bare username fails exactly like a wrong password

`com.atproto.server.createSession` takes `identifier` as a **full handle** (`name.bsky.social`), an
email, or a DID. A bare username returns the same `401 AuthenticationRequired / Invalid identifier or
password` as a bad credential, so the two are indistinguishable from the response. The script rejects
that shape before the request rather than after.

To check whether a handle exists at all, without credentials:

```bash
curl -s "https://public.api.bsky.app/xrpc/com.atproto.identity.resolveHandle?handle=NAME.bsky.social"
# {"did":"did:plc:..."} = exists · {"error":"InvalidRequest"} = no such handle
```

## Credentials

An **app password** — Bluesky Settings → Privacy and Security → App Passwords. Never the account
password: an app password is individually revocable and cannot change the account's email or
password. The measurement is **read-only and never posts**.

Keep it wherever this machine keeps local secrets, never committed. The inline form below puts it
in shell history, so treat the app password as disposable: revoke it in Bluesky Settings when the
measurement is done — that revocability is why it is used here instead of the account password.

There is **no developer portal, no review queue, and no paid tier** — an account is enough.

## Usage

```bash
BSKY_IDENTIFIER=you.bsky.social BSKY_APP_PASSWORD=xxxx-xxxx-xxxx-xxxx \
  node scripts/bsky-outage-chatter.mjs --start 2026-09-01 --end 2026-09-09
```

Pass them inline, as above. Two tempting one-liners were tested and neither is safe:

- `export $(grep … | xargs)` — when the file is missing, the cwd is wrong, or the vars are not there
  yet, the substitution expands to nothing and the line becomes a bare `export`, which in `zsh`
  prints **every exported variable as `NAME=value`** (73 lines when reproduced), every other secret
  in that shell included. The script then exits with an ordinary "set BSKY_IDENTIFIER…" message, so
  the dump reads as noise rather than as the leak it is.
- `set -a; . <(grep …); set +a` — works in `zsh`, but under macOS's system `bash` 3.2 it sets
  nothing, silently and with exit status 0, leaving the same ordinary-looking missing-variable error.

Flags: `--start` / `--end` (inclusive UTC dates, default the 9 days ending today), `--queries`
(comma-separated, default five), `--appview`, `--json`.

## Rate limits

Writes are points-based — `CREATE` 3 points against **5,000/hour** and **35,000/day**, per
[the rate-limits doc](https://github.com/bluesky-social/bsky-docs/blob/main/docs/advanced-guides/rate-limits.md).
That source's AppView section gives no numbers — it says only that those services have "generous
rate-limits" (the IP-based figures in the same document are under the PDS section, which is a
different path than this script's reads take). Nothing there binds a measurement of this size; the
script paces itself anyway and backs off on 429.

## How to read the output — and what it does not say

**The counts are a lower bound over the chosen query strings.** They measure the queries, not the
conversation. Real phrasings the default five miss (`"claude is being weird"`, `"anyone else getting
529"`) are invisible. So a **low** number means *"not caught by these queries"*, never *"does not
cluster"*. Nothing here establishes the other direction: whether a keyword match is genuine outage
chatter is not checked, and the lexicon says `q` syntax is unspecified, so the count is not a floor
on the conversation either.

**There is a second, independent lower bound: the pagination cap.** A query-day is counted up to
`cap` (1,000 by default) and then stops. A capped cell renders with a trailing `+` (`1000+`), and so
does any column total containing one — without that marker two capped readings would compare as "no
change" when one could be several times the other, which is exactly what keeping a baseline as a
control is meant to prevent. The 2026-09-03 peak below reached 456, within about 2× of the ceiling,
so a larger outage can reach it.

**The instrument check is part of the method.** The script first runs a generic query over one hour
and refuses to continue if it returns nothing. Without that, an empty result and a broken search are
byte-identical — and since a low number is a reportable finding here, it has to be distinguishable
from a dead instrument before any of it is trustworthy.

**Set the series beside AIWatch's own outage-day axis**, `incidentsStartedInWindow` in
`growth:daily:{YYYY-MM}` (`docs/reference/kv-schema.md`). Note that a row dated D covers
D−1 09:00 → D 09:00 UTC, so it is offset from a calendar day — good for comparing shape, not for a
per-day join.

## Baseline — 2026-09-09

Nine days spanning the 2026-09-03 multi-provider outage (Anthropic, xAI/Grok, Cursor, OpenAI). Kept
here so a later reading has a control rather than a bare number.

```
query                   09-01  09-02  09-03  09-04  09-05  09-06  09-07  09-08  09-09
claude down                25     28    421     92     25     19     31     30      7
chatgpt down               12     14    456     98     32     18     19     29      5
openai down                13     24    141    114     61     28     30     50     16
cursor down                12      9     20      2      1      5      2      2      1
anthropic outage            1      4     27     16      2      0      3      3      1
TOTAL                      63     79   1065    322    121     70     85    114     30
AIWatch incidents          14     20     21     26     21      2      2      4      -
```

The `AIWatch incidents` row is `incidentsStartedInWindow` from `growth:daily:2026-09` — **not**
`alertedIncidents`, which `docs/reference/kv-schema.md` documents as a different quantity in the
same key, with the measured difference stated there.

Instrument check: `192+ posts` for a generic query over one hour of 09-05 — the `+` because the
probe's own cap is 100, a page returns fewer than `limit`, and the loop adds a whole page before
testing the cap, so the count overshoots. Page size varies request to request; do not treat it as a
constant. 09-09 is a partial day and still accruing.

**The 09-03 column is the outage day.** Compare columns directly off the table — every
restatement of that comparison written on this page has been wrong (a range twice, a
multiplier twice), so there is deliberately none here.

**What this does not establish:** whether those posts are in a form we could usefully answer — how
many distinct threads, how many are questions rather than venting, whether replies get read. The
count answers "do people gather here", nothing further.
