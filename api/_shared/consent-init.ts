// Shared GA4 + Consent Mode v2 init payload for Edge SSR pages (#352).
//
// The Edge templates import this so the consent contract is enforced from a single source. The Jekyll
// reports site (aiwatch-reports/_includes/head.html) keeps a hand-synced copy with the same byte
// content in the `<script>` body — see that file's comment for the sync rule.
//
// Behavior contract (also documented in CLAUDE.md and the Privacy Policy):
//   1. #2070 — gtag.js is requested, and `gtag` / `dataLayer` exist, only once
//      localStorage.aiwatch-cookie-consent is 'granted' (on load, or from the banner's Accept All
//      through `window.aiwatchStartAnalytics`). Before that, the templates' `typeof gtag` guards drop
//      events, so nothing is queued for later.
//   2. Consent Mode v2: all four signals default to 'denied', then only analytics_storage is upgraded.
//      Ad signals stay 'denied' permanently — AIWatch does not advertise.
//   3. Otherwise (denied OR absent OR storage unavailable), purge legacy
//      _ga / _gid / _gcl_au cookies under all three scope variants.
//
// Variable naming: catch parameter is `err`, expiry constant is `EXP` (uppercase) — both
// chosen to avoid the var-shadowing that older copies of this script had.

export const GA4_MEASUREMENT_ID = 'G-D4ZWVHQ7JK'

export const CONSENT_INIT_COMMENT = `<!-- GA4: loaded only with analytics consent (#2070). Honors the choice stored under the
     aiwatch-cookie-consent localStorage key, shared with the SPA (#352). When consent is absent
     or revoked, nothing is requested from Google, and any legacy _ga / _gid / _gcl_au cookies are
     cleared; kept in sync with clearAnalyticsCookies() in src/utils/analytics.js. -->`

const CONSENT_INIT_BODY = `(function(){var w=window,s=document.currentScript,nonce=s&&s.nonce;w.aiwatchStartAnalytics=function(){w.dataLayer=w.dataLayer||[];w.gtag=function(){w.dataLayer.push(arguments);};w.gtag('js',new Date());w.gtag('consent','default',{analytics_storage:'denied',ad_storage:'denied',ad_user_data:'denied',ad_personalization:'denied'});w.gtag('consent','update',{analytics_storage:'granted'});w.gtag('config','${GA4_MEASUREMENT_ID}');var t=document.createElement('script');t.async=true;t.src='https://www.googletagmanager.com/gtag/js?id=${GA4_MEASUREMENT_ID}';if(nonce)t.nonce=nonce;document.head.appendChild(t);};var c='';try{c=localStorage.getItem('aiwatch-cookie-consent');}catch(err){}if(c==='granted'){w.aiwatchStartAnalytics();}else{var h=location.hostname,EXP='expires=Thu, 01 Jan 1970 00:00:00 GMT';document.cookie.split(';').forEach(function(x){var n=x.split('=')[0].trim();if(n.indexOf('_ga')===0||n.indexOf('_gid')===0||n.indexOf('_gcl_au')===0||n==='_clck'||n==='_clsk'){document.cookie=n+'=;'+EXP+';path=/;domain=.'+h+';SameSite=Lax';document.cookie=n+'=;'+EXP+';path=/;domain='+h+';SameSite=Lax';document.cookie=n+'=;'+EXP+';path=/;SameSite=Lax';}});}})();`

/**
 * #482 — the inline consent script for an Edge page. `nonce` is stamped on it, and it hands the same
 * nonce to the gtag.js loader it injects, for GA4's nonce propagation. Pass '' to get the no-nonce form.
 */
export function consentInitScript(nonce?: string): string {
  const n = nonce ? ` nonce="${nonce}"` : ''
  return `<script${n}>${CONSENT_INIT_BODY}</script>`
}
