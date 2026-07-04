# Chrome Web Store listing — AIWatch · Claude Status

> Single source of truth for the store listing. Copy-paste into the Chrome Developer
> Dashboard at publish time. **Last updated:** 2026-06-30.

## Identity
- **Name (store + `manifest.name`):** AIWatch — Claude Status & Down Detector  — keyword-rich for CWS search ("claude down detector" / "is claude down"). The in-app title stays clean: `action.default_title` (toolbar tooltip) + the popup header are "AIWatch — Claude Status", not the long store name.
- **Version:** 1.0.0 (`extension/manifest.json`)
- **Category:** Developer Tools
- **Primary purpose:** Show the live operational status of Anthropic's Claude surfaces
  (Claude API, claude.ai, Claude Code) in the toolbar, with a one-click issue report.

## Short description (≤132 chars — this IS the manifest `description`, pinned by lib/manifest.test.js)
Live Claude API, claude.ai & Claude Code status in your toolbar — uptime, incidents, AIWatch Score & one-click issue report.

## Detailed description (PLAIN TEXT — the Chrome Web Store does NOT render Markdown; keep zero `**`)
Is Claude down? AIWatch — Claude Status shows the real-time status of Anthropic's Claude services right in your browser toolbar — Claude API, claude.ai, and Claude Code.

A colored dot (green / amber / red) shows the current worst-case status at a glance. Open the popup for each surface:
• Live status + 30-day uptime + the AIWatch reliability Score
• Active incidents, with an AI-written summary of what's happening
• A recommended fallback to switch to when a service is down
• Community reports + one-click "Report an issue"

Hit a problem? One click sends an anonymous report that feeds AIWatch's crowd-corroboration signal — it never overrides official status on its own.

Privacy — how it works (and what it does NOT do):
• Polls the public AIWatch status API about every 2 minutes (and when you open the popup). That is its ONLY data source.
• Does NOT read, modify, or access claude.ai or any web page.
• Collects NO personal data — no browsing history, no conversations, no analytics, no cookies.

Permissions are minimal: alarms + storage + access to the AIWatch API only — no access to the sites you visit.

Open source (AGPL): https://github.com/bentleypark/aiwatch
Full dashboard: https://ai-watch.dev
Privacy policy: https://ai-watch.dev/extension-privacy

## Listing fields (dashboard)
- **Category:** Developer Tools (fallback: Productivity)
- **Default language:** English (United States)
- **Homepage / Official URL:** https://ai-watch.dev
- **Support URL:** https://github.com/bentleypark/aiwatch/issues
- **Privacy policy URL:** https://ai-watch.dev/extension-privacy
- **Contact email:** contact@ai-watch.dev

## Permissions justification (review team reads this — be specific)
| Permission | Why it is needed |
|---|---|
| `alarms` | Schedule a periodic (every 2 minutes) background status poll. MV3 service workers are ephemeral, so `chrome.alarms` is the supported way to wake the worker to refresh the toolbar badge. |
| `storage` | Cache the last fetched status payload (`chrome.storage.local`) so the popup paints instantly on open without waiting for the network. No personal data is stored — only the public status JSON. |
| `host_permissions: https://aiwatch-worker.p2c2kbf.workers.dev/*` | The extension fetches the public AIWatch status projection and posts anonymous issue reports to the AIWatch API at this one origin. This is the ONLY host the extension can reach. It grants NO access to claude.ai or any site the user visits. |

No `tabs`, no `<all_urls>`, no content scripts, no `scripting`, no remote code.

## Privacy / data use disclosure
> **Accuracy note (matters for review):** do NOT declare a blanket "collects no data." The
> extension DOES transmit a user-submitted report when the user clicks "Report an issue" — a
> reviewer will see that POST, so the disclosure + privacy policy must acknowledge it. Declare the
> **sensitive data categories as NOT collected** (true — see below) while disclosing the voluntary
> report. The privacy policy at `/extension-privacy` states the same.

- **Sensitive/personal data categories collected:** **NONE.** No PII, no health/financial/auth
  data, no location, no web history, no user-activity monitoring, no website content (no page
  reading). Check "does not collect" for every category in the data-use form.
- **What IS transmitted** (declare honestly): (a) outbound GET status polls (no identifiers), and
  (b) **user-initiated, anonymous issue reports** (`{surface, category, optional free-text note}`)
  sent ONLY when the user clicks "Report an issue" — no account/identifier, IP-rate-limited
  server-side, aggregated as a community reliability signal.
- **Certifications:** not sold/transferred to third parties; not used for purposes unrelated to the
  single purpose; not used for creditworthiness/lending — all **true** (check each).
- No cookies, no analytics, no tracking, no remote code, no page content access.
- **Privacy policy URL (LIVE):** `https://ai-watch.dev/extension-privacy` (served by
  `api/extension-privacy.ts`; source copy in `extension/PRIVACY.md`). Enter this in the dashboard.
- **Contact email:** `contact@ai-watch.dev`.

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
