# Marketing Playbook

Operational reference for opportunistic, organic distribution of AIWatch during major AI outages. Two channels, one rule: **be useful first, the link is incidental.**

- [Show HN](#show-hn)
- [Reddit](#reddit)
- [Shared rules](#shared-rules)

**Not covered here:** journalist outreach (Casey Newton, Hard Fork, AI beat reporters). That channel requires verified statistics (90-day Detection Lead average, per-service audit) and a permanent embeddable URL — tracked separately in issue #266 (`/press` page). Once `/press` ships, a third section will be added here for journalist DM/email flow.

---

## Show HN

AIWatch's stack (Cloudflare Workers + KV + Workers AI binding, hybrid Gemma 4 / Claude Sonnet analysis, open source) is HN-native. Timing matters more than copy — a Show HN posted within 1-2 hours of a major AI outage rides existing topical interest. The same post on a quiet day sinks.

### Trigger criteria

Post only when **at least one** of these is true:

- A Tier 1 service (`claude`, `openai`, `gemini`) has `status === 'down'` for 30+ minutes, verified via AIWatch dashboard.
- A current outage is being covered by TechRadar, The Verge, Bloomberg, or similar.

Otherwise, hold. Use the sober fallback copy (below) only when there is a genuinely new hook:

- A new feature ships (new service integration, a new scoring dimension, a significant architectural change worth an HN crowd looking at).
- A monthly report shows a **material** month-over-month shift — e.g., a Top/Bottom 5 ranking change, a platform-wide reliability regression, or a first-of-its-kind finding. Routine monthly reports without a headline finding are **not** a valid trigger. Submitting "here's my monthly report" every month reads as farming.

HN dedups reposts by URL and its moderators penalize projects that resubmit for incremental updates. Budget: at most **one Show HN every 3 months** outside of active-outage windows.

### Primary post (active outage)

**Title** (80 char limit, total — "Show HN:" prefix counts toward the limit):

```
Show HN: Open-source AI status dashboard with AI-powered incident analysis
```

**URL:** `https://ai-watch.dev` (homepage — not the Is X Down page; Show HN expects a canonical project URL).

**Body:** Leave the text field empty. Show HN convention is to put the project URL in the URL field and leave details to the first comment below — this keeps the front-page listing compact and surfaces authorship.

### Founder's first comment (post immediately after submission)

```
Author here. Quick context since this went up during the Claude outage:

AIWatch is an open-source status dashboard for 30 AI services (23 APIs + 3 apps
+ 4 coding agents). What makes it different from Downdetector / StatusGator:

- AI-powered incident analysis — hybrid Gemma 4 26B (Cloudflare Workers AI
  binding) as primary, Claude Sonnet (via AI Gateway) as fallback. Per-incident
  KV caching keeps costs near zero. Analyses update as the incident timeline
  evolves.
- Detection Lead — direct API probes run every 5 minutes; when probe RTT
  anomalies precede the provider's status page acknowledgment, we record the
  gap. The 5-minute cadence bounds observation resolution, not the lead itself
  — status pages routinely lag the actual outage by 15-45 minutes, so measured
  leads typically land in the minute range (capped at 60 min in UI). Surfaced
  in the dashboard and in Discord alerts.
- Score — single 0-100 reliability metric combining uptime, incident impact
  days (Atlassian-weighted), recovery time, and response consistency for probed
  services.

Stack: Cloudflare Workers + KV + Workers AI, React 19 + Vite, Vercel Edge for
SSR SEO pages. Everything is open source. No account required, no paywall for
users — dashboard is free to access.

GitHub: https://github.com/bentleypark/aiwatch
Repo has architecture notes in CLAUDE.md if you want to dig in. Issues and
PRs welcome — especially new service integrations or parser improvements.

If you want to confirm the current Claude outage right now, the dashboard
surfaces it here: https://ai-watch.dev/is-claude-down (swap the slug for the
affected service). Happy to answer questions about the stack, the scoring
formula, or Workers AI in production.
```

### Expected HN questions — pre-drafted answers

Keep these ready in a scratchpad before submitting. Do not pre-post them; HN readers dislike copy-paste commentary. Use only when the question actually appears.

**Q: "If you poll every 5 minutes, isn't the max lead 5 minutes?"**

No. The 5-minute cadence is observation granularity — the lead is the gap between our earliest anomaly signal and the provider's status page acknowledgment. Status pages often lag the underlying outage by 15-45 minutes because they require human acknowledgment or tiered escalation. So if our probe spike lands at T+0 and the status page updates at T+32, the recorded lead is ~32 minutes. The formula and floor/cap logic is visible in `worker/src/detection.ts`.

**Q: "What's the measured average lead?"**

We don't have a verified 90-day average published yet — a `/press` page with audited figures is tracked in issue #266. Until that ships, quote the specific incident in front of us (e.g., "27 min on this Claude outage"), never a generic average.

**Q: "Why Gemma 4 26B as primary instead of Claude/GPT?"**

Cost and operational surface. The Workers AI binding is auth-free (no API key to rotate or scope) and keeps per-incident inference inside the Cloudflare control plane, which simplifies deploy and cost accounting. Claude Sonnet via AI Gateway is the fallback when Gemma 4 rate-limits or returns a degraded analysis — judged by a `needsFallback` heuristic in the analysis code.

**Q: "How do you handle status pages with bulk-linked incidents (one incident on all components)?"**

See `worker/src/services.ts` — per-service status resolution has a `filterByComponentStatus` step that removes unresolved incidents from healthy components. Surfaces the actual operational state instead of false-alarming on unrelated incidents.

### Sober fallback copy (no current outage)

Lower expectations. Lead with the technical angle, not the outage angle:

```
Show HN: Monitoring 30 AI services on Cloudflare Workers
```

First comment opens with the stack and cost profile, not the outage framing. Detection Lead becomes a secondary bullet, not the headline.

### Do not

- Never post a Show HN during a voting-ring-prone moment (multiple accounts upvoting in sequence, social media "vote this" prompts). HN penalizes aggressively; a flagged post kills the URL permanently.
- Never mention competitors by name in the title or first comment. Describe the gap, not the rival.
- Never submit twice for the same release. HN dedups by URL and will reject or bury reposts.

### Read first

- [HN guidelines](https://news.ycombinator.com/showhn.html)
- [OpenStatus's PH retrospective](https://www.openstatus.dev/blog/our-producthunt-launch-brutal-reality) — why HN > PH for dev tools

---

## Reddit

Reddit communities discuss AI outages in real time. AIWatch is useful in those threads — confirms "yes it's down for everyone, here's the AI analysis" — but only if the post is substantive. Reddit's spam filters auto-flag new accounts linking to the same domain repeatedly; the rule below exists because the platform enforces it.

### Subreddit list

| Subreddit | Self-promo policy | When to engage | Cron coverage |
|---|---|---|---|
| r/ClaudeAI | Strict — mods remove obvious promo | Active Claude outage thread on front page of sub | ✅ outage mode |
| r/ChatGPT | Permissive on outage threads | Active OpenAI / ChatGPT outage thread | ✅ outage mode |
| r/OpenAI | Moderate — outage posts allowed | Active OpenAI outage | ✅ outage mode |
| r/LocalLLaMA | Strict technical bar — no fluff posts | Only when discussion already cites API reliability as a local-vs-hosted argument | ⚠️ competitive mode only (status-monitor keywords) — outage posts are not auto-detected; check manually |
| r/MachineLearning | Very strict — must be research-relevant | Do not post unless AIWatch shipped a methodology writeup | ❌ not monitored by cron — check manually |
| r/AINews | Permissive | Major outage with journalist coverage | ❌ not monitored by cron — check manually |

Before each first post to any of these, **read the sub's rules page** — `/wiki/rules` or the sidebar. Rule changes are not tracked here.

**Cron coverage caveat.** `worker/src/reddit.ts` watches r/ClaudeAI, r/ChatGPT, r/OpenAI (+ r/ClaudeCode / r/cursor / r/windsurf / r/Codeium for coding agents) in outage mode — matches on "down / not working / outage / broken / offline / unavailable / degraded" keywords and sends a Discord alert with a "🎯 PROMOTE" tag when a promotable post appears. The subs marked ⚠️ / ❌ above require manual monitoring via the Reddit search RSS feeds listed below. Expanding cron outage-mode coverage to r/AINews and r/LocalLLaMA is tracked in issue #280. r/MachineLearning is out of scope for that issue — the sub's research-heavy posts need a stricter keyword matcher before it can be added without false positives.

### When to engage

**Engage:**
- A fresh outage thread (< 2 hours old) is on the front page of the sub.
- Top comments are still speculating ("is it just me?") — AIWatch data answers the question.

**Do not engage:**
- General "what's the best LLM" threads.
- Threads where the discussion has moved past confirmation (mods will mark this off-topic).
- Any thread older than 6 hours (reply won't be seen; looks like necroposting for promo).

### Response template

Adapt to the specific thread — never copy-paste verbatim across subreddits.

```
It's down for everyone — just pulled this from AIWatch
(ai-watch.dev/is-claude-down):

- Status: Major Outage (confirmed [HH:MM UTC — pull from dashboard])
- Detection Lead: [X minutes — pull from dashboard] ahead of the official
  status page
- AI analysis: [paste the current AIWatch AI analysis summary, 1-2 sentences]

Fallback recommendation from the dashboard: [top 1-2 fallbacks by Score].

Source is open — happy to explain how the detection works if anyone's curious.
```

Link to the **specific service page** (`/is-claude-down`, `/is-openai-down`, etc.), **never** the homepage. The homepage link looks like spam; the service page is the contextually useful answer.

If the dashboard has not yet computed a Detection Lead (typical within the first 5-10 minutes of an outage, before our probe cycles confirm a sustained spike), **drop the Detection Lead line entirely** rather than leave a `[X minutes]` placeholder or guess. The rest of the template still stands — confirmed outage + AI analysis + fallback recs are useful on their own.

### Frequency limit

- Max 1 link-bearing post per subreddit per 7 days.
- Text-only contributions (no link) don't count — be helpful without promoting.
- Track removed posts per subreddit. Two removals from the same sub = stop posting links there for 30 days.

### Account preparation

Reddit and large-sub AutoMod configurations filter links from new/low-karma accounts. Exact thresholds are private and vary by sub — don't assume a fixed number. Before any posting:

- Use an account with a real comment history across multiple unrelated subs — treat "several months of organic activity" as the bar, not days.
- Check the target sub's `/wiki/rules` and `/wiki/config/automoderator` if public — some large subs publish their karma floor; most don't.
- Never create a throwaway for this. Fresh-account promotion patterns get the domain shadowbanned platform-wide after a few instances, and the damage is not reversible.
- **Owner action required**: confirm the posting account meets the bar before the first outage window — don't discover the shadowban mid-outage.

### Monitoring setup

To catch outage windows in time:

- **Reddit search RSS**: `https://www.reddit.com/search.rss?q=claude+down&sort=new&t=hour`
  - Repeat for `openai down`, `gemini down`, `chatgpt down`, `copilot down`.
  - Subscribe in Feedly or similar.
- **Subreddit-specific RSS**: append `/new/.rss` to each sub URL.
- Cross-reference against AIWatch's own Discord alert feed — if AIWatch detected the outage, a Reddit thread is often spinning up shortly after.

**Verify before first outage window** (owner action, one-time):

- [ ] All 5 Reddit search RSS feeds subscribed and receiving entries
- [ ] r/ClaudeAI, r/ChatGPT, r/OpenAI, r/LocalLLaMA, r/AINews `/new/.rss` feeds subscribed
- [ ] AIWatch Discord webhook active on the same reader surface as the Reddit feeds — so both signals converge in one place
- [ ] Posting account meets the account-prep bar (see previous section)

---

## Shared rules

- **One link per post.** Multiple AIWatch URLs in a single comment = spam signal.
- **No vote manipulation.** Never ask anyone — Twitter, Discord, colleagues — to upvote. Both HN and Reddit detect coordinated voting and penalize the domain permanently.
- **Disclose affiliation.** "I built this" / "Author here" in the first line. Hiding authorship on a self-promo post is grounds for immediate removal on most subs and HN flags.
- **No fabricated screenshots.** Every screenshot in a post or comment must be a live capture of ai-watch.dev at the time claimed. Placeholder values in the response templates above (timestamps, lead minutes) are for dry-run planning only — never ship them.
- **Track everything.** Append an entry to the log table below after every post — takes ~30 seconds and compounds across posts so we can learn which subs/times actually convert.

### Pre-post dry run

Every post, every channel, no exceptions. Run through this in order before hitting submit:

- [ ] All `[bracket placeholders]` in the template replaced with live values pulled from the dashboard at posting time
- [ ] Numbers (timestamps, Detection Lead minutes, uptime %) match what ai-watch.dev shows right now — not a cached tab from 30 minutes ago
- [ ] Link points to the specific service page (`/is-<service>-down`), not the homepage
- [ ] Authorship disclosed in the first line ("Author here" / "I built this")
- [ ] Only one AIWatch URL in the body
- [ ] No competitor named in the title
- [ ] Ran today's outage through the Trigger criteria — this is actually in-window, not a stretch

### Post log

Append one row per post. Keep it in this file so the history travels with the playbook.

| Date (UTC) | Channel | URL | Score / upvotes | Comments | Removed? | Notes |
|---|---|---|---|---|---|---|
| _e.g. 2026-05-02_ | _r/ClaudeAI_ | _reddit.com/r/.../comments/..._ | _+12_ | _3_ | _no_ | _top comment was "thanks, confirmed"_ |

## Change log

Update this file when:
- Subreddit rules change materially (a sub goes no-promo)
- A post is removed — log the reason so we learn the pattern
- The product gains a new hook worth leading with in HN copy
