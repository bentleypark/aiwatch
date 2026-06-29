// Shared cookie banner HTML + CSS + JS for Edge SSR pages (#352).
//
// Both Vercel templates import this. The Jekyll reports footer
// (aiwatch-reports/_includes/footer.html) keeps a hand-synced copy.
//
// UX/copy mirrors src/components/CookieBanner.jsx in the SPA. Same localStorage key
// (`aiwatch-cookie-consent`) — only shows when the key is absent.
//
// Accept-failure handling: if `localStorage.setItem` throws (Safari private mode, quota,
// embedded webview), the Accept branch returns WITHOUT calling `gtag('consent','update',
// 'granted')` and WITHOUT hiding the banner. This prevents the page-view from running
// under upgraded consent that was never persisted (would re-prompt next load anyway → user
// would think Accept was ignored). Essential-Only on storage failure still hides the banner
// because the default state already matches the user's intent (denied + cleanup).

const COOKIE_BANNER_MARKUP = `<div id="aiwatch-cookie-banner" hidden role="dialog" aria-label="Cookie consent" aria-live="polite">
<div class="aiwatch-cb-inner">
<div class="aiwatch-cb-text"><strong>Cookie Notice</strong><p>AIWatch uses Google Analytics cookies to improve the service. Only anonymous usage statistics are collected. <a href="https://ai-watch.dev/" rel="noopener">Open dashboard</a> to review later.</p></div>
<div class="aiwatch-cb-actions"><button type="button" data-aiwatch-cb="essential">Essential Only</button><button type="button" data-aiwatch-cb="accept">Accept All</button></div>
</div>
</div>
<style>#aiwatch-cookie-banner{position:fixed;bottom:0;left:0;right:0;z-index:9999;background:#0d1117;color:#e6edf3;border-top:1px solid #30363d;padding:14px 20px;font-family:system-ui,-apple-system,sans-serif;font-size:12px;line-height:1.5;box-shadow:0 -4px 16px rgba(0,0,0,.3)}#aiwatch-cookie-banner[hidden]{display:none}#aiwatch-cookie-banner .aiwatch-cb-inner{max-width:900px;margin:0 auto;display:flex;flex-wrap:wrap;align-items:center;gap:12px 20px;justify-content:space-between}#aiwatch-cookie-banner strong{display:block;font-size:13px;font-weight:600;margin-bottom:4px;color:#e6edf3}#aiwatch-cookie-banner p{margin:0;color:#9ba3ad;font-size:11px}#aiwatch-cookie-banner a{color:#3fb950;text-decoration:none}#aiwatch-cookie-banner .aiwatch-cb-actions{display:flex;gap:8px;flex-shrink:0}#aiwatch-cookie-banner button{padding:7px 14px;border-radius:4px;font-size:11px;font-family:inherit;cursor:pointer;border:1px solid transparent}#aiwatch-cookie-banner button[data-aiwatch-cb=essential]{background:transparent;color:#c9d1d9;border-color:#30363d}#aiwatch-cookie-banner button[data-aiwatch-cb=essential]:hover{color:#e6edf3;border-color:#484f58}#aiwatch-cookie-banner button[data-aiwatch-cb=accept]{background:#3fb950;color:#0d1117;font-weight:600}#aiwatch-cookie-banner button[data-aiwatch-cb=accept]:hover{opacity:.9}@media(max-width:520px){#aiwatch-cookie-banner{padding:12px 14px}#aiwatch-cookie-banner .aiwatch-cb-inner{flex-direction:column;align-items:stretch}#aiwatch-cookie-banner .aiwatch-cb-actions{justify-content:flex-end}}</style>`

const COOKIE_BANNER_BODY = `(function(){var K='aiwatch-cookie-consent',b=document.getElementById('aiwatch-cookie-banner');if(!b)return;var s=null;try{s=localStorage.getItem(K)}catch(err){}if(s===null)b.hidden=false;function clr(){var h=location.hostname,EXP='expires=Thu, 01 Jan 1970 00:00:00 GMT';document.cookie.split(';').forEach(function(c){var n=c.split('=')[0].trim();if(n.indexOf('_ga')===0||n.indexOf('_gid')===0||n.indexOf('_gcl_au')===0){document.cookie=n+'=;'+EXP+';path=/;domain=.'+h+';SameSite=Lax';document.cookie=n+'=;'+EXP+';path=/;domain='+h+';SameSite=Lax';document.cookie=n+'=;'+EXP+';path=/;SameSite=Lax'}})}b.addEventListener('click',function(e){var t=e.target.closest('[data-aiwatch-cb]');if(!t)return;var a=t.getAttribute('data-aiwatch-cb'),stored=false;try{localStorage.setItem(K,a==='accept'?'granted':'denied');stored=true}catch(err){}if(a==='accept'){if(!stored)return;if(window.gtag)gtag('consent','update',{analytics_storage:'granted'})}else{if(window.gtag)gtag('consent','update',{analytics_storage:'denied',ad_storage:'denied',ad_user_data:'denied',ad_personalization:'denied'});clr()}b.hidden=true})})();`

/** Un-migrated callers (intro, is-down) + the Jekyll copy use this no-nonce const. */
export const COOKIE_BANNER_HTML = `${COOKIE_BANNER_MARKUP}
<script>${COOKIE_BANNER_BODY}</script>`

/** #482 — nonce-stamped banner for migrated Edge pages (its inline `<script>` carries the nonce
 *  so an enforcing CSP admits it). Byte-identical markup + body to `COOKIE_BANNER_HTML`. */
export function cookieBannerHtml(nonce?: string): string {
  const n = nonce ? ` nonce="${nonce}"` : ''
  return `${COOKIE_BANNER_MARKUP}
<script${n}>${COOKIE_BANNER_BODY}</script>`
}
