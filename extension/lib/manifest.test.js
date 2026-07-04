import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

// Chrome Web Store manifest limits (#837) — the upload is REJECTED if these are exceeded, so pin
// them: manifest.description ≤132 (the actual reject we hit — CWS returned "146 > 132"), and a
// short name (≤45 — the store-listing *title* limit; manifest.name itself allows 75, but keeping
// the stricter bound keeps the toolbar + listing title tight). Catches a listing-copy edit that
// would fail the upload before it ships.
const manifest = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'manifest.json'), 'utf8'),
)

describe('extension manifest — Chrome Web Store limits (#837)', () => {
  it('description is within the 132-char CWS limit', () => {
    expect(manifest.description.length).toBeLessThanOrEqual(132)
  })
  it('name is within the 45-char CWS limit', () => {
    expect(manifest.name.length).toBeLessThanOrEqual(45)
  })
  it('is MV3 with a version and the minimal permission set', () => {
    expect(manifest.manifest_version).toBe(3)
    expect(manifest.version).toBeTruthy()
    expect(manifest.permissions).toEqual(['alarms', 'storage'])
    // host_permissions must stay the single AIWatch origin (no broad <all_urls>/tabs — review + trust)
    expect(manifest.host_permissions).toEqual(['https://aiwatch-worker.p2c2kbf.workers.dev/*'])
  })
})
