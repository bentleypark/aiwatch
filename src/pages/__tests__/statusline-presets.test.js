import { describe, it, expect } from 'vitest'
import { PRESET_BRANDED, SLUG_BRANDED } from '../Statusline.jsx'

// #543 — the "branded" statusline preset: an always-on, clickable AIWatch label
// (OSC 8 → dashboard) + 🟢 healthy / 🔴 <name> degraded. Pins the escaping contract
// so the OSC 8 hyperlink, the dashboard target, the worker-domain endpoint (#438),
// and the analytics tag can't silently drift.
describe('PRESET_BRANDED statusline snippet (#543)', () => {
  const parsed = JSON.parse(PRESET_BRANDED) // also asserts it is valid JSON
  const cmd = parsed.statusLine.command

  it('is the command-type settings.json shape', () => {
    expect(parsed.statusLine.type).toBe('command')
    expect(typeof cmd).toBe('string')
  })

  it('polls the Worker domain with the branded src tag — never the Vercel-proxied path (#438)', () => {
    expect(SLUG_BRANDED).toBe('branded')
    expect(cmd).toContain('aiwatch-worker.p2c2kbf.workers.dev/api/status/cached')
    expect(cmd).toContain('?src=statusline-branded')
    expect(cmd).not.toContain('ai-watch.dev/api/status') // must not route status polls through Vercel
  })

  it('wraps an always-on AIWatch label in an OSC 8 hyperlink to the dashboard home', () => {
    // jq source emits ESC]8;;https://ai-watch.dev ESC\ AIWatch ESC]8;; ESC\
    expect(cmd).toContain('\\u001b]8;;https://ai-watch.dev\\u001b\\\\AIWatch\\u001b]8;;\\u001b\\\\')
  })

  it('also links each degraded service name to its detail page (ai-watch.dev/#<id>)', () => {
    expect(cmd).toContain('\\u001b]8;;https://ai-watch.dev/#\\(.id)\\u001b\\\\🔴 \\(.name)\\u001b]8;;\\u001b\\\\')
  })

  it('shows 🟢 when all healthy and 🔴 <name> (≤3) when degraded', () => {
    expect(cmd).toContain('select(.status != "operational")')
    expect(cmd).toContain('"🟢"')
    expect(cmd).toContain('🔴 \\(.name)') // red name inside the per-service OSC 8 link
    expect(cmd).toContain('.[0:3]')
  })

  it('fails silent (no error leaks into the statusline)', () => {
    expect(cmd).toContain('2>/dev/null || true')
  })
})
