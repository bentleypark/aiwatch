# Chrome Web Store listing — AIWatch · Claude Status

> Single source of truth for the store listing. Copy-paste into the Chrome Developer
> Dashboard at publish time. **Last updated:** 2026-06-30.

## Identity
- **Name:** AIWatch — Claude Status
- **Version:** 1.0.0 (`extension/manifest.json`)
- **Category:** Developer Tools
- **Primary purpose:** Show the live operational status of Anthropic's Claude surfaces
  (Claude API, claude.ai, Claude Code) in the toolbar, with a one-click issue report.

## Short description (≤132 chars)
Live Claude status in your toolbar — uptime, incidents, AIWatch Score, and a one-click issue report. No page access.

## Detailed description
AIWatch — Claude Status puts the real-time health of Anthropic's Claude services in your
browser toolbar. A colored dot shows the current worst-case status across **Claude API,
claude.ai, and Claude Code**; open the popup for each surface's status, AIWatch Score,
active incidents (with an AI summary), community report counts, and a recommended
fallback when something is down.

Hit a problem? One click sends an anonymous "Report an issue" that feeds AIWatch's
crowd-corroboration signal — it never overrides official status on its own.

How it works (and what it does NOT do):
- It polls the public AIWatch status API every few minutes. That is its ONLY data source.
- It does **not** read, modify, or access the content of claude.ai or any web page.
- It collects **no** personal data, no browsing history, no conversations.

Open-source: https://github.com/bentleypark/aiwatch · Full status: https://ai-watch.dev

## Permissions justification (review team reads this — be specific)
| Permission | Why it is needed |
|---|---|
| `alarms` | Schedule a periodic (every 2 minutes) background status poll. MV3 service workers are ephemeral, so `chrome.alarms` is the supported way to wake the worker to refresh the toolbar badge. |
| `storage` | Cache the last fetched status payload (`chrome.storage.local`) so the popup paints instantly on open without waiting for the network. No personal data is stored — only the public status JSON. |
| `host_permissions: https://aiwatch-worker.p2c2kbf.workers.dev/*` | The extension fetches the public AIWatch status projection and posts anonymous issue reports to the AIWatch API at this one origin. This is the ONLY host the extension can reach. It grants NO access to claude.ai or any site the user visits. |

No `tabs`, no `<all_urls>`, no content scripts, no `scripting`, no remote code.

## Privacy / data use disclosure
- **Does this item collect user data?** No.
- The extension transmits only: (a) outbound GET polls to the AIWatch status API, and
  (b) optional, user-initiated anonymous issue reports (`{surface, category, optional note}`)
  — no identifiers, IP-rate-limited server-side, used only as an aggregate reliability signal.
- It does not use cookies, analytics, or any tracking, and does not read page content.
- **Privacy policy URL:** host `extension/PRIVACY.md` at a public URL (e.g.
  `https://ai-watch.dev/extension-privacy`) and enter it in the dashboard before submitting.

## Pre-publish checklist (manual)
- [ ] At least one screenshot at 1280×800 (or 640×400) — capture the popup (operational +
      an incident state). Not committed to the repo; produced at publish time.
- [ ] Privacy policy URL is live and matches the data-use disclosure above.
- [ ] ZIP the `extension/` directory EXCLUDING `*.test.js`, `lib/render.test.js`,
      `CHROMEWEBSTORE.md`, and any local-dev `config.js` override (WORKER_BASE must be the
      production worker origin; no `localhost` in `host_permissions`).
- [ ] `manifest.json` version bumped if re-submitting.

## Version history
- **1.0.0** (2026-06-30) — Initial release. Badge + popup for Claude API / claude.ai /
  Claude Code (status, Score, active incidents, gated community reports, fallback) +
  one-click issue report. Polls the AIWatch `?src=ext-claude` projection; no page access.
