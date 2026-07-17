// AIWatch Claude Code plugin — install CTA (#920).
//
// The plugin ships from AIWatch's OWN marketplace (`.claude-plugin/marketplace.json` at the repo
// root), so the install commands below work today and depend on no third-party review. The
// `claude-community` submission (2026-07-08) is a discovery bonus on top: it has no published SLA,
// no status API and no reviewer contact channel, so it must never gate whether users can install.
//
// PLUGIN_MARKETPLACE_URL stays empty until that submission is approved; setting it only ADDS a
// "also on the community marketplace" link — it does not turn the install CTA on. Pure + unit-tested.
export const PLUGIN_MARKETPLACE_URL = ''

// The install commands. The marketplace slug is `aiwatch-dev` (marketplace.json `name`), a namespace
// separate from the `aiwatch` plugin slug — `aiwatch@aiwatch` would read like a typo. Note
// `claude-community` is a RESERVED name upstream, so it can never be our self-published slug.
// Grep collision (unrelated, disjoint namespaces): `aiwatch-dev` is ALSO the Vercel project name
// (`.vercel/project.json` — the PRODUCTION project despite the name, see docs/reference/parallel-agents.md).
export const PLUGIN_MARKETPLACE_ADD = '/plugin marketplace add bentleypark/aiwatch'
export const PLUGIN_INSTALL_CMD = '/plugin install aiwatch@aiwatch-dev'

// Escapes text AND attribute context (the `"` matters because renderPluginInstall interpolates the
// URL into `href="…"` — defense-in-depth even though the value is a developer-controlled constant).
const escHtml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/**
 * The install section HTML. The commands are ALWAYS the primary CTA (they resolve today).
 * `url` — when set, appends a "View on the community marketplace" link (GA4 `view_plugin_marketplace`).
 * The commands live in a selectable <pre> (no copy-button JS → CSP-clean). Pure.
 */
export function renderPluginInstall(url: string): string {
  const cmds = `${escHtml(PLUGIN_MARKETPLACE_ADD)}\n${escHtml(PLUGIN_INSTALL_CMD)}`
  const link = url
    ? `\n  <a class="mkt-link" href="${escHtml(url)}" target="_blank" rel="noopener" data-ga="view_plugin_marketplace">View on the community marketplace &rarr;</a>`
    : ''
  return `<div class="install">
  <pre class="cmd">${cmds}</pre>${link}
</div>`
}
