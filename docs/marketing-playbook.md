# Marketing Playbook

Operational reference for opportunistic, organic distribution of AIWatch during major AI outages. Two channels, one rule: **be useful first, the link is incidental.**

- [Show HN](#show-hn)
- [Reddit](#reddit)
- [Shared rules](#shared-rules)

**Not covered here:** journalist outreach (Casey Newton, Hard Fork, AI beat reporters). That channel requires verified statistics (MTTD + RTT-degradation counts the official status pages don't report — the honest pillars after the #464 redefinition, not a "faster than official" average) and a permanent embeddable URL — tracked separately in issue #266 (`/press` page). Once `/press` ships, a third section will be added here for journalist DM/email flow.

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

AIWatch is an open-source status dashboard for [N] AI services. What makes it
different from Downdetector / StatusGator:

- AI-powered incident analysis — hybrid Gemma 4 26B (Cloudflare Workers AI
  binding) as primary, Claude Sonnet (via AI Gateway) as fallback. Per-incident
  KV caching keeps costs near zero. Analyses update as the incident timeline
  evolves.
- RTT degradation detection — direct API probes run every 5 minutes and flag
  latency degradation that provider status pages often never report (status
  pages report hard-down, not slowness). This is the honest differentiator for a
  synthetic-probe architecture (#464). Independent detection lands within the
  ~5-min polling cycle of the official report (MTTD); we do NOT claim "faster
  than the official status page" as a headline — diagnostic data showed status-
  page-based detection is structurally bounded by polling lag. Occasional genuine
  early-RTT signals (probe flagged degradation before the official update) are
  shown per-event; the averaged figure is gated behind a minimum sample size so a
  marketing claim never rests on thin data. Surfaced in the dashboard + Discord.
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

**Q: "Why Gemma 4 26B as primary instead of Claude/GPT?"**

Cost and operational surface. The Workers AI binding is auth-free (no API key to rotate or scope) and keeps per-incident inference inside the Cloudflare control plane, which simplifies deploy and cost accounting. Claude Sonnet via AI Gateway is the fallback when Gemma 4 rate-limits or returns a degraded analysis — judged by a `needsFallback` heuristic in the analysis code.

**Q: "How do you handle status pages with bulk-linked incidents (one incident on all components)?"**

See `worker/src/services.ts` — per-service status resolution has a `filterByComponentStatus` step that removes unresolved incidents from healthy components. Surfaces the actual operational state instead of false-alarming on unrelated incidents.

### Sober fallback copy (no current outage)

Lower expectations. Lead with the technical angle, not the outage angle:

```
Show HN: Monitoring [N] AI services on Cloudflare Workers
```

First comment opens with the stack and cost profile, not the outage framing. RTT degradation detection becomes a secondary bullet, not the headline.

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

**A sub's own rules may name "is X down?" posts for removal** — r/ChatGPT's do (see "Removed posts" below). That is *subreddit* moderation, not a Reddit-wide behaviour, so it tells you nothing about any other sub.

### Subreddit list

**The per-service list is not reproduced here.** During an outage the operator does not read this file — the Discord incident alert hands them the subreddit links directly (#1182). A copy of either code list in this table would drift the first time that list is edited, and nothing would catch it.

Two subs carry engagement value that the per-service map does not express, so they are listed rather than mapped:

| Subreddit | Relevant when |
|---|---|
| r/LocalLLaMA | Discussion already cites API reliability as a local-vs-hosted argument |
| r/AINews | Major outage with journalist coverage |

**How the engagement list was chosen (2026-07-29).** 12 quoted outage phrases via Reddit search over a year, 584 results scanned, 463 kept after requiring both an outage word and an AI-service word in the *title*, tallied by subreddit: **82 distinct subs**. Two caveats that came out of it:

- **Two high-volume subs are bot mirrors and are deliberately excluded.** r/Claude_reports ranked **first** by raw hits — and 25 of its 25 newest posts are by `ClaudeAI-mod-bot`, mean **0.0** comments. r/outagealerts is 23/25 by `isdownapp`, a competitor's feed. Ranking subs by hit count alone puts a zero-human mirror at the top; check author concentration and comments-per-post before adding any sub here.
- **The tail is most of the volume and no list can hold it.** Most of the 82 subs contributed one or two posts from communities this table would never carry — r/UAE, r/nairobi, r/teenagers, r/Btechtards, r/EngineeringStudents. This is why the keyword alerting below is the primary discovery method and the sub list is the fallback, not the reverse.

Before posting or commenting in any of these, **read the sub's rules page** — `/about/rules/`, and the sidebar too, since the two renderings can differ (they do on r/ChatGPT) — and check what it says about outage posts and about self-advertising. Rule changes are not tracked here, so read it again even if you read it last time. Being listed above is not clearance to post.

> **Status (2026-07-29): the 🎯 PROMOTE alerts are not being delivered.** Reddit's public search endpoint returns 403 to the Worker's unauthenticated requests (observed 2026-06-29, #820). The OAuth fix (PR #1136) is written and MERGEABLE with no GitHub review since it was opened 2026-07-23 — **merging is not what is blocked**: without credentials the Reddit monitor fail-soft skips, and obtaining those credentials is what waits on the Reddit Data API access approval. Assume no cron Reddit coverage until an outage-mode Discord alert is actually seen. (The daily summary's `📢 Reddit` count does not settle it — it counts live `reddit:seen:*` keys across the competitive and security modes too.)
>
> **Auth is not the only obstacle (measured 2026-07-29).** From the Cloudflare edge (`wrangler dev --remote`, production UA, 00:19–00:33 UTC), the *unauthenticated* listing feeds that need no approval also fail: counting only `www.reddit.com` listing-feed requests, **4 of 18 succeeded (~22%)** — per endpoint on r/ChatGPT, `/new/.rss` 1/5 and `/comments/.rss` 1/8. Spacing requests to one per 60s did not recover it. The 429 body is Reddit's per-IP limiter, and the Worker shares its egress IP with other Cloudflare tenants, so the limit is not ours to back off from. The #1182 alert links exist because a link the operator opens in a browser is subject to none of this.

**Cron coverage caveat.** Which subs the cron watches, which titles it tags `🎯 PROMOTE`, and the age window it applies are defined in `worker/src/reddit.ts` and pinned by its unit tests — read them there rather than trusting a copy here. r/MachineLearning is deliberately out of scope. The operator alert's link list (`REDDIT_ENGAGE_SUBS`, #1182) is separate from the cron's scan list and needs no Reddit access, so it works while the scan does not.

### When to engage

The target is an individual outage thread. Open the URL from an F5Bot alert when you have one; browsing the sub is the fallback, and reaches only the threads that were not removed.

**Engage when:**
- The outage is live and confirmed on the AIWatch dashboard.
- The conversation is still on "is it just me?" — that is the question AIWatch data answers.

**Do not engage:**
- General "what's the best LLM" threads.
- Threads where the discussion has moved past confirmation (mods will mark this off-topic).

### Removed posts

Point observations from 2026-07-28 unless dated otherwise, read logged-out via `old.reddit.com`. Re-check before relying on any of them.

- **The removal is rule-backed, and the rules cover comments too.** Both quotes below are from the [`/about/rules/` widget](https://old.reddit.com/r/ChatGPT/about/rules/), read 2026-07-28. **Rule 2, "No Trashposts"** (scope: Posts & Comments): *"Posts deemed to be entirely without value or effort may be removed if they have not generated interesting discussions before their discovery. … Specifically mentioning that "Is ChatGPT down?" posts will be removed; the stickied FAQ deals with that."* **Rule 3, "Self Advertising"** (same scope): posts *"solely focused on advertising a single other LLM service … should directly go to weekly self-promotional mega thread, which is pinned"*. Both are this sub's policy; every other sub has to be read on its own page.
- **A removed post is not a dead post.** The instance the owner shared (~2026-07-25, permalink not recorded) carried a moderator-removal notice and still had a live comment section. Do not read "not in the listings" as "nobody is there."
- **Neither thread the rules name was found in the sticky slots.** Rule 2 points at a stickied FAQ, Rule 3 at a pinned weekly self-promo megathread; on 2026-07-28 the sub's two stickied slots held a "Tuesdays, text posts only" notice and a ChatGPT Images post. The wiki, sidebar links and menu were not checked — so look for both before concluding they don't exist.

**Untested idea: ask the mods to point at AIWatch.** The observation behind it — an AutoModerator reply carrying provider-status links on the removed post above — comes from the thread whose permalink was not recorded, so it is unverified. Re-observe it, **saving the permalink first**, before spending anything on this. If it holds and mods accepted an AIWatch link, the payoff would be a standing, mod-approved placement that needs no post from us.

That would be **mod outreach, not posting**: message the mods, explain what AIWatch is, and ask. One sub at a time; any link in the message still carries `?utm_source=reddit`. Treat a "no" as final for that sub, and **log the ask and its answer in the post log below** so it is not re-tried blind a year later. Because nothing is being posted, the frequency limit below does not apply.

### Response template

Adapt to the specific thread — never copy-paste verbatim across subreddits.

```
Author here (I built AIWatch) — it's down for everyone, just pulled this from
AIWatch (ai-watch.dev/is-claude-api-down?utm_source=reddit):

- Status: Down (confirmed [HH:MM UTC — pull from dashboard])
- Early RTT signal: [X minutes — ONLY if the dashboard shows one] — our probe
  flagged latency degradation before the official status update
- AI analysis: [paste the current AIWatch AI analysis summary, 1-2 sentences]

Fallback recommendation from the dashboard: [top 1-2 fallbacks by Score].

Source is open — happy to explain how the detection works if anyone's curious.
```

Link to the **specific service page** (`/is-claude-api-down`, `/is-openai-api-down`, etc. — after #1164 the bare `/is-claude-down` is the provider-FAMILY page; the Discord alert already hands you the right one), **never** the homepage. The homepage link looks like spam; the service page is the contextually useful answer.

**Always append `?utm_source=reddit`** to the link — it is what reliably attributes the visit to the Reddit channel in AIWatch's audience classifier (`worker/src/outage-audience.ts`); without the tag the visit may not be counted as Reddit at all. Paste the link the Discord alert gives you as-is; hand-built links need `?utm_source=reddit` at minimum.

A genuine early-RTT signal is **rare** (most incidents are component/connector degradations that don't spike the probed endpoint's RTT, and status-page detection is structurally bounded by polling lag — #464). If the dashboard does not show one, **drop the line entirely** rather than guess or claim "ahead of official." The rest of the template still stands — confirmed outage + AI analysis + fallback recs are useful on their own. Never frame AIWatch as "faster than the official status page" as a blanket claim; the verifiable pillars are independent detection (MTTD) + RTT degradation that status pages don't report.

### Frequency limit

- Max 1 link-bearing post per subreddit per 7 days.
- **Max 1 link-bearing comment per thread, and max 2 per subreddit per outage** — count the whole outage, not each dashboard incident. A comment is not a post, so the 7-day post limit does not cover it — but repeating the link is the same spam signal whether it is a post or a comment.
- Text-only contributions (no link) don't count — be helpful without promoting.
- Track removed posts per subreddit, and log which rule the mods cited. Two removals from the same sub = stop posting links there for 30 days.

### Account preparation

Reddit and large-sub AutoMod configurations filter links from new/low-karma accounts. Exact thresholds are private and vary by sub — don't assume a fixed number. Before any posting:

- Use an account with a real comment history across multiple unrelated subs — treat "several months of organic activity" as the bar, not days.
- Check the target sub's `/wiki/config/automoderator` if public — some large subs publish their karma floor; most don't.
- Never create a throwaway for this. Fresh-account promotion patterns get the domain shadowbanned platform-wide after a few instances, and the damage is not reversible.
- **Owner action required**: confirm the posting account meets the bar before the first outage window — don't discover the shadowban mid-outage.

### Monitoring setup

To catch outage windows in time, use a **keyword-alert service that pushes** — not a feed reader you
have to pull.

- **[F5Bot](https://f5bot.com) — the live method.** Free, native keyword email alerts across Reddit,
  Hacker News, and Lobsters. Register the outage keywords (`claude down`, `openai down`, `gemini down`,
  `chatgpt down`, `copilot down`, and `aiwatch` for mentions); it emails you when a matching post or
  comment appears. This is the chosen method — the setup checklist below is what confirms it is live.
- Cross-reference against AIWatch's own Discord alert feed — if AIWatch detected the outage, a Reddit
  thread is often spinning up shortly after.

> **Why not Reddit search RSS / Feedly** (the previously documented method, now retired): Reddit's
> public search endpoint (`search.rss` / `search.json`) now returns **403** to unauthenticated clients,
> so a `search.rss?q=claude+down` feed no longer delivers. And Feedly's own keyword tracking is a **paid
> Pro+** feature — its free tier has no search/keyword filtering and pushes no email — so it was never a
> free keyword alert either. F5Bot sidesteps both: it has its own Reddit access and alerts natively.

**Verify before first outage window** (owner action, one-time):

- [ ] F5Bot account created with all outage keywords registered and a test alert received
- [ ] AIWatch Discord alert feed monitored alongside F5Bot — an outage AIWatch already flagged corroborates an incoming Reddit thread
- [ ] Posting account meets the account-prep bar (see previous section)

---

## Shared rules

- **One link per post.** Multiple AIWatch URLs in a single comment = spam signal.
- **No vote manipulation.** Never ask anyone — Twitter, Discord, colleagues — to upvote. Both HN and Reddit detect coordinated voting and penalize the domain permanently.
- **Disclose affiliation.** "I built this" / "Author here" in the first line. Hiding authorship on a self-promo post is grounds for immediate removal on most subs and HN flags.
- **No fabricated screenshots.** Every screenshot in a post or comment must be a live capture of ai-watch.dev at the time claimed. Placeholder values in the response templates above (timestamps, lead minutes) are for dry-run planning only — never ship them.
- **Track everything.** Append an entry to the log table below after every logged action — takes ~30 seconds and compounds so we can learn which subs/times actually convert.

### Pre-post dry run

Every post and every link-bearing comment, every channel, no exceptions. Run through this in order before hitting submit:

- [ ] All `[bracket placeholders]` in the template replaced with live values pulled from ai-watch.dev at posting time (the service count is published on `/methodology`, not on the dashboard)
- [ ] Numbers (timestamps, early-RTT signal minutes if shown, uptime %) match what ai-watch.dev shows right now — not a cached tab from 30 minutes ago
- [ ] Link points to the specific service page (`/is-<service>-down`), not the homepage
- [ ] **Reddit posts and comments:** the link carries `?utm_source=reddit` — otherwise the visit may be unattributable (see Reddit § "Response template")
- [ ] Authorship disclosed in the first line ("Author here" / "I built this")
- [ ] Only one AIWatch URL in the body
- [ ] No competitor named in the title
- [ ] **Show HN only:** ran today's outage through the Trigger criteria — this is actually in-window, not a stretch

### Post log

Append one row per post, link-bearing comment, or mod-outreach attempt (`Channel: mod-outreach`, the ask and the answer in `Notes`). Keep it in this file so the history travels with the playbook.

**Upvotes are not the metric.** What this channel is being measured on is `?utm_source=reddit` traffic in the outage-audience data — a well-received comment can send no clicks at all. Log the upvote/comment counts as context. Mod-outreach rows have no URL or counts: dashes in the count columns.

| Date (UTC) | Channel | URL | Score / upvotes | Comments | Removed? (rule cited) | Notes |
|---|---|---|---|---|---|---|
| _e.g. 2026-05-02_ | _r/ClaudeAI_ | _reddit.com/r/.../comments/..._ | _+12_ | _3_ | _no_ | _top comment was "thanks, confirmed"_ |

## Change log

Update this file when:
- A sub's rules on outage posts or self-advertising turn out to matter — record what the rule says, with its number and the date read
- A post is removed — log the reason so we learn the pattern
- The product gains a new hook worth leading with in HN copy
- **An outage-mode 🎯 PROMOTE alert is seen in Discord** — delete the Reddit-cron Status callout
- Mod outreach is attempted — log the sub, the ask and the answer in the post log
