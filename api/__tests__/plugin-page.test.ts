import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import {
  renderPluginInstall,
  PLUGIN_MARKETPLACE_URL,
  PLUGIN_MARKETPLACE_ADD,
  PLUGIN_INSTALL_CMD,
} from '../_shared/plugin-cta'
import { renderPluginPage } from '../_plugin/html-template'

// #920 — the /plugin Edge SSR landing page. Pins the install commands against the shipped catalog +
// the CSP/SEO contract, so the page can't silently regress to a non-indexable or inline-handler
// (CSP-breaking) shape, nor to publishing a command that resolves for nobody.

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../..')

type Marketplace = {
  name: string
  owner?: { name?: string }
  plugins: Array<{ name: string; source: string }>
}
const marketplace = JSON.parse(
  readFileSync(join(repoRoot, '.claude-plugin/marketplace.json'), 'utf8'),
) as Marketplace

const manifest = JSON.parse(
  readFileSync(join(repoRoot, 'plugin/aiwatch/.claude-plugin/plugin.json'), 'utf8'),
) as { name: string; version: string; repository: string }

// The bug this pins: for months the page published `/plugin install aiwatch@claude-community` while
// the repo had no marketplace.json at all, so NO command on the page resolved. A published install
// command is only real if it matches the catalog we actually ship — assert that, don't trust prose.
describe('marketplace.json ↔ published install command (#920 drift pin)', () => {
  it('serves exactly the plugin the /plugin page tells users to install', () => {
    const entry = marketplace.plugins.find((p) => p.name === 'aiwatch')
    expect(entry, 'marketplace.json must list the `aiwatch` plugin').toBeDefined()
    // `/plugin install <plugin>@<marketplace>` — both halves come from marketplace.json.
    expect(PLUGIN_INSTALL_CMD).toBe(`/plugin install ${entry!.name}@${marketplace.name}`)
  })

  it('points `source` at a real plugin dir with a manifest whose name matches', () => {
    const entry = marketplace.plugins.find((p) => p.name === 'aiwatch')!
    const manifestPath = join(repoRoot, entry.source, '.claude-plugin/plugin.json')
    expect(existsSync(manifestPath), `${entry.source} must contain .claude-plugin/plugin.json`).toBe(true)
    // Read through `source` — NOT the module-scope `manifest`. Asserting the hardcoded path here would
    // pass even when `source` points at a decoy plugin, which is the exact drift this test exists to catch.
    const sourced = JSON.parse(readFileSync(manifestPath, 'utf8')) as typeof manifest
    expect(sourced.name).toBe(entry.name)
    // An explicit `version` is deliberate, NOT an oversight to clean up: omitting it makes Claude Code
    // fall back to the git commit SHA, and in THIS monorepo every SPA/worker commit would then read as
    // a new plugin release. The cost is that a plugin change without a bump ships to nobody — hence the
    // release rule in docs/reference/directory-map.md. Bump it when plugin/aiwatch/** changes.
    expect(sourced.version).toMatch(/^\d+\.\d+\.\d+/)
  })

  it('uses a marketplace slug that is neither reserved upstream nor the plugin slug', () => {
    // The full reserved-name list as of the plugin-marketplaces doc (upstream also blocks impersonation
    // patterns like `official-claude-plugins`, which aren't enumerable). Upstream ADDS to this list over
    // time — `first-party-plugins`/`healthcare` only became reserved in v2.1.205 — and a marketplace
    // already registered under a newly-reserved name stops loading as an untrusted source. So re-check
    // upstream on any rename; a name that's safe today can be reserved tomorrow.
    const RESERVED = [
      'claude-code-marketplace', 'claude-code-plugins', 'claude-plugins-official',
      'claude-plugins-community', 'claude-community', 'anthropic-marketplace',
      'anthropic-plugins', 'agent-skills', 'anthropic-agent-skills',
      'knowledge-work-plugins', 'life-sciences', 'claude-for-legal',
      'claude-for-financial-services', 'financial-services-plugins',
      'first-party-plugins', 'healthcare',
    ]
    expect(RESERVED).not.toContain(marketplace.name)
    expect(marketplace.name).toMatch(/^[a-z0-9-]+$/)   // kebab-case, no spaces
    expect(marketplace.owner?.name).toBeTruthy()       // required by the schema
  })

  // The READMEs hand-repeat the commands rather than importing them, and they're the most-read
  // surface — so the "published command nobody can run" bug lands here too if they drift.
  // (plugin-privacy.test.ts sets the precedent of pinning facts against plugin/aiwatch/README.md.)
  it.each([
    'README.md',
    'README.ko.md',
    'plugin/aiwatch/README.md',
  ])('%s documents the same install commands the /plugin page serves', (relPath) => {
    const doc = readFileSync(join(repoRoot, relPath), 'utf8')
    expect(doc).toContain(PLUGIN_MARKETPLACE_ADD)
    expect(doc).toContain(PLUGIN_INSTALL_CMD)
    expect(doc).not.toContain('aiwatch@claude-community')   // the command that resolved for nobody
  })

  it('adds the marketplace from the repo that actually hosts marketplace.json', () => {
    // Derived from the manifest's own `repository`, so a repo move breaks the published command here
    // rather than in a stranger's terminal. `/plugin marketplace add` takes the bare `owner/repo`.
    const ownerRepo = manifest.repository.replace(/^https:\/\/github\.com\//, '')
    expect(ownerRepo).toMatch(/^[\w.-]+\/[\w.-]+$/)
    expect(PLUGIN_MARKETPLACE_ADD).toBe(`/plugin marketplace add ${ownerRepo}`)
  })
})

describe('renderPluginInstall (#920)', () => {
  it('always shows the working install commands — never gated on the community review', () => {
    const out = renderPluginInstall('')
    expect(out).toContain(PLUGIN_MARKETPLACE_ADD)
    expect(out).toContain(PLUGIN_INSTALL_CMD)
    expect(out).not.toContain('In review')                          // install works today
    expect(out).not.toContain('View on the community marketplace')  // no link when the URL is empty
  })

  it('ships with the community listing still pending', () => {
    // Tripwire, not a rule: on approval day, setting the URL fails this ONE test as the reminder to
    // re-point it. Kept out of the render tests below so that day doesn't look like a logic break.
    expect(PLUGIN_MARKETPLACE_URL).toBe('')
  })

  it('appends the listing link only once the URL is set', () => {
    const out = renderPluginInstall('https://github.com/anthropics/claude-plugins-community')
    expect(out).toContain(PLUGIN_INSTALL_CMD)   // commands unchanged — the link is additive
    expect(out).toContain('View on the community marketplace')
    expect(out).toContain('data-ga="view_plugin_marketplace"')
  })

  it('HTML-escapes to stay injection-safe', () => {
    // The commands are static, but the render must not emit a raw < that could break out of markup.
    expect(renderPluginInstall('')).not.toMatch(/<script/i)
    expect(renderPluginInstall('https://x.test/"><script>alert(1)</script>')).not.toMatch(/<script/i)
  })
})

describe('renderPluginPage SSR contract (#920)', () => {
  const html = renderPluginPage('test-nonce')

  it('is an indexable HTML doc with the canonical /plugin URL + SoftwareApplication JSON-LD', () => {
    expect(html).toContain('<!DOCTYPE html>')
    expect(html).toContain('<link rel="canonical" href="https://ai-watch.dev/plugin">')
    expect(html).toContain('<meta name="robots" content="index, follow">')
    expect(html).toContain('"@type":"SoftwareApplication"')
    expect(html).toContain('AIWatch for Claude Code')
  })

  it('is CSP-clean — no inline event handlers; the one <script> carries the nonce', () => {
    expect(html).not.toMatch(/\son[a-z]+=/i)          // no on*="..." inline handlers
    expect(html).toContain('<script nonce="test-nonce">')
  })

  it('renders the install section + the discoverability cross-link to the statusline guide', () => {
    expect(html).toContain(PLUGIN_INSTALL_CMD)
    expect(html).toContain('ai-watch.dev/#statusline')
  })
})
