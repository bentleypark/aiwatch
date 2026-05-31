// Vercel Edge Function — /confirm landing page for the per-user Discord subscription opt-in (#486 PR2).
//
// The double-opt-in challenge (#486): when a user subscribes, the worker posts a link into their
// Discord channel — https://ai-watch.dev/confirm?h={hash}&c={code}. Proving they can READ that link
// (i.e. control the channel) is the identity check. This page is the landing target.
//
// CRITICAL — crawler-safety: Discord (and email/AV scanners) PREFETCH links to build previews. If a
// GET here activated the subscription, a crawler would auto-confirm before the human, defeating the
// challenge and letting an attacker's registration self-confirm via the channel's own crawler. So:
//   - GET renders a page with an [Activate] button and has ZERO side effects.
//   - Activation happens only on the button's POST to the worker's /api/webhook/confirm (crawlers
//     don't POST). The worker is CORS-guarded to ai-watch.dev, which this page is served from.
//
// Self-contained SSR (inline CSS/JS, no external data fetch) — mirrors api/intro.ts, reusing the same
// design tokens (src/index.css dark theme) + the AI<green>Watch</green> wordmark with the favicon so
// it matches the rest of AIWatch.

export const config = { runtime: 'edge' }

const PROD_WORKER_API = 'https://aiwatch-worker.p2c2kbf.workers.dev'
const LOCAL_WORKER_API = 'http://localhost:8788'

/** The worker the Activate button POSTs to, chosen by the host of the incoming request (`req.url`).
 *  When this page is requested via a localhost host (i.e. served by `vercel dev`), target the local
 *  worker so the subscribe → confirm click-through can run end-to-end. For this to actually work the
 *  worker must ALSO emit a localhost confirm link — set `CONFIRM_BASE_URL=http://localhost:3333` on
 *  the worker (worker/src/index.ts) so the link points back to this page; this function alone only
 *  controls the POST target, not the link the worker posts to Discord. Harmless in prod — the
 *  deployed host is never localhost, so production always POSTs to the deployed worker. (#486 PR2) */
function workerApiFor(reqUrl: string): string {
  try {
    const { hostname } = new URL(reqUrl)
    if (hostname === 'localhost' || hostname === '127.0.0.1') return LOCAL_WORKER_API
  } catch { /* fall through to prod */ }
  return PROD_WORKER_API
}

// h = sha256 hex (64), c = 6-digit code. Validate shape before reflecting into HTML/JS to avoid
// injection — anything malformed renders the generic "invalid link" state without a button.
const HASH_RE = /^[a-f0-9]{64}$/
const CODE_RE = /^\d{6}$/

function page(body: string): string {
  // Canonical dark-theme tokens copied from src/index.css (Edge functions can't import the SPA CSS):
  // --bg0 #080c10, --bg1 #0d1117, --text0 #e6edf3, --text1 #adbac7, --text2 #8b949e,
  // --green #3fb950, --blue #58a6ff, --red #f85149, --border rgba(255,255,255,0.07).
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="robots" content="noindex">
<title>Confirm AIWatch Alerts</title>
<link rel="icon" type="image/png" href="/favicon.png">
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: #080c10; color: #e6edf3; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 24px; }
  .card { max-width: 420px; width: 100%; background: #0d1117; border: 1px solid rgba(255,255,255,0.07); border-radius: 12px; padding: 32px 28px; text-align: center; }
  /* Matches the dashboard Topbar wordmark exactly (src/components/Topbar.jsx): mono, 600, 15px,
     -0.3px tracking, "AI" in --text0 + "Watch" in --green, text-only (no icon). */
  .logo { font-family: 'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 15px; font-weight: 600; letter-spacing: -0.3px; color: #e6edf3; }
  .logo span { color: #3fb950; }
  h1 { font-size: 16px; font-weight: 600; color: #e6edf3; margin: 18px 0 8px; }
  p { font-size: 13px; line-height: 1.6; color: #adbac7; margin: 0 0 8px; }
  button { margin-top: 18px; width: 100%; padding: 11px 16px; font-size: 14px; font-weight: 600; border: none; border-radius: 7px; background: #3fb950; color: #080c10; cursor: pointer; font-family: inherit; }
  button:disabled { opacity: 0.55; cursor: default; }
  .muted { font-size: 11px; color: #8b949e; margin-top: 14px; }
  a { color: #58a6ff; text-decoration: none; }
  .ok { color: #3fb950; } .err { color: #f85149; }
</style>
</head>
<body>
  <div class="card">
    <div class="logo">AI<span>Watch</span></div>
    ${body}
  </div>
</body>
</html>`
}

export default async function handler(req: Request): Promise<Response> {
  const headers = { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store, max-age=0' }
  try {
    const url = new URL(req.url)
    const h = url.searchParams.get('h') ?? ''
    const c = url.searchParams.get('c') ?? ''

    if (!HASH_RE.test(h) || !CODE_RE.test(c)) {
      return new Response(page(`
        <h1>Invalid confirmation link</h1>
        <p>This link is malformed or incomplete. Re-add your webhook in
        <a href="https://ai-watch.dev/#settings">AIWatch &rarr; Settings</a> to get a fresh one.</p>
      `), { status: 400, headers })
    }

    // GET only renders — activation is the button's POST. The inline script holds the validated
    // h/c (safe: both passed strict regex) and calls the worker's confirm endpoint on click.
    const hJs = JSON.stringify(h)
    const cJs = JSON.stringify(c)
    const workerApi = workerApiFor(req.url)
    return new Response(page(`
      <h1>Confirm AIWatch alerts</h1>
      <p>Activate incident &amp; status alerts for this Discord channel. You're seeing this because
      someone (hopefully you) added this channel's webhook to AIWatch.</p>
      <button id="go" type="button">Activate alerts</button>
      <div id="msg" class="muted"></div>
      <div class="muted">Didn't request this? Just close this page — nothing is activated until you click.</div>
      <script>
        (function () {
          var btn = document.getElementById('go');
          var msg = document.getElementById('msg');
          btn.addEventListener('click', function () {
            btn.disabled = true;
            msg.textContent = 'Activating…';
            fetch(${JSON.stringify(workerApi)} + '/api/webhook/confirm', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ hash: ${hJs}, code: ${cJs} })
            }).then(function (r) {
              if (r.ok) {
                msg.className = 'muted ok';
                msg.textContent = '✓ Alerts activated. You can close this page.';
                btn.style.display = 'none';
              } else if (r.status === 410) {
                msg.className = 'muted err';
                msg.innerHTML = 'This confirmation expired. Re-add your webhook in <a href="https://ai-watch.dev/#settings">AIWatch Settings</a>.';
                btn.disabled = false;
              } else if (r.status >= 500) {
                // Server fault (storage error) — genuinely retryable, so keep the button enabled.
                msg.className = 'muted err';
                msg.textContent = 'Server error (' + r.status + '). Please try again in a moment.';
                btn.disabled = false;
              } else {
                // Other 4xx (e.g. 400 incorrect/tampered code) — retrying the same link can never
                // succeed, so DON'T re-enable the button; point the user to re-add for a fresh link.
                msg.className = 'muted err';
                msg.innerHTML = 'This confirmation link is invalid. Re-add your webhook in <a href="https://ai-watch.dev/#settings">AIWatch Settings</a> to get a fresh one.';
              }
            }).catch(function () {
              msg.className = 'muted err';
              msg.textContent = 'Network error. Try again.';
              btn.disabled = false;
            });
          });
        })();
      </script>
    `), { status: 200, headers })
  } catch (err) {
    console.error('[confirm] render failed:', err instanceof Error ? err.stack : err)
    return new Response(page(`<h1>Something went wrong</h1><p>Please try again or visit
      <a href="https://ai-watch.dev">AIWatch</a>.</p>`), { status: 500, headers })
  }
}
