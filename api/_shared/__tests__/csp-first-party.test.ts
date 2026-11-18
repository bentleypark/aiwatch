import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { buildCspWithHashes } from '../csp-hash'
import { buildCsp } from '../csp-nonce'
import { GITHUB_REPO_API } from '../../../src/hooks/useGitHubStars.js'

const vercel = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../../vercel.json'), 'utf8')) as {
  headers: Array<{ headers: Array<{ key: string; value: string }> }>
}
const spa = vercel.headers.flatMap((h) => h.headers).find((h) => h.key === 'Content-Security-Policy')!.value
const directive = (csp: string, name: string) => csp.split(';').map((d) => d.trim()).find((d) => d.startsWith(`${name} `))!.split(/\s+/)
const connectSrc = (csp: string) => directive(csp, 'connect-src')

// #2026 — both were blocked in production and nothing failed.
describe('connect-src admits what our own pages fetch (#2026)', () => {
  it('the SPA admits the GitHub star fetch', () => {
    expect(connectSrc(spa)).toContain(new URL(GITHUB_REPO_API).origin)
  })

  it.each([
    ['SPA vercel.json', spa],
    ['Edge hash CSP', buildCspWithHashes([]).value],
    ['Edge nonce CSP', buildCsp('n').value],
  ])('%s admits the gtag.js www.google.com/g/collect beacon', (_name, csp) => {
    expect(connectSrc(csp)).toContain('https://www.google.com')
  })
})

describe('img-src admits the gtag.js image pings (#2026)', () => {
  it.each([
    ['SPA vercel.json', spa],
    ['Edge hash CSP', buildCspWithHashes([]).value],
    ['Edge nonce CSP', buildCsp('n').value],
  ])('%s', (_name, csp) => {
    expect(directive(csp, 'img-src')).toEqual(expect.arrayContaining(['https://www.googletagmanager.com', 'https://*.google-analytics.com']))
  })
})
