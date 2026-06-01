# Outage Tweet Playbook (#348 Phase 1)

**Status:** Phase 1 — manual, zero-code. Validates the format + demand before any automation (Phase 2).

AIWatch monitors *public* AI services, so an outage is a publicly-searchable event ("is openai down"). Tweeting each confirmed outage turns that event into a discoverable post that ranks for those queries and seeds organic discovery of `ai-watch.dev`. This is the one distribution lever self-hosted monitors (Uptime Kuma, etc.) structurally can't pull. See #348 for the full rationale.

> **Operator action required:** Phase 1 is run from a **personal account** (no dedicated `@aiwatch_outages` account until Phase 2). Nothing here is automated — a human posts, using the templates below, during the next 3 outages.

---

## When to tweet (guardrails — read first)

Only tweet an incident that is **already confirmed**, never a raw signal:

- ✅ **Degraded** incident: it cleared AIWatch's anti-flapping gate (**2 consecutive cron cycles, ~10 min**) **and** has a confirmed upstream status-page entry.
- ✅ **Down** incident: AIWatch alerts immediately (no multi-cycle gate, by design — high urgency), so for a Down tweet the gate is the **confirmed upstream status-page entry**, not elapsed cycles.
- ❌ Do **not** tweet on a probe spike alone (the 3-consecutive-spike probe detection feeds Detection Lead and fires **no** Discord alert), or on anything that could be an AIWatch Worker bug → ghost outage. A false-positive outage tweet is public and reputational.
- ❌ Do **not** pile on during a multi-service event — use the **Cluster** template (one thread), not N separate tweets.
- **Detection Lead tone:** soft phrasing only, and only when the lead is **≥ 10 min** — a manual editorial threshold for tweeting, **not** a code-enforced constant. Frame it as "AIWatch noticed early," never as a callout of the upstream operator.

---

## Link convention (required for measurement)

Every link points at the matching SEO page **with a UTM tag** so GA4 attributes the session:

```
https://ai-watch.dev/is-<slug>-down?utm_source=twitter
```

`<slug>` matches the `/is-<slug>-down` route (e.g. `is-openai-down`, `is-claude-down`; multi-word services hyphenate — `is-claude-code-down`, `is-character-ai-down`, `is-github-copilot-down`). GA4 captures `utm_source=twitter` automatically under **Acquisition → Traffic Acquisition** — no code needed. Drop the UTM and the experiment is unmeasurable, so it is mandatory.

---

## Templates

**Down / Degraded** (new incident):
```
🔴 {Service} is reporting {impact}: {short title}.
Live status → https://ai-watch.dev/is-{slug}-down?utm_source=twitter
```

**Recovery** (resolved):
```
🟢 {Service} recovered after {duration}.
https://ai-watch.dev/is-{slug}-down?utm_source=twitter
```

**Early RTT signal** (only when a genuine lead ≥ 10 min is shown — soft phrasing).
Rare by design (#464): most incidents don't spike the probed endpoint's RTT, and
status-page detection is bounded by polling lag — so only use this when the
dashboard actually surfaces an early-RTT signal, never as a blanket "faster" claim:
```
⚡ RTT degradation on {Service} flagged by AIWatch at {HH:MM} UTC,
~{X} min before the upstream status page update.
→ https://ai-watch.dev/is-{slug}-down?utm_source=twitter
```

**Cluster** (≥ 3 services down in the same window — one lead tweet + one reply per service):
```
Lead:  🔴 Multiple AI services are reporting incidents right now — thread 👇
       https://ai-watch.dev?utm_source=twitter
Reply: • {Service}: {impact} — https://ai-watch.dev/is-{slug}-down?utm_source=twitter
```

---

## Process per outage

1. Confirm the incident meets the guardrails above.
2. Pick the template, fill `{…}` from the dashboard / Analyze modal (impact, title, duration, Detection Lead).
3. Post from the personal account.
4. Log it in the tracking table below (date, service, tweet URL, likes/RTs at +24h).

### Tracking log

| Date (UTC) | Service | Event | Tweet URL | Likes/RTs @24h | GA4 `utm_source=twitter` sessions |
|---|---|---|---|---|---|
| | | | | | |

---

## Decision gate → Phase 2

Run the manual experiment across the **next 3 outages**, then check GA4:

- **Proceed to Phase 2 (automation)** if ≥ **50 GA4 sessions with `utm_source=twitter` landing on `/is-*-down`** across those 3 outages.
- **Otherwise** reconsider scope or pivot to an alternative channel — RSS (#54, already shipped), Discord `#alerts` (#346), or Bluesky.

Sessions (not raw clicks) because GA4 reports them natively. Record the outcome on #348 before deciding.

> **Measurement caveat — the `utm_source=twitter` count undercounts real Twitter traffic.** The `/is-*-down` pages run GA4 in **Consent Mode v2 default-denied** (`api/_shared/consent-init.ts`): gtag loads on every visit, but visitors who haven't accepted cookies are recorded as **cookieless pings with no `client_id`**, which GA4 cannot attribute to a source — they land under **`(not set)`**, not `utm_source=twitter`. So a Twitter visitor who doesn't consent leaks into the `(not set)` bucket. True Twitter traffic = `utm_source=twitter` sessions **+ an unobservable share of `(not set)`**. Read the ≥50 threshold as a *floor* (consented visitors only); if `utm_source=twitter` is near the gate, the real signal is likely above it. (The SPA at `ai-watch.dev` differs — it sends nothing until consent, so it doesn't generate `(not set)`.)

---

## Phase 2 / 3 (not now — see #348)

- **Phase 2** — dedicated account + automation in the Worker: OAuth 1.0a signer on **Web Crypto** (Cloudflare Workers have no Node `crypto`; most npm Twitter clients won't work), a `sendTweet` helper mirroring `sendDiscordAlert`, hook into the existing alert pipeline, `tweeted:{incidentId}:{event}` dedup keys, cluster batching, 5-tweets/hr cap. **Re-verify X API tier/pricing at implementation time** — it changes often.
- **Phase 3** — `Tweet this status` button on `/is-*-down`, verify Twitter Card meta, scheduled daily-reliability post.
