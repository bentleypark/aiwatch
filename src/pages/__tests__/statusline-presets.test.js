import { describe, it, expect } from 'vitest'
import { PRESET_BRANDED, SLUG_BRANDED } from '../Statusline.jsx'

// #918 — server-side rendering: the presets are now thin `curl … || true` snippets
// that hit `/api/statusline/<preset>` (the Worker renders the final string). This pins
// the snippet CONTRACT — worker domain, per-preset path, fail-silent, no jq — so it
// can't silently drift. The DISPLAY logic (names, +N overflow, OSC-8) is tested in the
// worker's statusline.test.ts (`renderStatuslinePreset`), where it now lives.
describe('PRESET_BRANDED statusline snippet (#918 server-rendered)', () => {
  const parsed = JSON.parse(PRESET_BRANDED) // also asserts it is valid JSON
  const cmd = parsed.statusLine.command

  it('is the command-type settings.json shape', () => {
    expect(parsed.statusLine.type).toBe('command')
    expect(typeof cmd).toBe('string')
  })

  it('polls the Worker domain at the per-preset path — never the Vercel-proxied path (#438)', () => {
    expect(SLUG_BRANDED).toBe('branded')
    expect(cmd).toContain('aiwatch-worker.p2c2kbf.workers.dev/api/statusline/branded')
    expect(cmd).not.toContain('ai-watch.dev/api/') // must not route polls through Vercel
  })

  it('carries the preset in the PATH, not a ?src query tag (WAE tags on the path now)', () => {
    expect(cmd).not.toContain('?src=')
  })

  it('is a thin curl with no jq — all formatting moved server-side (#918)', () => {
    expect(cmd).not.toContain('jq')
    expect(cmd).not.toContain('.services[]')
    expect(cmd).toContain('curl -sf --max-time 2')
  })

  it('fails silent (no error leaks into the statusline)', () => {
    expect(cmd).toContain('2>/dev/null || true')
  })
})
