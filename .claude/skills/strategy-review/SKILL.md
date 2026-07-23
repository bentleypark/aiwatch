---
name: strategy-review
description: >-
  Where the never-closing biz/marketing strategy threads stand, and what each needs next. Invoke for
  strategy ("전략 리뷰", "마케팅/비즈 상황 정리", "수익화 어디까지 왔지", when returning after a break and
  needing to reconstruct "why we're here"). Its subject is the `initiative_*` pages of the LLM Wiki
  decision graph — thesis, delivered vs pending work, next action with its inputs, kill criteria, and
  the decisions + constraints that govern each thread. **It does NOT prioritise the board**: ~90% of
  open issues are dev/ops, and ranking them beside two strategy actions buries the strategy — that is
  `issue-triage`'s job, run it separately. Board issues appear here only as a blocker of an initiative
  or as evidence of where the hours went. Read docs/reference/decision-graph.md.
---

# Strategy review — fuse progress × priority × decision-context (#917)

The recurring solopreneur pain: I can see *what's in progress* (board) and *what's urgent* (labels),
but the **decision context** — current situation + why we chose this + what we rejected + what it
constrains — is scattered, so every return-to-decide re-pays a reconstruction cost. This skill fuses
the three so priority comes **with its reasoning**, not just a rank.

It does **not** call the `issue-triage` skill, and it emits no board ranking — see the division of
labour below. It reads the board only as evidence (a blocker of an initiative, or where the hours
went), and does its own read; running `issue-triage` and discarding its ranking would be wasted work.
The vocabulary (entities + relations + the `type:decision` page format) is
**[docs/reference/decision-graph.md](../../../docs/reference/decision-graph.md)** — read it first.

## When to invoke vs issue-triage — a hard division of labour

- **issue-triage** — "which dev/ops issues are stale, which to close, **what to work on next**." Board
  prioritisation is *its* job, and it is good at it. Run it for that.
- **strategy-review** (this) — "where do the strategy threads stand, and what does each need next."
  Its subject is the `initiative_*` pages, not the board.

**This skill does NOT emit a dev do-next.** It once did, and the result was a brief where 3 of 5
recommendations were dev issues. Two structural reasons, both fatal:

1. **Volume.** ~90% of open issues carry `area:dev`/`area:ops`; two initiatives carry an action each.
   Rank them in one list and the board swallows the strategy.
2. **The ranking criterion inverts.** A hard external deadline ("miss it and CI breaks") always beats a
   kill-criterion clock ("miss it and the decision quietly evaporates"). So the strategic item is last
   **by construction** — while the self-imposed deadline is precisely the one a solo operator drops.
   A skill that exists to protect strategy cannot rank strategy by a criterion that buries it.

Biz/marketing work is not on the board — that is *why* the initiative pages exist (#917). Re-importing
the board re-imports the container this whole graph was built to escape. Run both skills; they answer
different questions from different data with different orderings.

## Write for the operator, not for the graph

**This governs everything the skill emits** — the do-next in step 4, the per-initiative detail, and the
`strategy:brief` mirror text in step 5. It is placed before the procedure because it constrains all of
them, not any one step.

The reader is the operator deciding what to do this week — not a maintainer of this ontology. **A brief
they have to ask you to translate has failed, no matter how correct it is.**

**The traverse/emit boundary:** the PROCEDURE sections below are written in graph vocabulary
(`advances::`, `bounds::`, "slice", "gated") **on purpose** — that is how the skill reads the graph, and
it must stay precise. None of those terms may appear in the **output**. Working vocabulary, not output
vocabulary; do not "simplify" the procedure, and do not leak it into the brief.

| Don't write | Write |
|---|---|
| `advances::` / `delivered::` | "남은 일" / "끝난 일" |
| "slice" | name the work itself; when you must distinguish one item from the whole thread, "이 항목 하나" vs "이 방향 전체" |
| "gated" / "ungated" / "the gate" | "이슈에 *시작하지 말 것*이라고 적혀 있다" + **who or what would open it** |
| "cadence" / "repo attention" | "지난 30일 완료 N건" / "지난 7일 커밋 N개 중 M개만 여기에 기여" |
| "Inputs (have) / (missing)" | "필요한 건 다 있다" / "**X가 없어서 못 한다**" |
| "emits no action" / "revival condition" | "손 안 댐" + "되살리려면 X 하나" |
| `[[decision_x]]` as the reason | the decision's actual claim, in one clause |
| "preempt" | say which thing loses its value and in which direction — "A를 먼저 하면 B의 결과가 의미 없어진다" (past work wasted OR a pending reading made moot; name the one that applies) |

The right column shows the **register**, not fixed strings — reword to fit the sentence. It is Korean
because the operator reads Korean; if a run emits an English brief, apply the same rule in English (the
ban is on field names and graph terms, not on a language).

Four rules on top of the table:

1. **Lead with the conclusion, then the reason.** "내일 데이터 보고 채널 정한다 — 지금 정하면 어제
   작업이 헛수고" beats the same facts arranged as evidence→conclusion.
2. **Every jargon term that survives must be defined inline, once, in the same sentence.** If it can't
   be, it wasn't needed.
3. **A number needs its meaning, not just its window.** "3 of 46 commits" is data; "시간의 93%가 다른
   데 갔다" is the finding. Print both — the second is why the first is in the brief.
4. **Name the mechanism when an issue is blocked.** "#861 is gated" tells the reader nothing they can
   act on. "이슈에 *시작하지 말 것*이라 적혀 있고, 열리는 조건이 멈춰 있는 수익화 쪽 대화라 아무도 안
   움직이면 영원히 안 열린다" tells them it is structurally dead, which is the actual finding.

### Worked example — the 2026-07-20 failure that produced this section

The brief emitted this as do-next item 2 (quoted in full):

> **2. Growth 병렬 — #1083의 게이트를 푼다(플랜에서 `cf.botManagement`가 채워지는지 런타임 확인).**
> 게이트가 걸린 건 #1083의 *본체*지 이 확인이 아닙니다 — 이슈 첫 박스가 바로 이 확인이고, 결과가
> 음성이면 스코프가 UA 정규식으로 줄어듭니다. 위 판독을 선점하지 않는 유일한 미게이트 슬라이스입니다.
> cost: 미상.

The operator's reply was, verbatim: *"이게 무슨 말인지"*. Every clause was true; every clause was
graph-speak ("게이트", "미게이트 슬라이스", "선점", `cost: 미상`). The same item, rewritten:

> **2. 짬나면: 봇 판별이 가능한지 확인.** 봇을 세려면 먼저 봇인지 알아낼 방법이 있어야 합니다.
> Cloudflare가 봇 점수를 주지만 그건 Enterprise 요금제 기능이라, **우리 요금제에서 실제로 값이 오는지
> 확인한 적이 없습니다.** 로그 한 줄 넣고 보면 됩니다. 오면 정밀하게 가고, 안 오면 이 작업은 User-Agent
> 문자열 검사만 하는 작은 일로 줄어듭니다. 순서를 뒤집으면 없는 기능 위에 설계를 쌓게 됩니다.

**What actually changed, precisely** — the second version is not merely nicer prose, and imitating it as
"add more words" is the wrong lesson:

- Jargon removed: "게이트" became the concrete blocker (an unverified plan feature), "선점" was dropped
  as unnecessary once the reasoning was stated plainly, `cost: 미상` became silence (an unknown cost you
  cannot yet derive needs no field).
- **An input was resolved rather than named.** The first version cited "the gate"; the second says what
  the gate IS (Cloudflare bot score, Enterprise-only, never checked on our plan) and what resolving it
  costs (one log line). That research should have happened before writing either version — per "every
  do-next line must be executable on reading" in step 4. Half of this failure was writing, half was
  writing before finishing the reading.

## Procedure (follow in order)

### 1. Load the standing context (the "why" + constraints)
- Read `MEMORY.md` (the index), then load every **`type:decision`** page (the `## Decisions` section)
  and the relevant **`project`** pages. These are the standing decisions that bound priority — e.g.
  `decision_depth_not_breadth`, `decision_ontology_saas_deferral`.
- Note each decision's `Status`: **active** (a live constraint), **revisit** (past/near its trigger —
  goes in the "decisions to revisit" section), **superseded** (check its dependents were updated).
- Load the **`type:constraint`** pages too (the `## Constraints` section — `constraint_solo_capacity`,
  `constraint_kr_network_separation`, `constraint_neutrality_moat`, `constraint_free_tier_budget`).
  They cap what's even decidable, and each one's `bounds::` edges name the decisions it shapes — so
  "what limits this call?" is a lookup on the constraint page, not a re-derivation from prose.

### 2. Initiative state — from the `initiative_*` pages, NOT the board
- Read every **`type:initiative`** page (the `## Initiatives` section of `MEMORY.md`). Each one's
  `Status` / `Current state` / `Evidence` / `Next action` / `Exit criterion` / `Pending`·`Delivered` **is** the state of record. A
  `tracking` GitHub issue is a thin pointer; its checkboxes and its `0/N` are not the truth and must
  never be read as progress.
- This ordering is the whole point of the skill. Biz/marketing threads (#803 growth, #637
  monetization) don't fit the issue shape — they have a thesis under test, not a done condition — so
  deriving their state from the board is how the reconstruction cost got paid over and over. Read the
  pages first; the board only tells you which execution slices are in flight.
- Each page carries **both halves of the work**: `advances::` = pending (open issues), `delivered::` =
  what already shipped (closed issues; older ones folded to `YYYY-MM ×N`). **Read them together** — the
  brief's "progress" comes from `delivered`, its "what's next" from `advances` + `Next action`. A
  thread with delivered ×0 over a month is not idle prose, it is a resource finding.
- Read each page's **`Status: active | parked`** and check it against its own `delivered::` cadence over
  the window. A thread claiming `active` with ×0 delivered in 30 days is mislabelled; say so. A `parked`
  thread contributes its **revival condition**, not an action.
- Flag two things: an initiative whose `Next action` is a *state* ("waiting", "choose") rather than a
  verb with a cost and a trigger, and one whose `Exit / kill criterion` has a clock that never started.
- **Check the provenance of every `Inputs (have)` item.** A `discovery/` artefact or a `project_*`
  page's recommendation is *exploratory*: it can make a **decision** executable, never an action. If the
  thread's premise has no `decision_*` page, that decision is the next step (vocabulary rule 4).

### 3. Board pass — evidence only. Never a do-next.
The board enters this brief in exactly **two roles**. Anything else about it belongs to `issue-triage`.

- **Role 1 — a blocker of an initiative.** An issue that stands between a thread and its next action.
  Write it as a *strategic* sentence, not a ticket: not "#547·16 is unticked" but "the 07-15 channel
  review cannot answer whether the low-friction channel converts, because the lift measurement does not
  exist." The issue number is a citation, not the content. Apply the verify-before-recommend gate — read
  the code, not the label.
- **Role 2 — evidence of where the hours went.** Two numbers over two named windows: `delivered::`
  per initiative over the **30-day** thread-cadence window (growth 5, monetization 0), and **repo
  attention** = the count of merges that **advanced any initiative** over a **7-day** window (the
  default — long enough to smooth a quiet weekend, short enough to catch a stall; state the dates, and
  widen it only with a reason). Count a merge as advancing an initiative if it references any of that
  thread's issues, *including ones you just moved to `delivered::`* — a slice closing in the window is
  attention spent on the thread, so don't let the edge-flip drop it from the count. This is an
  observation about resource allocation under [[constraint_solo_capacity]],
  not a ranking.

Do **not** list open dev/ops issues, derive `P0–P3`, or recommend board work. If a hard external
deadline (e.g. a runner deprecation) will consume hours before a strategy window closes, say so once as
a **capacity note** — "N hours are already spoken for before <date>; `issue-triage` ranks that work" —
and move on. Naming it is context; ranking it is scope creep.

- Cross-check the merges **in a day-window you name** (e.g. the last 7 days) against each initiative's
  `Current state` line: a merge that advanced an initiative but left its page's state stale is a
  finding — **update the page**. Do not say "the last N merges": that is a window of variable length
  and this skill forbids it four points below. State the dates.
- Do NOT try to reconstruct an initiative's progress from its issues. If an initiative page is
  missing for a live strategy thread, say so; that is the finding.
- **Before calling a `tracking` umbrella a missing Initiative, apply the four-question test** in
  `docs/reference/decision-graph.md` rule 4 — *does it close · does `N/M` lie · does a Decision govern
  it · does its state live outside the issue*. **The default answer is no**, by a wide margin (that
  doc carries the base rate; don't restate it here — one home per number). Read the body, not the
  label: a run that judged #400 and #735 from their labels mis-read both. A wrongly created initiative
  page is a permanent stub with permanent upkeep.
- The lint does **not** flag `tracking` issues lacking an initiative page, on purpose: at that base
  rate the report would be mostly noise, and the question is asked once when an umbrella is filed,
  not on every review.

### 4. Fuse via the decision graph → emit the brief
Traverse the relations (`advances` / `constrains` / `evidences` / `bounds` / `supersedes` / `blocks`)
to connect each candidate to its rationale, then output BOTH:

- **Never print a bare issue number.** `delivered:: #778 · #777 · #805` is a citation list, not a
  sentence — the reader cannot tell what shipped. Every number arrives with its gloss, in the
  initiative's language: *"#936 — UTM 귀속 누수 봉합"*. The number is a citation; the gloss is the noun.
- **Windows are days, never merges.** A merge count is a window of *variable length* — a burst of a
  dozen merges can span a single busy afternoon — so setting it beside a day-measured window compares
  two different spans and manufactures a contradiction. Measure in days; state them. And keep the two
  metrics
  separate: **thread cadence** (this initiative's `delivered::` in a window) answers *is it alive*;
  **repo attention** (count of merges in a window advancing any initiative) answers *where did the
  hours go*. State the window each time.
- **Top — the do-next holds initiative actions ONLY**, one line per live thread, in the order a
  strategist would take them. (A previous version ranked board issues alongside them "so the two are
  weighed against each other". That was wrong on both counts — see the division of labour above. It is
  retracted.)

  Each entry must answer all of the following, **in plain sentences a reader can follow without knowing
  this skill exists**:

  - what to do;
  - what you will look at;
  - what you will decide from it;
  - why not the obvious alternative;
  - what is missing, if anything, and when it can start.

  The old template for this line was a single interpunct-separated chain of internal field names
  (`Inputs have / missing`, `cost`, `deadline-or-trigger`, `consistent with [[decision_X]]`). It is
  **retracted** — it produced technically-complete lines the operator had to ask about, which re-creates
  at the output the exact reconstruction cost this skill exists to remove. Carry the same content as
  prose. Note this list is deliberately NOT written as one interpunct chain: a rule against dense
  formatting, written densely, teaches the format it bans. The banned-term table and its four rules are
  in **"Write for the operator, not for the graph"**, above the procedure — a hard requirement, not a
  style note.

  **Order: `active` threads first; within them, by what disappears if you don't act.** A `parked`
  thread emits **no action** — it emits one line naming the single thing that would revive it.

  Two orderings are wrong, in opposite directions. Ranking by *deadline hardness* lets a hard external
  deadline bury every strategy item — it always wins, so `#671`-shaped work would sit permanently on
  top. Ranking purely by *what evaporates* promotes a **parked** thread above a running one, because a
  dormant thread's self-imposed kill-clock evaporates loudest of all — and that is a symptom of the
  thread being dead, not a reason to work it. So: `active` first (the `delivered::` cadence says which
  thread is live), and only then by what evaporates. **Read your own evidence** — do not rank a thread
  above another on the same page where you printed one's cadence at 0 and the other's at 5.

  A hard external deadline is a **capacity note**, never a competitor: `issue-triage` ranks it.

  **Never let an exploratory artefact make an action look executable** (rule 4 of the vocabulary). If a
  thread's next step rests on a choice with no `decision_*` page, the next step *is that decision* — say
  so, and do not dress a diligence lead-list up as a plan.

  **Inputs present ≠ startable. Open the issue and read its OWN gate first.** A gate is not an input,
  and the input vocabulary below cannot express it — so an issue can have every input resolved and
  still be forbidden. Look for `Status: BACKLOG`, `DO NOT start`, `Build gate`, `signal-gated`,
  `ON HOLD` in the body. If one is there, that **issue** is not the do-next no matter how ready it
  looks. Never let an initiative page's "no blocking prerequisites" stand in for reading the issue:
  the page states technical readiness, the issue states permission.

  **A gate on ONE slice silences that slice, never the thread.** Having found a gate, walk the rest of
  `advances::` and gate-check each — the do-next is the first UNGATED slice that serves the stated
  bottleneck. Only if **every bottleneck-serving slice** is gated does the thread emit no action, and
  then you must say **who fires the trigger**: a trigger nobody owns is not "waiting", it is a thread
  that will sit `active` forever with no action, which is `parked` wearing the wrong label — say that
  outright. (This is intra-thread slice selection; it feeds the active-first thread ordering above.)

  Both rules come from the same brief, in two failed drafts (2026-07-17). First it ranked **#861**
  first because `initiative_growth` said *"착수 가능, 막는 선행 항목 없음"* — true about inputs, while
  the issue's first line said `Status: BACKLOG — do NOT start`; the brief never opened it (→ rule 1).
  Corrected to "read the gate", the next draft found #861 gated and declared "Growth emits no action" —
  never checking that **#887/#270/#346 carry no gate at all**, nor that #861's trigger can only fire
  from the *parked* monetization thread's outreach, so nobody will (→ rule 2). Both drafts were true
  and useless: one recommended forbidden work, the other said to wait for something nobody would cause.

  **Every do-next line must be executable on reading.** Before you write one, resolve its inputs —
  open the issue and list which boxes are actually unticked; look in `discovery/` before claiming a
  draft is missing; grep the code before calling a checkbox done; **and check for an in-flight PR on
  that slice (the open-PR rule below)**. Then:
  - If an input is **missing**, the line is not that action — it is the missing input. Rank *that*.
  - If inputs are present, **show them** (the five leads, the three unticked boxes) rather than naming
    the work abstractly. "Sync the bodies" is an instruction; the eight adjudicated boxes are a plan.
  - **Never invent a duration.** A cost you did not derive is a lie that then drives the ranking. Say
    in words what has to happen before anyone can estimate it — "얼마나 걸릴지는 X를 확인해야 안다" —
    and rank on the deadline instead. (Do NOT emit a bare `cost: unknown` field: that fragment is a field of
    the retracted template, and it appears in the worked example in "Write for the operator, not
    for the graph", above the procedure, as evidence of failure.)
  - **Check open PRs, not just merged code.** A grep of the *main-branch* file cannot see work that is
    written but not yet merged — it lives on a branch. When a slice's work looks undone,
    `gh pr list --state open` (grep its branch/title for the issue number) **before** ranking "do the
    work": an open PR means the do-next is *land the PR*, a smaller, different action. This is the
    review-time face of the start-of-work rule `feedback_check_existing_pr` (#406) — a main-branch read
    misses in-flight PRs in both directions (start-of-work risks *duplicating* one; here it risks
    mis-ranking finished work as *undone*). (2026-07-23: a brief ranked "add `?utm_source=reddit` to
    the playbook" first after that grep on main came back empty — PR #1135 had already made exactly
    that edit and was open for review.)
  A brief that says "choose" or "sync" without its inputs has moved the work from the page to the
  reader, which is precisely the reconstruction cost this skill exists to remove.
- **Per-initiative detail** — for each: what shipped since the last review (`delivered::`, with the
  count as a resource signal), what remains (`advances::`), the `Next action` verbatim, and the
  governing decision(s) inline. **The `Next action` quote is the one sanctioned place internal wording
  may appear** — it is a quotation of the page, and altering it would misrepresent the record. Quote it
  in this lower-altitude detail block; the top-of-brief do-next states the same thing in plain language.
  Anything you quote in a field vocabulary gets a plain-language sentence beside it. Flag any initiative
  whose live work contradicts an `active` decision.
- **Decisions to revisit** — every `Status: revisit` past its trigger date/condition, plus any
  `superseded` decision whose dependent issues/pages weren't updated (a silent contradiction).

  **A trigger can be replaced. Read the current one, never a retired date.** `decision_outage_cta_channel`
  swapped a bare date for three data-conditions; a reader who matched on the old date would have flipped
  a decision whose evidence does not yet exist. If a page states both, the later statement governs — and
  an outstanding `verify-after` ping for the retired date is a *reminder to check the conditions*, not
  a mandate to decide. If the conditions are unmet, defer the date and say so.

### 5. Sync the Discord mirror (only if the active thread's Status / Next action moved)
The weekly Discord briefing renders a `📈 Strategy` section from the `strategy:brief` KV key (#1013) —
the worker cannot read this memory bundle, so that key is the bridge. This skill is the one moment the
active initiative's `Status` + `Next action` are freshly re-derived, so it is where the mirror gets
re-synced; otherwise the briefing's 30-day staleness guard eventually fires a refresh nudge.

- Do this **only when the active initiative's `Status` or `Next action` changed** in this review (a new
  `delivered::`, a moved bottleneck, a new `Next action`). No change → skip; a re-write with the same
  text only resets `updatedAt` and hides genuine staleness.
- Mirror the **active** thread (the one whose cadence says it is live). `status` ≈ its `Status` headline,
  `nextAction` ≈ its `Next action` in one sentence — **each ≤600 chars** (`STRATEGY_FIELD_MAX`, or the
  briefing truncates with `…`). `updatedAt` = today (`YYYY-MM-DD`).
- It is a **production KV write**, so *emit the command, do not run it* — propose it and let the operator
  confirm (write the JSON to a temp file to dodge shell-escaping, `--remote` to hit prod, not the local
  simulator):
  ```bash
  cat > /tmp/strategy-brief.json <<'JSON'
  { "status": "<Status headline ≤600>", "nextAction": "<Next action ≤600>", "updatedAt": "YYYY-MM-DD" }
  JSON
  npx wrangler kv key put --namespace-id e49508d80bb144e9a7ff872f2be771a4 --remote strategy:brief --path /tmp/strategy-brief.json
  ```
- After a confirmed write, update the `initiative_*` page's `Discord 미러` line's "마지막 세팅" date so
  the page and the KV key don't silently drift apart.

## Output norms
- One brief, two altitudes (summary do-next on top, initiative detail below) — the shape this skill's
  originating session (#917) prototyped.
- **Before emitting, re-read the brief as the operator** — specifically against the banned-term table in
  "Write for the operator, not for the graph" (above the procedure). Any sentence that needs this
  SKILL.md open to parse gets rewritten. This check is not optional — the skill failed it on 2026-07-20
  while satisfying every other norm in this file.
- Cite nodes by their memory slug / issue number so the brief is traceable back into the graph.
- **Separate what is verified from what is read.** "These 7 slices are OPEN" is checkable and checked
  (`npm run lint:graph -- --github`, #967). "These are the *right* 7" is a dated hand reading — an issue
  can be listed, live, and still not advance the initiative, and the lint deliberately does not judge
  that. Never let one sentence carry both claims; the reader cannot tell which half to trust.
- Run `npm run lint:graph -- --github` before the brief. Structural findings mean the graph is wrong
  and the brief will inherit it. Its **unclaimed candidates** are input to step 2's judgement, not a
  defect list — resolve each into the initiative page or leave it out on purpose.
- **A green lint does not mean the graph is complete.** It checks the edges that exist; a *missing*
  edge is judgement and exits 0. #986 — the issue the entire growth do-next rested on — sat in the
  unclaimed list with `0 structural findings` printed above it, and the brief that ranked it first
  never noticed it had no `advances::` edge. Read the candidate list before you trust the tick.
- If a priority call rests on a decision that's gone stale (its context changed), say so and route it
  to "decisions to revisit" rather than silently recommending against it.
- Do NOT mutate issues/labels here (that's issue-triage's job on confirmation) — this is a read +
  synthesize pass. If the review surfaces a NEW durable decision, capture it as a `type:decision` page
  (via memory-ingest), don't leave it only in the brief.

## Why this is a skill
Same rationale as issue-triage / ship-issue: a periodic fusion ritual described only in CLAUDE.md gets
skipped on long sessions / after compaction. Invoking this re-injects the procedure + the decision-graph
traversal at the moment you're deciding what to do next. The decision graph it reads is the durable
layer; this skill is the traversal engine over it.
