# Twitter / X Outage-Tweet Playbook

Operator reference for [#348 Phase 1](https://github.com/bentleypark/aiwatch/issues/348) — manual tweet experiments to validate format before automation.

**Status**: Phase 1 — manual posting from a personal X account. No code, no API access required.

---

## When to tweet

Required conditions (all must hold):
1. Discord alert fired in the operator channel for a Down/Degraded/Recovery event
2. The incident already passed Worker-side **3-cycle anti-flapping** (Discord wouldn't fire otherwise — implicit)
3. The upstream service has a **status-page entry** — open the service detail page (e.g., `https://ai-watch.dev/#claude`) and confirm an active incident card is rendered. Don't tweet probe-only signals.

Operator SLA (target, not gate): tweet within **5 minutes** of the Discord ping for live news-cycle relevance. If you're more than 5 min late, still post — the GA4 attribution still works — but expect lower engagement.

Skip:
- Single probe spike with no status-page entry
- Sub-5-minute outages already resolved by the time you check
- Maintenance windows (`maintenance` aggregate state — keeps service operational)

---

## Templates

Replace `${...}` placeholders. Keep under 280 chars (X hard limit). All links carry the standard UTM (see below).

### 1. Down / Degraded
```
🔴 ${SERVICE_NAME}: ${impact} reported.
${title}
Live status → https://ai-watch.dev/is-${slug}-down?utm_source=twitter&utm_medium=manual&utm_campaign=phase1&utm_content=${incidentId}
```
- `${impact}` = `outage` | `partial outage` | `degraded performance` (match the dashboard StatusPill word)
- `${title}` = the upstream incident title. **Strict rule**: if the upstream title exceeds 80 characters, truncate to 79 + `…`. After composing the tweet in X, verify ≥ 50 characters remain in the composer's counter before posting (defense margin against URL/title interaction).

### 2. Recovery
```
🟢 ${SERVICE_NAME} recovered after ${duration}.
https://ai-watch.dev/is-${slug}-down?utm_source=twitter&utm_medium=manual&utm_campaign=phase1&utm_content=${incidentId}
```
- `${duration}` = e.g., `1h 12m` (round to nearest minute)

### 3. Early RTT signal — only when a genuine lead ≥ 10 min is shown
Rare by design (#464) — only when the dashboard surfaces an early-RTT signal; never a blanket "faster than official" claim.
```
⚡ RTT degradation on ${SERVICE_NAME} flagged by AIWatch at ${HH:MM} UTC, ${N} min before the upstream status page update.
https://ai-watch.dev/is-${slug}-down?utm_source=twitter&utm_medium=manual&utm_campaign=phase1&utm_content=${incidentId}
```
- Soft phrasing — no "we beat them" tone
- `${N}` = full minutes (no decimals)
- Skip if lead < 10 min — **why**: under 10 minutes can read as a public callout of upstream operators rather than a measurement, which carries reputational risk for AIWatch. The threshold is for tone safety, not data quality.

### 4. Cluster (≥3 services down simultaneously)
Lead tweet:
```
🔴 Multiple AI services reporting incidents right now — thread below.
https://ai-watch.dev?utm_source=twitter&utm_medium=manual&utm_campaign=phase1&utm_content=cluster-{YYYYMMDD}-{HHMM}
```
Reply tweets in thread (one per affected service):
```
${i}/${N} ${SERVICE_NAME}: ${impact}
${title}
https://ai-watch.dev/is-${slug}-down?utm_source=twitter&utm_medium=manual&utm_campaign=phase1&utm_content=${incidentId}
```
- `${title}` truncation: same rule as Template 1 (truncate to 79 + `…` if > 80 chars). Cluster replies have less room than Template 1 because of the `${i}/${N} ${SERVICE_NAME}: ${impact}` prefix — verify ≥ 40 characters remain in the composer's counter after the prefix before posting.

---

## Service slug table (29 services)

Use the slug verbatim in `/is-${slug}-down`.

| Service | Slug | Service | Slug |
|---|---|---|---|
| Claude | `claude` | DeepSeek | `deepseek` |
| OpenAI | `openai` | OpenRouter | `openrouter` |
| Gemini | `gemini` | ElevenLabs | `elevenlabs` |
| ChatGPT | `chatgpt` | AssemblyAI | `assemblyai` |
| Mistral | `mistral` | Deepgram | `deepgram` |
| Cohere | `cohere` | Hugging Face | `huggingface` |
| Groq | `groq` | Replicate | `replicate` |
| Together AI | `together` | Pinecone | `pinecone` |
| Fireworks | `fireworks` | Stability AI | `stability` |
| Perplexity | `perplexity` | Voyage AI | `voyageai` |
| xAI / Grok | `xai` | Modal | `modal` |
| Character.AI | `character-ai` | claude.ai | `claude-ai` |
| Claude Code | `claude-code` | Codex | `codex` |
| Cursor | `cursor` | GitHub Copilot | `github-copilot` |
| Windsurf | `windsurf` | | |

> Bedrock + Azure OpenAI are excluded — estimate-only, no /is-X-down page.

---

## UTM convention (locked for Phase 1)

Every link must carry these 4 params for GA4 attribution:

```
?utm_source=twitter
&utm_medium=manual
&utm_campaign=phase1
&utm_content=${incidentId}    # or cluster-{YYYYMMDD}-{HHMM} for cluster lead tweets, e.g., cluster-20260427-1830
```

- `utm_source=twitter` — required (decision-gate metric depends on this)
- `utm_medium=manual` — distinguishes Phase 1 from Phase 2 (`automated`)
- `utm_campaign=phase1` — identifies the 3-outage experiment cohort
- `utm_content` — per-incident segmentation; lets us see which outages drove the most traffic

---

## Pre-flight checklist (do once before first outage)

- [ ] Personal X account bio updated: e.g., `Tracking AI service outages → ai-watch.dev`
- [ ] Personal X account 2FA verified — TOTP or hardware key. Phase 1 experiment value is lost if the account is compromised mid-run.
- [ ] GA4 Acquisition → Traffic Acquisition → comparison filter `Session source = twitter` saved (use "Save as new comparison" so the same filter can be re-pulled at decision-gate evaluation 7 days later without rebuilding)
- [ ] Test-link ping: open `https://ai-watch.dev/is-claude-down?utm_source=twitter&utm_medium=manual&utm_campaign=phase1&utm_content=test` from a phone with private DNS, confirm GA4 DebugView shows `source=twitter, medium=manual` (Realtime "First user source" is sticky for returning users — use DebugView or Session source / medium card)
- [ ] AIWatch operator Discord channel: alert ping is enabled AND the Discord mobile app has notifications turned on for that specific channel (so the 5-minute SLA is achievable when away from desktop)
- [ ] X (Twitter) mobile app installed and logged in to the personal X account on the operator's primary phone (notifications optional)

---

## Recording sheet

Track each of the 3 outages. Compare against a baseline of 3 prior outages where no tweet was posted (same services, ideally last 60 days).

| # | Date / UTC start | Service(s) | Tweet UTC | Tweet permalink | Edited? | Impressions | Likes | RTs | Replies | t.co clicks | GA4 utm_source=twitter sessions | /is-X-down avg duration |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | | | | | | | | | | | | |
| 2 | | | | | | | | | | | | |
| 3 | | | | | | | | | | | | |

> **Tweet permalink** — capture immediately after posting (`x.com/{handle}/status/{id}`); X does not surface deleted tweets so a missing permalink at evaluation time means the row is unrecoverable.
> **Edited?** — `yes` if the tweet was deleted + reposted (typo, character overflow, etc.). Impressions/clicks split across the two posts; sessions still attribute correctly via UTM. Lets the post-mortem filter outliers.

Baseline (no tweet, prior 3 outages — pull GA4 retroactively for the same time windows):

| Date / UTC | Service(s) | Direct visits to /is-X-down | Twitter referrer (control) |
|---|---|---|---|
| | | | |
| | | | |
| | | | |

---

## Decision gate (after 3rd outage + 7 days)

Wait 7 days after the 3rd tweet for delayed clicks to settle, then evaluate:

| Outcome | Action |
|---|---|
| **GA4 `utm_source=twitter` sessions ≥ 50 across 3 outages** | Proceed to Phase 2 — verify X API tier, register dedicated bot account |
| **20–49** | Borderline — try 1–2 more outages with format tweaks before deciding |
| **< 20** | Phase 2 paused — pivot to RSS feed (#54), Discord community (#346), or Bluesky |

---

## Out of scope (do not do in Phase 1)

- Replying to other users / engaging with comments — keep it strictly broadcast
- Retweeting other accounts' AI outage tweets
- Non-outage commentary (don't dilute the feed)
- Tweeting from a brand-new account with 0 followers — Phase 1 needs the personal account's existing follower base for a non-zero impression baseline

---

## Outcome handoff

After the decision gate evaluation, append a short summary to [#348](https://github.com/bentleypark/aiwatch/issues/348):
- 3 tweet permalinks
- GA4 totals (impressions / clicks / sessions)
- Go/No-go decision with reasoning
- Format learnings for Phase 2 templates
