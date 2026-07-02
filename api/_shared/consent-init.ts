// Shared GA4 + Consent Mode v2 init payload for Edge SSR pages (#352).
//
// Both Vercel templates (api/_intro/html-template.ts, api/_is-down/html-template.ts) import
// this so the consent contract is enforced from a single source. The Jekyll reports site
// (aiwatch-reports/_includes/head.html) keeps a hand-synced copy with the same byte content
// in the `<script>` body — see that file's comment for the sync rule.
//
// Behavior contract (also documented in CLAUDE.md and the Privacy Policy):
//   1. Consent Mode v2 default: analytics_storage / ad_storage / ad_user_data /
//      ad_personalization all 'denied' before any gtag activity runs.
//   2. If localStorage.aiwatch-cookie-consent === 'granted', upgrade analytics_storage only.
//      Ad signals stay 'denied' permanently — AIWatch does not advertise.
//   3. Otherwise (denied OR absent OR storage unavailable), purge legacy
//      _ga / _gid / _gcl_au cookies under all three scope variants.
//
// Variable naming: catch parameter is `err`, expiry constant is `EXP` (uppercase) — both
// chosen to avoid the var-shadowing that older copies of this script had.

export const GA4_MEASUREMENT_ID = 'G-D4ZWVHQ7JK'

export const CONSENT_INIT_COMMENT = `<!-- GA4: Consent Mode v2 default-denied for analytics + ad storage. Honors prior consent
     set on the SPA via the aiwatch-cookie-consent localStorage key (#352). When consent
     is absent or revoked, also clears any legacy _ga / _gid / _gcl_au cookies left over
     from before this gate landed; kept in sync with clearAnalyticsCookies() in
     src/utils/analytics.js. Cookieless pings still flow under default-denied for aggregate
     measurement, but no analytics or ad cookies persist. -->`

const CONSENT_INIT_BODY = `window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}gtag('js',new Date());gtag('consent','default',{analytics_storage:'denied',ad_storage:'denied',ad_user_data:'denied',ad_personalization:'denied'});var c='';try{c=localStorage.getItem('aiwatch-cookie-consent');}catch(err){}if(c==='granted'){gtag('consent','update',{analytics_storage:'granted'});}else{var h=location.hostname,EXP='expires=Thu, 01 Jan 1970 00:00:00 GMT';document.cookie.split(';').forEach(function(x){var n=x.split('=')[0].trim();if(n.indexOf('_ga')===0||n.indexOf('_gid')===0||n.indexOf('_gcl_au')===0){document.cookie=n+'=;'+EXP+';path=/;domain=.'+h+';SameSite=Lax';document.cookie=n+'=;'+EXP+';path=/;domain='+h+';SameSite=Lax';document.cookie=n+'=;'+EXP+';path=/;SameSite=Lax';}});}gtag('config','${GA4_MEASUREMENT_ID}');`

export const CONSENT_INIT_SCRIPT = `<script async src="https://www.googletagmanager.com/gtag/js?id=${GA4_MEASUREMENT_ID}"></script>
<script>${CONSENT_INIT_BODY}</script>`

/**
 * #482 — nonce-stamped GA4 bootstrap for the migrated Edge pages. Both the gtag.js loader AND
 * the inline init `<script>` carry `nonce` so an enforcing CSP (no `'unsafe-inline'` in
 * script-src) admits them — and GA4 propagates the loader's nonce to any script it injects.
 * Byte-identical body to `CONSENT_INIT_SCRIPT` (the un-migrated callers + the Jekyll copy still
 * use that const); only the `nonce=` attributes differ. Pass '' to get the no-nonce form.
 */
export function consentInitScript(nonce?: string): string {
  const n = nonce ? ` nonce="${nonce}"` : ''
  return `<script async${n} src="https://www.googletagmanager.com/gtag/js?id=${GA4_MEASUREMENT_ID}"></script>
<script${n}>${CONSENT_INIT_BODY}</script>`
}
