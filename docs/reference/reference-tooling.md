---
type: reference
title: "Reference Tooling — API docs, live upstreams, modern-web-guidance + the decision-moment backstop"
description: "Where to get ground truth before coding (first-party skill, context7, live upstream, modern-web-guidance), the tooling-trigger.sh file-path map, and the project gotchas docs do not carry."
tags: [workflow, tooling, context7]
---

# Reference Tooling — API docs, live upstreams, modern-web-guidance + the decision-moment backstop

AIWatch grounds code in current sources instead of training-cutoff memory. The tools below carry
their own model-invoked triggers, but those are passive context = probabilistic compliance (the #415
failure mode). So a deterministic PreToolUse hook reinforces them at the moment a relevant file is
edited.

## Sources of ground truth

### API / SDK / binding docs — first-party skill, then context7
1. **First-party skill, when one covers it**: `cloudflare`, `workers-best-practices`, `wrangler`
   (Worker runtime, KV / Workers AI bindings, `wrangler.toml`); `claude-api` (Anthropic).
2. **context7** — MCP server wired in the tracked `.mcp.json`. Resolve the library id first, then query
   **one topic per call**; it returns topic-scoped snippets with their source URLs. Without a key it
   runs on the anonymous quota; export `CONTEXT7_API_KEY` (free key from the context7 dashboard) for
   the free-account one. `.mcp.json` expands it as `${CONTEXT7_API_KEY:-}`, and the server was checked
   to answer with the variable both unset and empty (2026-09-15).
3. WebFetch of the official doc page.

**Why not Context Hub (`chub`)** — the prior tool, dropped in #1410. On 2026-09-15 it answered none of
four questions with known answers from this codebase (KV `expirationTtl` minimum, Gemma 4
`enable_thinking`, Tailwind v4 layer order, current Claude model ids — the last one *wrongly*), while
context7 answered three fully and one partially. Observed causes: the registry content was months old
after `chub update`, `chub get` returns a whole file per library, and search ranked unrelated docs first.

**Paired local cutover (not part of the repo change).** The `get-api-docs` skill that drove chub is
installed user-globally (`~/.claude/skills/get-api-docs`), so merging #1410 does not remove it, and its
trigger text keeps directing Anthropic/SDK work to chub against the order above. Remove that skill
directory on each machine; the `chub` CLI (`npm uninstall -g @aisuite/chub`) and `~/.chub` can go with it.

### Status pages and feeds — the live upstream response
`worker/src/parsers/*`, `services.ts` and the monitors integrate third-party **status pages and feeds**.
No docs tool covers those; the ground truth is the response itself. Fetch it (curl / WebFetch) and
check its real shape before coding. A 403/429 is a bot block, not the page's state — retry in the
playwright MCP browser.

### modern-web-guidance — Claude Code plugin (Google Chrome marketplace)
Expert-vetted, **Baseline-current** skills for the web platform (accessibility, Core Web Vitals,
modern HTML/CSS/JS APIs). Install once — `/plugin` is a REPL command the user runs, not something
Claude can execute:

```
/plugin marketplace add GoogleChrome/modern-web-guidance
/plugin install modern-web-guidance@googlechrome
/reload-plugins
```

The `modern-web-guidance` skill auto-triggers on **HTML/CSS/client-JS** work — modals/dialogs,
container queries, `:has()`, View Transitions, scroll-driven animations, Core Web Vitals (LCP/INP),
forms/autofill, and React layout/style adaptation. Run it **first**, before hand-writing patterns
from memory (web APIs evolve faster than training weights). **Skip** for backend/SQL/ORM, CI/CD,
Docker, and generic local scripts. (The plugin also ships a `chrome-extensions` skill — not used by
AIWatch.)

## Project gotchas the docs do not carry

Docs give the API *shape*; these are verified in our code.

- **Workers AI response shape varies by model** — the doc's `response` field is not the only shape a
  model returns. Read the defensive parse in `ai-analysis.ts` before changing a model or that call.
- **Anthropic goes through the Cloudflare AI Gateway with raw `fetch()`** — no `@anthropic-ai/sdk`
  dependency (`worker/src/anthropic.ts`), so the REST request shape is the one that applies, not an
  SDK client's.
- **Cloudflare has two API layers** — Worker *runtime* APIs (bindings, `scheduled`, `wrangler.toml`)
  vs the REST *management* API (zones, DNS, script upload). `worker/src/*` code is the runtime layer.

## Which tool, when (the trigger map)

`.claude/hooks/tooling-trigger.sh` (PreToolUse / `Edit|Write|MultiEdit`) inspects the target
`file_path` and emits a **soft** `hookSpecificOutput.additionalContext` reminder (exit 0, never blocks) — the deterministic
backstop for the probabilistic triggers above:

| Editing this surface | Before coding | Audit note |
|---|---|---|
| `worker/src/parsers/**`, `services.ts`, `changelog.ts`, `security-monitor.ts`, `platform-monitor.ts`, `reddit.ts` (status pages / feeds) | fetch the **live upstream** response | `upstream:` |
| `worker/src/ai-analysis.ts`, `worker/src/anthropic.ts`, `package.json` (SDK / binding) | **first-party skill**, else **context7** | `docs:` |
| `src/components/**`, `src/pages/**`, `*.jsx`, `*.css`, Edge SSR `*html-template.ts`, `api/is-down.ts`, `api/intro.ts` (markup / styles / UI components) | **modern-web-guidance** skill — a11y / CWV / Baseline | `modern-web:` |
| anything else — incl. non-UI client logic (`src/utils/*.js`, `src/hooks/*.js`), backend/score logic, and `*__tests__*` / `*.test.*` / `*.spec.*` | (silent — no reminder) | — |

> Scope note: the frontend arm targets **markup/styles/UI components**, not all client-side JS — pure
> logic/data modules (`src/utils`, `src/hooks`, `src/locales`) and test files stay silent on purpose
> (they don't involve web-platform APIs). Globs are soft + logged as `inject`; widen them only if the
> audit log shows real misses. Audit entries before #1410 carry a `chub:` note for what is now split
> into `upstream:` and `docs:`. The routing is pinned by `scripts/tooling-trigger.test.mjs`.

Every fire is logged to `.claude/hook-audit.jsonl` as `inject` (`npm run hook-audit` summarizes). Soft
on purpose; if the audit shows the reminders are ignored, tighten the path globs or escalate. The hook
is wired in `.claude/settings.json` alongside the #415 gates — a new `settings.json` only takes effect
after `/hooks` is opened once or a restart.

## Why both layers
- **Skill trigger** (model-invoked): fires whenever the model recognizes a relevant *task* from the
  conversation — broad but probabilistic.
- **PreToolUse hook** (deterministic): fires whenever a relevant *file* is actually edited — precise,
  survives compaction, and is measurable via the audit log. Together they make the tools fire at the
  decision moment instead of sitting as inert documentation (the #415 lesson, applied to tooling).
