// Vercel Edge Function — the two pages of the "Add to Slack" flow (#1581).
//   /slack?result=…   where the worker's OAuth callback lands (installed / denied / expired / error /
//                     unavailable). Static per result; no data.
//   /slack/manage     the channel-scoped manage link from the welcome message. The token rides in the
//                     URL FRAGMENT (`#t=…`), so it never reaches this function, Vercel's logs or a
//                     Referer; the inline script reads it and talks to the worker's /api/slack/manage.

import { generateNonce, buildCsp, nonceAttr } from './_shared/csp-nonce'
import { slackInstallUrl } from './_shared/slack-install'

export const config = { runtime: 'edge' }

const WORKER_API = 'https://aiwatch-worker.p2c2kbf.workers.dev'


const RESULTS: Record<string, { title: string; body: string; ok: boolean }> = {
  installed: { ok: true, title: 'AIWatch is in your Slack channel', body: 'A welcome message is waiting in the channel you picked. It lists the services you will get alerts for and has a link to change them or unsubscribe.' },
  denied: { ok: false, title: 'Slack install cancelled', body: 'Nothing was installed. You can add AIWatch again whenever you like.' },
  expired: { ok: false, title: 'This install link expired', body: 'Installs have to finish within 10 minutes, in the same browser that started them. Please start again.' },
  error: { ok: false, title: 'The Slack install did not finish', body: 'Slack did not confirm the install. Please try again in a moment.' },
  unavailable: { ok: false, title: 'Slack alerts are not available right now', body: 'Please try again later, or use the /feed command from the alert settings instead.' },
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function page(title: string, body: string, nonce: string, script = ''): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="robots" content="noindex">
<title>${esc(title)} — AIWatch</title>
<link rel="icon" type="image/png" href="/favicon.png">
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: #080c10; color: #e6edf3; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; min-height: 100vh; display: flex; align-items: flex-start; justify-content: center; padding: 48px 16px; }
  .card { max-width: 520px; width: 100%; background: #0d1117; border: 1px solid rgba(255,255,255,0.07); border-radius: 12px; padding: 32px 28px; }
  .logo { font-family: 'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 15px; font-weight: 600; letter-spacing: -0.3px; color: #e6edf3; }
  .logo span { color: #3fb950; }
  h1 { font-size: 17px; font-weight: 600; margin: 18px 0 8px; }
  h2 { font-size: 13px; font-weight: 600; color: #adbac7; margin: 20px 0 8px; }
  p { font-size: 13px; line-height: 1.6; color: #adbac7; margin: 0 0 8px; }
  a { color: #58a6ff; text-decoration: none; }
  .ok { color: #3fb950; } .err { color: #f85149; }
  .muted { font-size: 12px; color: #8b949e; }
  .row { display: flex; gap: 10px; flex-wrap: wrap; margin-top: 18px; }
  .btn { display: inline-block; padding: 9px 16px; font-size: 13px; font-weight: 600; border-radius: 7px; border: 1px solid rgba(255,255,255,0.14); background: #161b22; color: #e6edf3; cursor: pointer; font-family: inherit; }
  .btn-primary { background: #3fb950; border-color: #3fb950; color: #080c10; }
  .btn-danger { color: #f85149; border-color: rgba(248,81,73,0.5); }
  .btn:disabled { opacity: 0.55; cursor: default; }
  fieldset { border: none; }
  .svc-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 4px 12px; }
  .svc-group { grid-column: 1 / -1; font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: .04em; color: #8b949e; margin: 10px 0 2px; }
  .svc-group:first-child { margin-top: 0; }
  label { font-size: 13px; color: #e6edf3; display: flex; align-items: center; gap: 8px; padding: 3px 0; }
  .opt { margin-bottom: 4px; }
</style>
</head>
<body>
  <main class="card">
    <div class="logo">AI<span>Watch</span></div>
    ${body}
  </main>
  ${script ? `<script${nonceAttr(nonce)}>${script}</script>` : ''}
</body>
</html>`
}

export function renderResult(result: string, nonce: string): string {
  const r = RESULTS[result] ?? RESULTS.error
  const again = r.ok ? '' : `<a class="btn btn-primary" href="${esc(slackInstallUrl())}">Add to Slack again</a>`
  return page(r.title, `
    <h1 class="${r.ok ? 'ok' : ''}">${esc(r.title)}</h1>
    <p>${esc(r.body)}</p>
    <div class="row">${again}<a class="btn" href="https://ai-watch.dev">Open the dashboard</a></div>
  `, nonce)
}

export function renderManage(nonce: string): string {
  const body = `
    <h1>Slack alert settings</h1>
    <p id="status" class="muted">Loading this channel's subscription…</p>
    <form id="form" hidden>
      <h2>Services</h2>
      <fieldset class="opt">
        <label><input type="radio" name="target" value="all"> Every service AIWatch monitors</label>
        <label><input type="radio" name="target" value="custom"> Only these:</label>
      </fieldset>
      <div id="svcs" class="svc-grid"></div>
      <h2>Status changes</h2>
      <fieldset class="opt">
        <label><input type="radio" name="condition" value="all"> Outages and degraded performance</label>
        <label><input type="radio" name="condition" value="down"> Outages only</label>
      </fieldset>
      <h2>Incident updates</h2>
      <label><input type="checkbox" id="incidents"> New and resolved incidents</label>
      <div class="row">
        <button type="submit" class="btn btn-primary" id="save">Save</button>
        <button type="button" class="btn btn-danger" id="unsub">Unsubscribe this channel</button>
      </div>
      <p id="msg" class="muted" role="status" aria-live="polite"></p>
    </form>`
  const script = `(function(){
  var API = ${JSON.stringify(WORKER_API + '/api/slack/manage')};
  var token = (location.hash.match(/[#&]t=([A-Za-z0-9_-]{43})/) || [])[1];
  var status = document.getElementById('status'), form = document.getElementById('form'), msg = document.getElementById('msg');
  var svcs = document.getElementById('svcs'), save = document.getElementById('save'), unsub = document.getElementById('unsub');
  function fail(text){ status.className = 'err'; status.textContent = text; form.hidden = true; }
  function call(action, filters){
    return fetch(API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: token, action: action, filters: filters }) })
      .then(function(r){ return r.json().catch(function(){ return {}; }).then(function(j){ return { status: r.status, body: j }; }); });
  }
  function radio(name, value){ var el = form.querySelector('input[name="' + name + '"][value="' + value + '"]'); if (el) el.checked = true; }
  function render(f, services){
    var chosen = {}; (f.alertServices || []).forEach(function(id){ chosen[id] = true; });
    var list = (services || []).slice();
    (f.alertServices || []).forEach(function(id){ if (!list.some(function(s){ return s.id === id; })) list.push({ id: id, name: id, group: 'Other' }); });
    svcs.textContent = '';
    var group;
    list.forEach(function(s){
      if (s.group !== group) {
        group = s.group;
        var h = document.createElement('h3'); h.className = 'svc-group'; h.textContent = group; svcs.appendChild(h);
      }
      var label = document.createElement('label'), box = document.createElement('input');
      box.type = 'checkbox'; box.value = s.id; box.checked = !!chosen[s.id];
      label.appendChild(box); label.appendChild(document.createTextNode(' ' + s.name)); svcs.appendChild(label);
    });
    radio('target', f.alertTarget === 'custom' ? 'custom' : 'all');
    radio('condition', f.alertCondition === 'down' ? 'down' : 'all');
    document.getElementById('incidents').checked = f.alertIncidents !== false;
    status.className = 'muted'; status.textContent = 'Changes apply to the Slack channel this link was posted in.';
    form.hidden = false;
  }
  svcs.addEventListener('change', function(e){ if (e.target.checked) radio('target', 'custom'); });
  var remembered = [];
  form.querySelector('input[name="target"][value="all"]').addEventListener('change', function(){
    var boxes = svcs.querySelectorAll('input:checked');
    if (boxes.length) remembered = Array.prototype.map.call(boxes, function(b){ b.checked = false; return b.value; });
  });
  form.querySelector('input[name="target"][value="custom"]').addEventListener('change', function(){
    if (svcs.querySelector('input:checked')) return;
    remembered.forEach(function(id){ var b = svcs.querySelector('input[value="' + id + '"]'); if (b) b.checked = true; });
  });
  if (!token) { fail('This link is incomplete. Open it again from the AIWatch welcome message in your Slack channel.'); return; }
  call('get').then(function(r){
    if (r.status === 200 && r.body.filters) render(r.body.filters, r.body.services);
    else if (r.status === 404) fail('This channel is no longer subscribed, or the link is out of date.');
    else fail('Could not load the subscription (' + r.status + '). Please try again.');
  }).catch(function(){ fail('Network error. Please try again.'); });
  form.addEventListener('submit', function(e){
    e.preventDefault();
    var ids = Array.prototype.map.call(svcs.querySelectorAll('input:checked'), function(b){ return b.value; });
    var target = form.querySelector('input[name="target"]:checked').value;
    if (target === 'custom' && ids.length === 0) { msg.className = 'err'; msg.textContent = 'Pick at least one service, or choose every service.'; return; }
    save.disabled = true; msg.className = 'muted'; msg.textContent = 'Saving…';
    call('update', { alertTarget: target, alertServices: target === 'custom' ? ids : [], alertCondition: form.querySelector('input[name="condition"]:checked').value, alertIncidents: document.getElementById('incidents').checked })
      .then(function(r){
        save.disabled = false;
        if (r.status === 200) { msg.className = 'ok'; msg.textContent = '✓ Saved.'; }
        else { msg.className = 'err'; msg.textContent = 'Could not save (' + r.status + '). Please try again.'; }
      }).catch(function(){ save.disabled = false; msg.className = 'err'; msg.textContent = 'Network error. Please try again.'; });
  });
  unsub.addEventListener('click', function(){
    if (!confirm('Stop AIWatch alerts in this Slack channel?')) return;
    unsub.disabled = true;
    call('unsubscribe').then(function(r){
      if (r.status === 200) { form.hidden = true; status.className = 'ok'; status.textContent = '✓ Unsubscribed. This channel will not get AIWatch alerts any more. You can also remove the app from Slack under Manage apps.'; }
      else { unsub.disabled = false; msg.className = 'err'; msg.textContent = 'Could not unsubscribe (' + r.status + '). Please try again.'; }
    }).catch(function(){ unsub.disabled = false; msg.className = 'err'; msg.textContent = 'Network error. Please try again.'; });
  });
})();`
  return page('Slack alert settings', body, nonce, script)
}

export default async function handler(req: Request): Promise<Response> {
  const nonce = generateNonce()
  const csp = buildCsp(nonce, { enforce: true })
  const headers = { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store, max-age=0', [csp.key]: csp.value }
  try {
    const url = new URL(req.url)
    const html = url.searchParams.get('view') === 'manage'
      ? renderManage(nonce)
      : renderResult(url.searchParams.get('result') ?? '', nonce)
    return new Response(html, { status: 200, headers })
  } catch (err) {
    console.error('[slack-alerts] render failed:', err instanceof Error ? err.stack : err)
    return new Response(renderResult('error', nonce), { status: 500, headers })
  }
}
