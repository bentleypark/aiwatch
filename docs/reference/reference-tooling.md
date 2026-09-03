---
type: reference
title: "Reference Tooling — chub + modern-web-guidance + the decision-moment backstop"
description: "Which of chub vs modern-web-guidance to run by file path, and the tooling-trigger.sh PreToolUse backstop."
tags: [workflow, tooling, chub]
---

# Reference Tooling — chub + modern-web-guidance + the decision-moment backstop

AIWatch wires two external "reference" tools that ground code in current sources instead of
training-cutoff memory. Both carry their own model-invoked skill triggers, but those are passive
context = probabilistic compliance (the #415 failure mode that left chub "documented but unused").
So a deterministic PreToolUse hook reinforces them at the moment a relevant file is edited.

## The two tools

### chub (Context Hub) — `get-api-docs` skill
External API/SDK/library **ground-truth**. Fetch current docs **before** writing code against an
external service. Full flow, AIWatch stack coverage, and the Cloudflare/Anthropic footguns are in
**CLAUDE.md → "API Docs via Context Hub (chub)"**. Quick flow:

```bash
chub search "<keywords>" --json   # find the doc id
chub get <id> --lang js           # fetch (always pass --lang)
chub annotate <id> "<gotcha>"     # save project-specific battle scars
```

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

## Which tool, when (the trigger map)

`.claude/hooks/tooling-trigger.sh` (PreToolUse / `Edit|Write|MultiEdit`) inspects the target
`file_path` and emits a **soft** `hookSpecificOutput.additionalContext` reminder (exit 0, never blocks) — the deterministic
backstop for the two skills' probabilistic triggers:

| Editing this surface | Run BEFORE coding |
|---|---|
| `worker/src/parsers/**`, `services.ts`, `ai-analysis.ts`, `changelog.ts`, `security-monitor.ts`, `platform-monitor.ts`, `reddit.ts`, `package.json` (external API / SDK / Cloudflare binding) | **chub** (`get-api-docs`) — current API shape |
| `src/components/**`, `src/pages/**`, `*.jsx`, `*.css`, Edge SSR `*html-template.ts`, `api/is-down.ts`, `api/intro.ts` (markup / styles / UI components) | **modern-web-guidance** skill — a11y / CWV / Baseline |
| anything else — incl. non-UI client logic (`src/utils/*.js`, `src/hooks/*.js`), backend/score logic, and `*__tests__*` / `*.test.*` / `*.spec.*` | (silent — no reminder) |

> Scope note: the frontend arm targets **markup/styles/UI components**, not all client-side JS — pure
> logic/data modules (`src/utils`, `src/hooks`, `src/locales`) and test files stay silent on purpose
> (they don't involve web-platform APIs). Globs are soft + logged as `inject`; widen them only if the
> audit log shows real misses.

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
