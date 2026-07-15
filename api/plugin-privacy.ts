// Vercel Edge Function — /plugin-privacy page (#920)
//
// Public, directly-linkable privacy policy for the AIWatch **Claude Code plugin**, required by the
// Claude Code community marketplace submission (a reviewer visits the URL). It is SEPARATE from the
// website privacy policy (src/components/LegalContent.jsx, shown as a modal) AND from the Chrome
// extension policy (api/extension-privacy.ts): like the extension — and unlike the website — the
// plugin uses NO cookies, NO analytics SDK, and reads NO code or files; it only polls the public
// AIWatch status API. Self-contained SSR (no data fetch), no inline script → trivially CSP-clean.
// Mirrors api/extension-privacy.ts (per-response nonce + own enforcing CSP, cacheable static).

import { generateNonce, buildCsp } from './_shared/csp-nonce'

export const config = { runtime: 'edge' }

const CONTACT = 'contact@ai-watch.dev'
const UPDATED = 'July 2026'

export function renderPluginPrivacyPage(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Privacy Policy — AIWatch for Claude Code (plugin)</title>
<meta name="description" content="Privacy policy for the AIWatch Claude Code plugin. No cookies, no analytics SDK, no code reading — it only polls the public AIWatch status API.">
<link rel="canonical" href="https://ai-watch.dev/plugin-privacy">
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
  <h1>Privacy Policy — AIWatch for Claude Code</h1>
  <p class="updated">Claude Code plugin · Last updated: ${UPDATED}</p>
  <p class="lead">The <strong>AIWatch</strong> Claude Code plugin is designed to collect <strong>no personal data</strong>. This policy explains exactly what it does and does not do.</p>

  <div class="note">This policy covers the <strong>Claude Code plugin only</strong>. It is separate from the <a href="https://ai-watch.dev">ai-watch.dev</a> website policy: unlike the website, the plugin uses <strong>no cookies and no analytics SDK</strong>, and it reads <strong>none of your code or files</strong>.</div>

  <h2>1. What the plugin does</h2>
  <ul>
    <li>The <strong>background monitor</strong> polls the <strong>public AIWatch status API</strong> (<code>aiwatch-worker.p2c2kbf.workers.dev</code>) on an interval (approximately every 60 seconds) and notifies you when a monitored AI service goes down or recovers.</li>
    <li>The <strong><code>/aiwatch</code> command</strong> makes one request to the same public API to show which AI services are currently degraded or down, with each incident and a suggested alternative.</li>
    <li>The monitor keeps the most recent poll result in a temporary local file so it can detect a change between polls. This contains only public service-status data — never anything about you.</li>
  </ul>

  <h2>2. What the plugin does NOT do</h2>
  <ul>
    <li>It does <strong>not</strong> read, access, or transmit your code, files, prompts, or conversations. It only issues outbound <code>GET</code> requests to the AIWatch status API.</li>
    <li>It does <strong>not</strong> collect your identity, IP-linked profile, cookies, or any personally identifiable information.</li>
    <li>It uses <strong>no</strong> cookies, no analytics SDK, no advertising, no fingerprinting, and no third-party trackers, and does <strong>not</strong> execute remote code.</li>
  </ul>

  <h2>3. Data the plugin transmits</h2>
  <p>The plugin communicates with exactly one server — the public AIWatch API — and sends only <strong>outbound status requests</strong> (<code>GET</code>) that carry <strong>no personal data and no identifier</strong>. It sends nothing else, and it has no reporting or upload feature.</p>

  <h2>4. Anonymous usage measurement</h2>
  <p>To gauge adoption, the AIWatch server counts <strong>aggregate request volume</strong> to the plugin's endpoints (how many monitor polls and <code>/aiwatch</code> briefings arrive per day). This is an <strong>anonymous count only</strong> — no identifier, account, or per-user record is stored, and individual users cannot be distinguished. It is the same anonymous, aggregate measurement used for the rest of the public API.</p>

  <h2>5. Data storage &amp; retention</h2>
  <ul>
    <li><strong>On your device:</strong> a small temporary file holding the last public status poll (used only to detect changes between polls) lives in your system's temp directory and is removed automatically when the monitor stops (it is cleaned up on exit).</li>
    <li><strong>On the server:</strong> only the anonymous per-day aggregate request counts described above, retained short-term and used only in aggregate. They are not linked to you.</li>
  </ul>

  <h2>6. Configuration</h2>
  <p>The plugin is open source. If you prefer, you can point it at your own AIWatch deployment with the <code>AIWATCH_BASE</code> environment variable, in which case it talks only to your server and not to ai-watch.dev.</p>

  <h2>7. Third-party services</h2>
  <p>The plugin talks to only the AIWatch API (served via Cloudflare Workers) and shares nothing with any other party. There are no analytics or advertising SDKs.</p>

  <h2>8. Your rights</h2>
  <p>Because the plugin collects no personally identifiable information, there is no personal profile to access or delete. Removing the plugin removes the local temporary file described above.</p>

  <h2>9. Children's privacy</h2>
  <p>The plugin is not directed to, and does not knowingly collect information from, children under the age of 14.</p>

  <h2>10. Changes to this policy</h2>
  <p>We may update this policy if the plugin's practices change; the "Last updated" date above will reflect any revision.</p>

  <h2>11. Contact</h2>
  <p>For privacy inquiries, contact <a href="mailto:${CONTACT}">${CONTACT}</a>.</p>

  <footer>
    <a href="https://ai-watch.dev/plugin">AIWatch plugin</a> · <a href="https://ai-watch.dev">Dashboard</a> · <a href="https://github.com/bentleypark/aiwatch">Open source (AGPL-3.0)</a>
  </footer>
</main>
</body>
</html>`
}

export default async function handler(_req: Request) {
  try {
    // #482 — per-response nonce + own ENFORCING CSP (mirrors api/extension-privacy.ts). The page has
    // no inline script, so it's CSP-clean regardless; the nonce keeps parity with the other Edge pages.
    const nonce = generateNonce()
    const csp = buildCsp(nonce, { enforce: true })
    return new Response(renderPluginPrivacyPage(), {
      status: 200,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        // Static content → cacheable at the edge (no inline script means a shared nonce across
        // cached visitors carries no XSS risk).
        'Cache-Control': 'public, max-age=3600, s-maxage=86400',
        [csp.key]: csp.value,
      },
    })
  } catch (err) {
    console.error('[plugin-privacy] Render failed:', err instanceof Error ? err.stack : err)
    return new Response(
      '<!DOCTYPE html><html><head><meta charset="UTF-8"><title>AIWatch</title></head><body style="background:#080c10;color:#e6edf3;font-family:sans-serif;text-align:center;padding:60px"><h1>Something went wrong</h1><p>Please visit <a href="https://ai-watch.dev" style="color:#58a6ff">AIWatch</a>.</p></body></html>',
      { status: 500, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' } },
    )
  }
}
