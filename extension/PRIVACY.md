# Privacy Policy — AIWatch · Claude Status (Chrome extension)

**Last updated:** 2026-06-30

AIWatch — Claude Status is designed to collect **no personal data**. This policy explains
exactly what the extension does and does not do.

## What the extension does
- Polls the **public AIWatch status API** (`https://aiwatch-worker.p2c2kbf.workers.dev`)
  every few minutes to show the current status of Claude API, claude.ai, and Claude Code
  in the toolbar and popup.
- Caches the most recent **public status response** locally (`chrome.storage.local`) so the
  popup loads instantly. This contains only public service-status data — never anything about you.
- When you explicitly click **"Report an issue"**, it sends an anonymous report to the AIWatch
  API containing only: the surface you picked (Claude API / claude.ai / Claude Code), a problem
  category, and an optional short note you type. No identifiers are attached.

## What the extension does NOT do
- It does **not** read, access, or modify the content of claude.ai or any other web page.
  It has no content scripts and no `tabs`/`<all_urls>` permissions.
- It does **not** collect, store, or transmit your browsing history, conversations, IP-linked
  identity, cookies, or any personally identifiable information.
- It does **not** use analytics, advertising, fingerprinting, or any third-party trackers.
- It does **not** execute remote code.

## Data sharing
The extension communicates with exactly one server — the AIWatch API — and shares nothing with
any other party. Issue reports are aggregated server-side as a community reliability signal and
are rate-limited per source; they are not used to identify or profile individuals.

## Permissions
- `alarms` — schedule the periodic background status refresh.
- `storage` — cache the public status payload locally for instant popup display.
- `host_permissions` (AIWatch API origin only) — fetch status and post anonymous reports.

## Contact
Questions: open an issue at https://github.com/bentleypark/aiwatch or see https://ai-watch.dev.
