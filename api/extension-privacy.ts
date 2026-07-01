// Vercel Edge Function — /extension-privacy page (#837)
//
// Public, directly-linkable privacy policy for the AIWatch **Chrome extension**, required by
// the Chrome Web Store (a reviewer visits the URL). It is SEPARATE from the website privacy
// policy (src/components/LegalContent.jsx, shown as a modal): the extension uses NO analytics,
// NO cookies, and does not read web pages — so the website policy would not accurately describe
// it. Self-contained SSR (no data fetch), no inline script → trivially CSP-clean. Mirrors
// api/methodology.ts (per-response nonce + own enforcing CSP, #482 Phase 3).

import { generateNonce, buildCsp } from './_shared/csp-nonce'

export const config = { runtime: 'edge' }

const CONTACT = 'contact@ai-watch.dev'
const UPDATED = 'July 2026'

export function renderExtensionPrivacyPage(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Privacy Policy — AIWatch Claude Status (Chrome extension)</title>
<meta name="description" content="Privacy policy for the AIWatch Claude Status Chrome extension. No analytics, no cookies, no page reading — it only polls the public AIWatch status API.">
<link rel="canonical" href="https://ai-watch.dev/extension-privacy">
<meta name="robots" content="index, follow">
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; background: #080c10; color: #e6edf3; font: 16px/1.65 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
  main { max-width: 760px; margin: 0 auto; padding: 48px 20px 80px; }
  h1 { font-size: 28px; margin: 0 0 4px; }
  h2 { font-size: 19px; margin: 32px 0 8px; color: #e6edf3; }
  .updated { color: #8b949e; font-size: 14px; margin: 0 0 8px; }
  .lead { color: #adbac7; }
  p, li { color: #cdd9e5; }
  ul { padding-left: 22px; }
  li { margin: 4px 0; }
  a { color: #58a6ff; }
  code { background: #161b22; border: 1px solid #21262d; border-radius: 4px; padding: 1px 5px; font-size: 90%; }
  .note { background: #11161c; border: 1px solid #21262d; border-left: 3px solid #58a6ff; border-radius: 6px; padding: 12px 14px; margin: 16px 0; color: #adbac7; font-size: 14px; }
  footer { margin-top: 48px; border-top: 1px solid #21262d; padding-top: 16px; color: #8b949e; font-size: 13px; }
  footer a { color: #58a6ff; }
</style>
</head>
<body>
<main>
  <h1>Privacy Policy — AIWatch Claude Status</h1>
  <p class="updated">Chrome extension · Last updated: ${UPDATED}</p>
  <p class="lead">The <strong>AIWatch — Claude Status</strong> Chrome extension is designed to collect <strong>no personal data</strong>. This policy explains exactly what it does and does not do.</p>

  <div class="note">This policy covers the <strong>Chrome extension only</strong>. It is separate from the <a href="https://ai-watch.dev">ai-watch.dev</a> website policy: unlike the website, the extension uses <strong>no analytics, no cookies, and does not read any web page</strong>.</div>

  <h2>1. What the extension does</h2>
  <ul>
    <li>Polls the <strong>public AIWatch status API</strong> (<code>aiwatch-worker.p2c2kbf.workers.dev</code>) approximately every 2 minutes (and when you open the popup) to show the current status of Claude API, claude.ai, and Claude Code in the toolbar and popup.</li>
    <li>Caches the most recent <strong>public status response</strong> locally (<code>chrome.storage.local</code>) so the popup loads instantly. This contains only public service-status data — never anything about you.</li>
    <li>When you explicitly click <strong>"Report an issue"</strong>, sends an anonymous report to the AIWatch API containing only: the surface you picked (Claude API / claude.ai / Claude Code), a problem category, and an optional short note you type.</li>
  </ul>

  <h2>2. What the extension does NOT do</h2>
  <ul>
    <li>It does <strong>not</strong> read, access, or modify the content of claude.ai or any web page (no content scripts, no <code>tabs</code>/<code>&lt;all_urls&gt;</code> permission).</li>
    <li>It does <strong>not</strong> collect your browsing history, conversations, IP-linked identity, cookies, or any personally identifiable information.</li>
    <li>It uses <strong>no</strong> analytics, advertising, fingerprinting, or third-party trackers, and does <strong>not</strong> execute remote code.</li>
  </ul>

  <h2>3. Data the extension transmits</h2>
  <p>The extension communicates with exactly one server — the AIWatch API — and sends only:</p>
  <ul>
    <li><strong>Outbound status polls</strong> (GET) — no personal data, no identifiers.</li>
    <li><strong>User-initiated issue reports</strong> — only when you click "Report an issue". The report is <strong>anonymous</strong> (no account, no identifier attached), rate-limited per source on the server, and aggregated only as a community reliability signal. The optional free-text note is whatever you choose to type; please do not include personal information.</li>
  </ul>

  <h2>4. Data storage &amp; retention</h2>
  <ul>
    <li><strong>On your device:</strong> the cached public status payload and your popup preferences stay in <code>chrome.storage.local</code> until you clear them or uninstall the extension.</li>
    <li><strong>On the server:</strong> issue reports are stored anonymously with short lifetimes (per-day counts and an approximately 7-day recent-report window) and are used only in aggregate. They are not linked to you.</li>
  </ul>

  <h2>5. Permissions</h2>
  <ul>
    <li><code>alarms</code> — schedule the periodic background status refresh.</li>
    <li><code>storage</code> — cache the public status payload locally for instant popup display.</li>
    <li><code>host_permissions</code> (the AIWatch API origin only) — fetch status and post anonymous reports. This grants no access to claude.ai or any site you visit.</li>
  </ul>

  <h2>6. Third-party services</h2>
  <p>The extension talks to only the AIWatch API (served via Cloudflare Workers) and shares nothing with any other party. There are no analytics or advertising SDKs.</p>

  <h2>7. Your rights</h2>
  <p>Because the extension collects no personally identifiable information, there is no personal profile to access or delete. Reports are anonymous and cannot be linked to an individual. Uninstalling the extension removes all locally stored data.</p>

  <h2>8. Children's privacy</h2>
  <p>The extension is not directed to, and does not knowingly collect information from, children under the age of 14.</p>

  <h2>9. Changes to this policy</h2>
  <p>We may update this policy if the extension's practices change; the "Last updated" date above will reflect any revision.</p>

  <h2>10. Contact</h2>
  <p>For privacy inquiries, contact <a href="mailto:${CONTACT}">${CONTACT}</a>.</p>

  <footer>
    <a href="https://ai-watch.dev">AIWatch Dashboard</a> · <a href="https://github.com/bentleypark/aiwatch">Open source (AGPL)</a>
  </footer>
</main>
</body>
</html>`
}

export default async function handler(_req: Request) {
  try {
    // #482 — per-response nonce + own ENFORCING CSP (mirrors api/methodology.ts). The page has no
    // inline script, so it's CSP-clean regardless; the nonce keeps parity with the other Edge pages.
    const nonce = generateNonce()
    const csp = buildCsp(nonce, { enforce: true })
    return new Response(renderExtensionPrivacyPage(), {
      status: 200,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        // Static content → cacheable at the edge (unlike the nonce-inline pages; no inline script
        // here means a shared nonce across cached visitors carries no XSS risk).
        'Cache-Control': 'public, max-age=3600, s-maxage=86400',
        [csp.key]: csp.value,
      },
    })
  } catch (err) {
    console.error('[extension-privacy] Render failed:', err instanceof Error ? err.stack : err)
    return new Response(
      '<!DOCTYPE html><html><head><meta charset="UTF-8"><title>AIWatch</title></head><body style="background:#080c10;color:#e6edf3;font-family:sans-serif;text-align:center;padding:60px"><h1>Something went wrong</h1><p>Please visit <a href="https://ai-watch.dev" style="color:#58a6ff">AIWatch</a>.</p></body></html>',
      { status: 500, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' } },
    )
  }
}
