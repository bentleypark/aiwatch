# Privacy Policy — AIWatch · Claude Status (Chrome extension)

**Last updated:** July 2026

> This is the source copy. The public, Web-Store-linkable version is served at
> **https://ai-watch.dev/extension-privacy** (`api/extension-privacy.ts`). Keep the two in sync.
>
> **This policy covers the Chrome extension ONLY.** It is separate from the
> [ai-watch.dev](https://ai-watch.dev) website policy (`src/components/LegalContent.jsx`): unlike
> the website, the extension uses **no analytics, no cookies, and does not read any web page**.

The AIWatch — Claude Status Chrome extension is designed to collect **no personal data**.

## What the extension does
- Polls the **public AIWatch status API** (`aiwatch-worker.p2c2kbf.workers.dev`) approximately
  every 2 minutes (and when you open the popup) to show the current status of Claude API,
  claude.ai, and Claude Code in the toolbar and popup.
- Caches the most recent **public status response** locally (`chrome.storage.local`) so the popup
  loads instantly — public service-status data only, never anything about you.
- When you explicitly click **"Report an issue"**, sends an anonymous report containing only: the
  surface you picked (Claude API / claude.ai / Claude Code), a problem category, and an optional
  short note you type.

## What the extension does NOT do
- It does **not** read, access, or modify the content of claude.ai or any web page (no content
  scripts, no `tabs`/`<all_urls>` permission).
- It does **not** collect browsing history, conversations, IP-linked identity, cookies, or any PII.
- It uses **no** analytics, advertising, fingerprinting, or third-party trackers, and executes
  **no** remote code.

## Data the extension transmits
It communicates with exactly one server — the AIWatch API — and sends only:
- **Outbound status polls** (GET) — no personal data, no identifiers.
- **User-initiated issue reports** — only when you click "Report an issue". Anonymous (no account
  or identifier attached), rate-limited per source server-side, used only as an aggregate
  community reliability signal. The optional free-text note is whatever you type; please do not
  include personal information.

## Data storage & retention
- **On your device:** the cached public status payload + popup preferences stay in
  `chrome.storage.local` until you clear them or uninstall the extension.
- **On the server:** issue reports are stored anonymously with short lifetimes (per-day counts and
  an ~7-day recent-report window), used only in aggregate, and not linked to you.

## Permissions
- `alarms` — schedule the periodic background status refresh.
- `storage` — cache the public status payload locally for instant popup display.
- `host_permissions` (the AIWatch API origin only) — fetch status and post anonymous reports; no
  access to claude.ai or any site you visit.

## Third-party services
Only the AIWatch API (served via Cloudflare Workers). Nothing is shared with any other party; no
analytics or advertising SDKs.

## Your rights
No PII is collected, so there is no personal profile to access or delete. Reports are anonymous and
cannot be linked to an individual. Uninstalling the extension removes all locally stored data.

## Children's privacy
The extension is not directed to, and does not knowingly collect information from, children under 14.

## Changes to this policy
We may update this policy if the extension's practices change; the "Last updated" date reflects any
revision.

## Contact
For privacy inquiries, contact **contact@ai-watch.dev** or see https://ai-watch.dev.
