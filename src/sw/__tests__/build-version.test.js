// #1889 — the browser re-installs a service worker only when /sw.js changes byte-for-byte, so two
// builds with different asset sets must emit different sw.js files.
import { describe, it, expect, afterAll } from 'vitest'
import { build } from 'vite'
import { mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { serviceWorkerBuildConfig } from '../../../vite.config.js'

const dirs = []
async function buildSw(assetVersion) {
  const outDir = mkdtempSync(join(tmpdir(), 'aiwatch-sw-'))
  dirs.push(outDir)
  await build(serviceWorkerBuildConfig(outDir, assetVersion))
  return readFileSync(join(outDir, 'sw.js'), 'utf-8')
}

afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })))

describe('sw.js build version', () => {
  it('differs between two builds with different asset versions', async () => {
    const a = await buildSw('aaaa1111')
    const b = await buildSw('bbbb2222')
    expect(a).not.toBe(b)
  })

  it('names its cache after the asset version it was built with', async () => {
    const sw = await buildSw('cccc3333')
    expect(sw).toContain('cccc3333')
    expect(sw).not.toContain('__ASSET_VERSION__')
  })
}, 60_000)
