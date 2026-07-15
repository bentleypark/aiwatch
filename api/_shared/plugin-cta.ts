// AIWatch Claude Code plugin — community-marketplace install gate (#920, mirrors extension-cta.ts #888).
//
// EMPTY until the plugin is approved on the `claude-community` marketplace. While empty, the /plugin
// page shows a "pending review" state instead of an install command that won't resolve yet — so the
// page ships safely before approval. On approval: set PLUGIN_MARKETPLACE_URL to the community catalog
// listing URL once → the install CTA on /plugin goes live. Pure + unit-tested.
export const PLUGIN_MARKETPLACE_URL = ''

// The commands a user runs once the plugin is live (the slug is fixed / immutable, #920).
export const PLUGIN_MARKETPLACE_ADD = '/plugin marketplace add anthropics/claude-plugins-community'
export const PLUGIN_INSTALL_CMD = '/plugin install aiwatch@claude-community'

// Escapes text AND attribute context (the `"` matters because renderPluginInstall interpolates the
// URL into `href="…"` — defense-in-depth even though the value is a developer-controlled constant).
const escHtml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/**
 * The install section HTML — gated on PLUGIN_MARKETPLACE_URL.
 * - empty  → a "pending community-marketplace review" note + the commands (shown for reference).
 * - set    → the commands as the primary CTA + a "View on the marketplace" link (GA4 `view_plugin_marketplace`).
 * The commands live in a selectable <pre> (no copy-button JS → CSP-clean). Pure.
 */
export function renderPluginInstall(url: string): string {
  const cmds = `${escHtml(PLUGIN_MARKETPLACE_ADD)}\n${escHtml(PLUGIN_INSTALL_CMD)}`
  if (!url) {
    return `<div class="install install--pending">
  <p class="install-note">🚧 In review on the Claude Code community marketplace. Once approved, install it with:</p>
  <pre class="cmd">${cmds}</pre>
</div>`
  }
  const href = escHtml(url)
  return `<div class="install">
  <pre class="cmd">${cmds}</pre>
  <a class="mkt-link" href="${href}" target="_blank" rel="noopener" data-ga="view_plugin_marketplace">View on the community marketplace &rarr;</a>
</div>`
}
