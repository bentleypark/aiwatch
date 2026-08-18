# AIWatch — Claude Code plugin

Know the moment an upstream AI provider breaks, right inside Claude Code.

[AIWatch](https://ai-watch.dev) monitors the real-time reliability of Claude, OpenAI, Gemini, and dozens of other AI services. This plugin surfaces that signal in your terminal so you can answer **"is it me, or is the provider down?"** without opening a browser tab.

## What you get

- **Outage monitor (background)** — a passive watcher that notifies Claude the moment a monitored provider goes **down** (`🔴 Claude API is down`) and again when it **recovers** (`✅ Claude API has recovered`), naming each service explicitly. It tracks which outages it has already announced, so it only speaks up on a real transition — never spams. This is the headline feature: you find out an outage is upstream *before* you burn time debugging your own code.
- **`/aiwatch` command** — on demand, briefs which AI services are degraded/down right now, each with its **active incident** (title + impact), an **AI summary** when available, and a **fallback** suggestion (or confirms all-clear). The briefing is rendered server-side, so the command stays a thin fetch.

The plugin **reads no code and collects no data** — it only polls AIWatch's public status endpoint. It is informational (Claude Code is Claude-only, so it can't switch providers for you), not a fallback router.

## Install

```
/plugin marketplace add bentleypark/aiwatch
/plugin install aiwatch@aiwatch-dev
```

Later, pull updates with:

```
/plugin marketplace update aiwatch-dev
```

Or test a local checkout without installing:

```
claude --plugin-dir ./plugin/aiwatch
```

The background monitor requires Claude Code v2.1.105 or later and an interactive session.

## Usage

- The **monitor** starts automatically when the plugin is enabled — no action needed. When a provider goes down you'll see `🔴 Claude API is down (AIWatch)`, and on recovery `✅ Claude API has recovered (AIWatch)` — one line per service, only on a real state change (never on an unchanged poll).
- Once AIWatch has **confirmed it cannot read** a provider's status source, the monitor stays quiet rather than guessing: it will not call that an outage, and — if the service was already down — it will not call it a recovery either. The `✅` still arrives once the source is readable again and the service is back. Run **`/aiwatch`** to see which sources are currently unreadable.
- Run **`/aiwatch`** any time for the current status.

## Configuration

Both scripts honor environment variables (useful for self-hosters of AIWatch):

| Variable | Default | Purpose |
|---|---|---|
| `AIWATCH_BASE` | `https://aiwatch-worker.p2c2kbf.workers.dev` | AIWatch Worker base URL — point at your own deployment to self-host |
| `AIWATCH_POLL_SECONDS` | `60` | Monitor poll interval |

## Privacy

- No page/code content is read. The plugin only sends a `GET` to AIWatch's public, unauthenticated status endpoint.
- No identifier is collected. AIWatch measures anonymous poll volume only.

## About

AIWatch is open-source under AGPL-3.0 — <https://github.com/bentleypark/aiwatch>. Dashboard: <https://ai-watch.dev>.
