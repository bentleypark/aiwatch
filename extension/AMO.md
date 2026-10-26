# Firefox Add-ons (AMO) listing — AIWatch · Claude Status

> Source for the addons.mozilla.org listing (#1773). Same package as the Chrome Web Store build
> (`CHROMEWEBSTORE.md` holds the shared version history). **Last updated:** 2026-10-26.

## Identity
- **Name (`manifest.name`):** AIWatch — Claude Status & Down Detector
- **Add-on id (`browser_specific_settings.gecko.id`):** `claude-status@ai-watch.dev` — permanent once
  the first version is uploaded.
- **Minimum Firefox:** 140.0 (`strict_min_version`), the first version with the built-in data-consent
  experience `data_collection_permissions` needs. Desktop only; no `gecko_android` entry.
- **Version:** 1.3.0 (`extension/manifest.json`)
- **License:** GNU Affero General Public License v3.0 (`LICENSE`)

## Summary
Live Claude API, claude.ai & Claude Code status in your toolbar — uptime, incidents, AIWatch Score & one-click issue report.

## Description
Is Claude down? AIWatch — Claude Status shows the real-time status of Anthropic's Claude services in your toolbar: Claude API, claude.ai and Claude Code.

A colored dot (green / amber / red) shows the current worst-case status. Open the popup for each surface:
- Live status, 30-day uptime and the AIWatch reliability Score
- Current incidents with an AI analysis: what is happening, estimated recovery, past recovery times, and how the estimate compared once resolved
- A recommended fallback to switch to when a service is down
- Community reports and one-click "Report an issue"
- A summary of the latest AIWatch monthly reliability report

What it sends, and when:
- Every 2 minutes (and when you open the popup) it fetches the public AIWatch status API. The request carries no identifier and nothing about you.
- Only when you click "Send report", it sends the surface, the problem category and the optional note you typed to the AIWatch API. No account, no ID. The form says so next to the button.
- It does not read or change claude.ai or any web page, and uses no analytics and no cookies.

Firefox lets you turn off the add-on's access to the AIWatch API. Status still loads without it; the popup shows an "Allow access to AIWatch" button so reports can be sent again.

Open source (AGPL): https://github.com/bentleypark/aiwatch
Full dashboard: https://ai-watch.dev

## Listing fields
- **Homepage:** https://ai-watch.dev
- **Support site:** https://github.com/bentleypark/aiwatch/issues
- **Support email:** contact@ai-watch.dev
- **Privacy policy:** https://ai-watch.dev/extension-privacy (covers Chrome and Firefox)

## Data collection (`data_collection_permissions`)
- Declared: `"required": ["none"]`.
- Basis: the status poll carries no user data. The report is sent only on a click of the labelled
  "Send report" button, contains only what the user picked and typed (plus a fixed `source: 'ext'`
  tag), and the form states what is
  sent and to whom. That is the implicit-consent case of Mozilla's add-on policy, section 6.2.2.2:
  a single deliberate user command, disclosed in the listing and at the point of interaction, with
  no identifiers attached.
- Reviewers may still ask for explicit consent (condition 5 of that section). If they do, declare
  the report as an optional category instead of changing the report contents.

## Notes for reviewers
- No build step, no minification, no remote code: the uploaded files are the repository's
  `extension/` sources as they are.
- `background` lists both `service_worker` (Chrome) and `scripts` (Firefox event page) for the same
  file. `web-ext lint` reports `/background/service_worker` as unsupported; that is the expected
  warning for this cross-browser form.

## Pre-submit checklist (manual)
- [ ] `npx web-ext lint --source-dir extension` shows 0 errors (ignoring the files `CHROMEWEBSTORE.md` excludes from the ZIP).
- [ ] ZIP the same file set as the Chrome build (see `CHROMEWEBSTORE.md`), production `config.js` and
      `host_permissions`.
- [ ] Screenshots of the popup (operational + an incident state).
- [ ] Privacy policy URL is live and names Firefox.
