// #2024 — Microsoft Clarity on the Edge SSR pages, for visitors who granted analytics consent only.
// Same rule as the SPA (src/utils/clarity.js): the tag is injected only when the stored consent is
// 'granted' and the page is served from ai-watch.dev. A visitor who accepts on this page's banner
// gets Clarity from the next page load on.

export const CLARITY_PROJECT_ID = 'zfdscev1gz'

const ID_RE = /^[a-z0-9]{6,20}$/i

export function clarityInitBody(id: string): string {
  return `(function(){var c=null;try{c=localStorage.getItem('aiwatch-cookie-consent')}catch(err){}if(c!=='granted'||location.hostname!=='ai-watch.dev')return;window.clarity=window.clarity||function(){(window.clarity.q=window.clarity.q||[]).push(arguments)};window.clarity('consentv2',{ad_Storage:'denied',analytics_Storage:'granted'});var t=document.createElement('script');t.async=true;t.src='https://www.clarity.ms/tag/${id}';document.head.appendChild(t)})();`
}

export function clarityInitScript(nonce?: string, id: string = CLARITY_PROJECT_ID): string {
  if (!ID_RE.test(id)) return ''
  const n = nonce ? ` nonce="${nonce}"` : ''
  return `<script${n}>${clarityInitBody(id)}</script>`
}
