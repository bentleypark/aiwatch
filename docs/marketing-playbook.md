# Marketing Playbook

Operational reference for opportunistic, organic distribution of AIWatch during major AI outages. Two channels, one rule: **be useful first, the link is incidental.**

- [Show HN](#show-hn)
- [Reddit](#reddit)
- [Shared rules](#shared-rules)

---

## Show HN

AIWatch's stack (Cloudflare Workers + KV + Workers AI binding, hybrid Gemma 4 / Claude Sonnet analysis, open source) is HN-native. Timing matters more than copy — a Show HN posted within 1-2 hours of a major AI outage rides existing topical interest. The same post on a quiet day sinks.

### Trigger criteria

Post only when **at least one** of these is true:

- A Tier 1 service (`claude`, `openai`, `gemini`) has `status === 'down'` for 30+ minutes, verified via AIWatch dashboard.
- A current outage is being covered by TechRadar, The Verge, Bloomberg, or similar.

Otherwise, hold and use the sober fallback copy (below) only if the project has an independent news hook (new feature launch, monthly report with notable finding, etc.).

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
- Detection Lead — we poll provider status pages and probe direct API endpoints
  every 5 minutes. When a probe RTT spikes before the status page acknowledges,
  that gap is the lead time. Surfaced in the dashboard and in Discord alerts.
- Score — single 0-100 reliability metric combining uptime, incident impact
  days (Atlassian-weighted), recovery time, and response consistency for probed
  services.

Stack: Cloudflare Workers + KV (free tier), React 19 + Vite, Vercel Edge for
SSR SEO pages. Everything is open source. No account, no paywall — free forever.

GitHub: https://github.com/bentleypark/aiwatch
Repo has architecture notes in CLAUDE.md if you want to dig in. Issues and
PRs welcome — especially new service integrations or parser improvements.

Happy to answer questions about the stack, the scoring formula, or Workers AI
in production.
```

### Sober fallback copy (no current outage)

Lower expectations. Lead with the technical angle, not the outage angle:

```
Show HN: Monitoring 30 AI services on Cloudflare Workers (free tier)
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

| Subreddit | Self-promo policy | When to engage |
|---|---|---|
| r/ClaudeAI | Strict — mods remove obvious promo | Active Claude outage thread on front page of sub |
| r/ChatGPT | Permissive on outage threads | Active OpenAI / ChatGPT outage thread |
| r/LocalLLaMA | Strict technical bar — no fluff posts | Only when discussion already cites API reliability as a local-vs-hosted argument |
| r/MachineLearning | Very strict — must be research-relevant | Do not post unless AIWatch shipped a methodology writeup |
| r/AINews | Permissive | Major outage with journalist coverage |
| r/OpenAI | Moderate — outage posts allowed | Active OpenAI outage |

Before each first post to any of these, **read the sub's rules page** — `/wiki/rules` or the sidebar. Rule changes are not tracked here.

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
- Cross-reference against AIWatch's own Discord alert feed — if AIWatch detected the outage, a Reddit thread is likely spinning up within 10-20 minutes.

---

## Shared rules

- **One link per post.** Multiple AIWatch URLs in a single comment = spam signal.
- **No vote manipulation.** Never ask anyone — Twitter, Discord, colleagues — to upvote. Both HN and Reddit detect coordinated voting and penalize the domain permanently.
- **Disclose affiliation.** "I built this" / "Author here" in the first line. Hiding authorship on a self-promo post is grounds for immediate removal on most subs and HN flags.
- **No fabricated screenshots.** Every screenshot in a post or comment must be a live capture of ai-watch.dev at the time claimed. Placeholder values in the response templates above (timestamps, lead minutes) are for dry-run planning only — never ship them.
- **Track everything.** Each post: timestamp, URL, subreddit/HN, outcome (score, comments, removed/not). If a pattern is working, double down; if it's not, stop — don't churn effort on dead channels.

## Change log

Update this file when:
- Subreddit rules change materially (a sub goes no-promo)
- A post is removed — log the reason so we learn the pattern
- The product gains a new hook worth leading with in HN copy
