// "Install the extension" CTA — single source of the AIWatch extension's store URLs (#888/#837/#1773).
//
// Each URL is set once its store approved the extension (Chrome Web Store #837, 2026-07-07; Firefox
// Add-ons #1773). An empty URL drops that store's link; with both empty renderExtInstallCta returns ''
// so EVERY install CTA stays invisible. CWS tracking params (?hl=…&authuser=…) are stripped — the
// canonical public listing URL is the id-bearing /detail path.
//
// CSP-clean: renders a plain <a> with a data-ga hook only — no inline handler; the delegated `[data-ga]`
// click listener already present on each Edge page (is-down + intro) fires the GA4 `install_extension`
// event automatically. Pure + unit-tested.
export const EXTENSION_STORE_URL = 'https://chromewebstore.google.com/detail/aiwatch-%E2%80%94-claude-status-d/mmngmhijlancegmfgcbegiackjkalocc'
// The same package on Firefox Add-ons (#1773), without a locale segment.
export const FIREFOX_ADDON_URL = 'https://addons.mozilla.org/firefox/addon/aiwatch-claude-status/'

// Both links render side by side rather than branching on the browser: the is-down page is edge-cached
// (api/is-down.ts sends no Vary header, so one HTML serves every User-Agent), and a client-side switch would add a script to the page CSP.
export interface ExtStoreUrls {
  chrome: string
  firefox: string
}
export const EXTENSION_STORES: ExtStoreUrls = { chrome: EXTENSION_STORE_URL, firefox: FIREFOX_ADDON_URL }

const escAttr = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

// The extension is Claude-ONLY (#837), but the is-down pages cover other services too — so the install CTA
// renders only on the three Anthropic surfaces' pages (a Claude extension on /is-openai-down is a
// mismatch). Exported + unit-tested. Landing (/intro) is Claude-focused so it's ungated there.
export const CLAUDE_SURFACE_IDS = ['claude', 'claudeai', 'claudecode'] as const
export function isClaudeSurface(svcId: string): boolean {
  return (CLAUDE_SURFACE_IDS as readonly string[]).includes(svcId)
}

export interface ExtInstallCtaOpts {
  /** GA4 data-ga-loc (e.g. 'is_down_page' | 'landing_cta'). */
  loc: string
  /** Per-surface markup: the is-down standalone quiet strip vs the landing cta-box button. */
  variant: 'is-down' | 'landing'
}

// Each store's own official badge, served from public/store-badges/ and shown unmodified (both stores
// allow it only that way, linking to the listing): developer.chrome.com/docs/webstore/branding and
// extensionworkshop.com/documentation/publish/promoting-your-extension. `w`/`h` are the source ratio.
const STORE_BADGES: Record<keyof ExtStoreUrls, { src: string; alt: string; w: number; h: number }> = {
  chrome: { src: '/store-badges/chrome-web-store.png', alt: 'Available in the Chrome Web Store', w: 340, h: 96 },
  firefox: { src: '/store-badges/firefox-get-the-addon.svg', alt: 'Get the add-on for Firefox', w: 172, h: 60 },
}
const BADGE_HEIGHT = 40

/** Returns the install-CTA HTML — one store badge link per non-empty store URL, or '' when both are
 *  empty. Pure. Each link carries data-ga-source=<store> so install_extension clicks split by store. */
export function renderExtInstallCta(urls: ExtStoreUrls, opts: ExtInstallCtaOpts): string {
  const stores = (Object.keys(STORE_BADGES) as (keyof ExtStoreUrls)[]).filter((k) => urls[k])
  if (stores.length === 0) return ''
  const badges = stores.map((k) => {
    const b = STORE_BADGES[k]
    const w = Math.round((b.w * BADGE_HEIGHT) / b.h)
    return `<a href="${escAttr(urls[k])}" target="_blank" rel="noopener" data-ga="install_extension" data-ga-loc="${escAttr(opts.loc)}" data-ga-source="${k}"><img src="${b.src}" alt="${b.alt}" width="${w}" height="${BADGE_HEIGHT}"></a>`
  }).join(' ')
  if (opts.variant === 'is-down') {
    // A single QUIET standalone strip below the answer/alert block — NOT a 5th co-equal button in the
    // crowded CTA cluster (per the #888 CRO evidence: extra competing CTAs dilute conversion; a
    // contextual, task-continuation line converts best). Muted card tone, not a loud promo banner.
    return `<div class="ext-strip">🧩 Skip the manual check &mdash; see Claude's status right from your toolbar.<br>${badges}</div>`
  }
  // landing: its own row under the cta-box buttons. The caption names "Claude" explicitly — the landing
  // is the multi-service AIWatch context, so a bare "extension" would imply full coverage and mis-set
  // expectations (the extension is Claude-only → retention/review risk).
  return `<div class="ext-badges"><p>🧩 Claude Status browser extension</p>${badges}</div>`
}
