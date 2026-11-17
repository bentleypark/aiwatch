// #2009 — the "Check connection" button on the Edge is-down pages: one click makes one GET from the
// visitor's browser to the service's existing probe URL and prints the HTTP status + elapsed time.
// No verdict is drawn.
//
// Readable = the provider answers a cross-origin GET with CORS headers (measured 2026-11-16 from a
// third-party origin, `mode: 'cors'`, no credentials — see #2009). READABLE ∪ UNREADABLE must equal
// PROBE_TARGETS (pinned in device-check.test.ts), so a new probe target forces a decision here.

import { PROBE_TARGETS } from '../../worker/src/probe'

export const DEVICE_CHECK_READABLE: Readonly<Record<string, { header?: string }>> = {
  claude: { header: 'anthropic-dangerous-direct-browser-access:true' },
  openai: {}, gemini: {}, mistral: {}, cohere: {}, groq: {}, together: {}, fireworks: {}, cerebras: {},
  perplexity: {}, huggingface: {}, fal: {}, elevenlabs: {}, xai: {}, deepseek: {}, kimi: {}, openrouter: {},
  stability: {}, assemblyai: {}, fishaudio: {}, speechmatics: {}, voyageai: {}, jina: {}, twelvelabs: {},
  langsmith: {}, langfuse: {}, turbopuffer: {}, bedrock: {},
}

export const DEVICE_CHECK_UNREADABLE: readonly string[] = [
  'replicate', 'bfl', 'deepgram', 'pinecone', 'runway', 'luma', 'helicone', 'cursor', 'characterai',
]

export interface DeviceCheckTarget { url: string; host: string; origin: string; header?: string }

/** The probe URL a service's visitors can check from their own browser, or null when the provider's
 *  answer is not readable cross-origin. */
export function deviceCheckTarget(serviceId: string): DeviceCheckTarget | null {
  const spec = DEVICE_CHECK_READABLE[serviceId]
  if (!spec) return null
  const probe = PROBE_TARGETS.find((t) => t.id === serviceId)
  if (!probe) return null
  const u = new URL(probe.url)
  return { url: probe.url, host: u.host, origin: u.origin, header: spec.header }
}

/** The `connect-src` origin this page needs for its button — empty when it renders none. */
export function deviceCheckConnectSrc(serviceId: string): string[] {
  const t = deviceCheckTarget(serviceId)
  return t ? [t.origin] : []
}

function escAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

// Plain single-quoted JS inside a template literal: no backticks and no `${` in here (an Edge template
// string would end or interpolate). Defines the two pure helpers the unit test runs, plus the click handler.
export const DEVICE_CHECK_CLIENT_JS = `var DC_TIMEOUT_MS = 8000;
function deviceCheckLine(o) {
  var h = o.host;
  if (o.kind === 'http') {
    var pre = o.preflight ? ', which may include a browser permission check' : '';
    if (o.status >= 500) return 'Your connection reached ' + h + ', but the provider answered with an error (HTTP ' + o.status + ') after ' + o.ms + ' ms' + pre + '.';
    return 'Your connection reached ' + h + '. It replied in ' + o.ms + ' ms' + pre + ' (HTTP ' + o.status + ').';
  }
  if (o.kind === 'timeout') return 'No reply from ' + h + ' within ' + (DC_TIMEOUT_MS / 1000) + ' seconds. Your network, a VPN or firewall, or the provider itself could be the cause. This test cannot tell which.';
  return 'Could not reach ' + h + '. Your network, a VPN, ad blocker or firewall, the provider being down, or the provider not accepting requests from a browser could each cause this. This test cannot tell which.';
}
function deviceCheckClass(o) {
  return o.kind === 'http' ? (o.status >= 500 ? 'server_error' : 'ok') : o.kind;
}
function runDeviceCheck(btn) {
  var box = btn && btn.closest ? btn.closest('[data-device-check]') : null;
  if (!box || btn.getAttribute('aria-disabled') === 'true') return;
  var lab = btn.querySelector('[data-device-label]');
  var out = box.querySelector('[data-device-out]');
  var url = box.getAttribute('data-url') || '';
  var host;
  try { var u = new URL(url); if (u.protocol !== 'https:') return; host = u.host; } catch (e) { return; }
  var hdr = box.getAttribute('data-hdr') || '';
  var headers = {};
  if (hdr) { var i = hdr.indexOf(':'); headers[hdr.slice(0, i)] = hdr.slice(i + 1); }
  var ctl = new AbortController(), timedOut = false, t0 = performance.now();
  var timer = setTimeout(function () { timedOut = true; ctl.abort(); }, DC_TIMEOUT_MS);
  var label = lab.textContent;
  btn.setAttribute('aria-disabled', 'true');
  lab.textContent = 'Checking\\u2026';
  function done(o) {
    clearTimeout(timer);
    btn.removeAttribute('aria-disabled');
    lab.textContent = label;
    o.host = host; o.ms = Math.round(performance.now() - t0); o.preflight = !!hdr;
    out.textContent = deviceCheckLine(o);
    var note = box.querySelector('[data-device-note]');
    if (note) note.textContent = box.getAttribute('data-note') || '';
    if (typeof gtag === 'function') gtag('event', 'device_check_result', { service_id: box.getAttribute('data-svc') || '', outcome: deviceCheckClass(o) });
  }
  fetch(url, { method: 'GET', mode: 'cors', credentials: 'omit', cache: 'no-store', redirect: 'follow', referrerPolicy: 'no-referrer', headers: headers, signal: ctl.signal }).then(
    function (r) { try { if (r.body && r.body.cancel) r.body.cancel(); } catch (e) {} done({ kind: 'http', status: r.status }); },
    function () { done({ kind: timedOut ? 'timeout' : 'error' }); }
  );
}
function closeDeviceCheck(btn) {
  var box = btn && btn.closest ? btn.closest('[data-device-check]') : null;
  if (!box) return;
  var parts = box.querySelectorAll('[data-device-out], [data-device-note]');
  for (var i = 0; i < parts.length; i++) parts[i].textContent = '';
  var pill = box.querySelector('[data-action="device-check"]');
  if (pill && pill.focus) pill.focus();
}`

// One listener for every page that renders the block, so a page needs no dispatcher of its own.
const DEVICE_CHECK_LISTENER_JS = `document.addEventListener('click', function (e) {
  var t = e.target && e.target.closest ? e.target : null;
  var b = t ? t.closest('[data-action="device-check"]') : null;
  if (b) { runDeviceCheck(b); return; }
  var x = t ? t.closest('[data-action="device-check-close"]') : null;
  if (x) closeDeviceCheck(x);
});`

// Floats bottom-right directly above the page's "Report an issue" button, so it is on screen wherever
// the visitor has scrolled. The answer card only takes up space once it has text.
export const DEVICE_CHECK_CSS = `.device-check{position:fixed;right:20px;bottom:68px;z-index:40;display:flex;flex-direction:column-reverse;align-items:flex-end;margin:0}
.dc-pill{display:inline-flex;align-items:center;gap:6px;padding:10px 16px;border-radius:999px;font-size:13px;font-weight:500;font-family:inherit;background:#161b22;color:#e6edf3;border:1px solid rgba(255,255,255,0.18);box-shadow:0 4px 12px rgba(0,0,0,0.4);cursor:pointer}
.dc-pill:hover{filter:brightness(1.15)}
.dc-pill[aria-disabled="true"]{opacity:0.6;cursor:default}
.dc-card{position:relative;box-sizing:border-box;width:max-content;max-width:min(320px,calc(100vw - 40px))}
.dc-card p{margin:0}
.dc-card:has([data-device-out]:not(:empty)){margin-bottom:8px;padding:10px 34px 10px 12px;background:#161b22;border:1px solid rgba(255,255,255,0.18);border-radius:10px;box-shadow:0 4px 12px rgba(0,0,0,0.4);font-size:13px;line-height:1.5;color:#e6edf3}
.dc-card .dc-note{margin-top:6px;font-size:12px;color:#8b949e}
.dc-close{position:absolute;top:6px;right:8px;width:24px;height:24px;padding:0;border:0;background:none;color:#8b949e;font-size:18px;line-height:1;cursor:pointer}
[data-device-out]:empty ~ .dc-note,[data-device-out]:empty ~ .dc-close{display:none}`

type Surface = 'is_down_page' | 'is_down_group_page'

const NOTE_TAIL = 'The request goes straight from your browser, not through AIWatch.'

function renderBlock(svcId: string, t: DeviceCheckTarget, note: string, surface: Surface): string {
  const hdr = t.header ? ` data-hdr="${escAttr(t.header)}"` : ''
  const svc = escAttr(svcId)
  return `<section class="device-check" data-device-check data-svc="${svc}" data-url="${escAttr(t.url)}" data-note="${escAttr(note)}"${hdr}>
<button type="button" class="dc-pill" data-action="device-check" data-ga="click_device_check" data-ga-loc="${surface}" data-ga-svc="${svc}"><span aria-hidden="true">🌐</span> <span data-device-label>Check connection</span></button>
<div class="dc-card">
<p data-device-out aria-live="polite"></p>
<p class="dc-note" data-device-note></p>
<button type="button" class="dc-close" data-action="device-check-close" aria-label="Close">&times;</button>
</div>
</section>`
}

/** Handler + listener, for a page that already carries a closing inline script of its own. */
export const DEVICE_CHECK_JS = `${DEVICE_CHECK_CLIENT_JS}\n${DEVICE_CHECK_LISTENER_JS}`

const SCRIPT = `<script>${DEVICE_CHECK_JS}\n</script>`

/** The button block for a service page, or '' when its provider is not readable from a browser. */
export function renderDeviceCheck(serviceId: string): string {
  const t = deviceCheckTarget(serviceId)
  if (!t) return ''
  return `${renderBlock(serviceId, t, NOTE_TAIL, 'is_down_page')}\n${SCRIPT}`
}

export interface DeviceCheckGroupEntry { svcId: string; name: string; target: DeviceCheckTarget }

/** The members of a family page that have a readable probe URL of their own. */
export function deviceCheckGroupTargets(members: ReadonlyArray<{ id: string; name: string }>): DeviceCheckGroupEntry[] {
  return members.flatMap((m) => {
    const target = deviceCheckTarget(m.id)
    return target ? [{ svcId: m.id, name: m.name, target }] : []
  })
}

/** The origins a family page's CSP needs for its blocks. */
export function deviceCheckGroupConnectSrc(members: ReadonlyArray<{ id: string; name: string }>): string[] {
  return deviceCheckGroupTargets(members).map((e) => e.target.origin)
}

/** One block per testable member of a family page; '' when none is testable. Markup only — the
 *  page adds DEVICE_CHECK_JS to its own script. */
export function renderDeviceCheckGroup(members: ReadonlyArray<{ id: string; name: string }>): string {
  return deviceCheckGroupTargets(members).map((e) => {
    const note = `${e.target.host} is the address of ${e.name} (not a website). ${NOTE_TAIL}`
    return renderBlock(e.svcId, e.target, note, 'is_down_group_page')
  }).join('\n')
}
