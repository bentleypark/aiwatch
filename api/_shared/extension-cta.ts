// "Install the Chrome extension" CTA — single source of the AIWatch extension's Web Store URL (#888/#837).
//
// Set once the extension cleared Chrome Web Store review (#837, approved 2026-07-07). While empty
// (pre-approval) renderExtInstallCta returns '' so EVERY install CTA stays invisible; filling this
// one value turns on all surfaces (is-down + landing) at the same time. Tracking params
// (?hl=…&authuser=…) are stripped — the canonical public listing URL is the id-bearing /detail path.
//
// CSP-clean: renders a plain <a> with a data-ga hook only — no inline handler; the delegated `[data-ga]`
// click listener already present on each Edge page (is-down + intro) fires the GA4 `install_extension`
// event automatically. Pure + unit-tested.
export const EXTENSION_STORE_URL = 'https://chromewebstore.google.com/detail/aiwatch-%E2%80%94-claude-status-d/mmngmhijlancegmfgcbegiackjkalocc'

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

/** Returns the install-CTA HTML, or '' when `url` is empty (CTA hidden until CWS approval). Pure. */
export function renderExtInstallCta(url: string, opts: ExtInstallCtaOpts): string {
  if (!url) return ''
  const href = escAttr(url)
  const ga = `data-ga="install_extension" data-ga-loc="${escAttr(opts.loc)}"`
  if (opts.variant === 'is-down') {
    // A single QUIET standalone strip below the answer/alert block — NOT a 5th co-equal button in the
    // crowded CTA cluster (per the #888 CRO evidence: extra competing CTAs dilute conversion; a
    // contextual, task-continuation line converts best). Muted card tone, not a loud promo banner.
    return `<div class="ext-strip"><a href="${href}" target="_blank" rel="noopener" ${ga}>🧩 Skip the manual check &mdash; see Claude's status right from your toolbar. <strong>Add to Chrome &rarr;</strong></a></div>`
  }
  // landing: a secondary button matching the cta-box button styling. Label names "Claude" explicitly —
  // the landing/dashboard is the multi-service AIWatch context, so a bare "Chrome extension" would
  // imply full coverage and mis-set expectations (the extension is Claude-only → retention/review risk).
  return `<a href="${href}" target="_blank" rel="noopener" class="btn-secondary" style="font-size:14px;padding:12px 24px;" ${ga}>🧩 Get the Claude Status extension</a>`
}
