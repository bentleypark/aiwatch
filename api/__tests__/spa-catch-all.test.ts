// #1386 — the SPA catch-all must not answer for a build asset.
//
// A deleted `/assets/<hash>` that fell through to `/index.html` was served as HTTP 200 `text/html`,
// not 404. The browser refuses the module script on its MIME type and the page renders blank — no
// thrown error, so no error boundary sees it.
//
// What this pins is the rewrite RULE, by compiling the `source` as a JavaScript regex. That is not
// Vercel's matcher (path-to-regexp differs on case and trailing slash) and it observes no response,
// so it cannot prove what a missing asset actually returns in production — only that the rule no
// longer claims it. The response itself needs one HTTP check against the deployment; #1386 carries
// it as a production-gated line.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../..')
const vercelConfig = JSON.parse(readFileSync(join(repoRoot, 'vercel.json'), 'utf8')) as {
  rewrites: { source: string; destination: string }[]
}

const catchAll = vercelConfig.rewrites.find((r) => r.destination === '/index.html')

describe('SPA catch-all rewrite', () => {
  it('exists and is the last rewrite', () => {
    expect(catchAll, 'no rewrite falls back to /index.html — this whole file is stale').toBeTruthy()
    expect(vercelConfig.rewrites[vercelConfig.rewrites.length - 1]).toBe(catchAll)
  })

  it('does not answer for a build asset', () => {
    const re = new RegExp(`^${catchAll!.source}$`)
    for (const path of [
      '/assets/index-D_6fVe87.js',
      '/assets/index-Du56x5t1.css',
      '/assets/chart-Bbj5VxSj.js',
    ]) {
      expect(re.test(path), `${path} would be rewritten to the SPA shell instead of 404`).toBe(false)
    }
  })

  it('still answers for the SPA routes it exists for', () => {
    const re = new RegExp(`^${catchAll!.source}$`)
    for (const path of ['/', '/anything', '/deep/link', '/assetsx']) {
      expect(re.test(path), `${path} no longer reaches the SPA shell`).toBe(true)
    }
  })
})
