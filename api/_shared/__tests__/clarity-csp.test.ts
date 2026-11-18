import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { buildCspWithHashes } from '../csp-hash'
import { buildCsp } from '../csp-nonce'

const vercel = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../../vercel.json'), 'utf8')) as {
  headers: Array<{ headers: Array<{ key: string; value: string }> }>
}
const spa = vercel.headers.flatMap((h) => h.headers).find((h) => h.key === 'Content-Security-Policy')!.value

const directive = (csp: string, name: string) => csp.split(';').map((d) => d.trim()).find((d) => d.startsWith(`${name} `))!.split(/\s+/)

// Hosts read from the live tag response (https://www.clarity.ms/tag/<id>): the tag loads
// scripts.clarity.ms/<ver>/clarity.js, uploads to a <letter>.clarity.ms/collect, pixels c.clarity.ms/c.gif.
const NEEDS = {
  'script-src': ['https://www.clarity.ms', 'https://scripts.clarity.ms'],
  'connect-src': ['https://*.clarity.ms'],
  'img-src': ['https://*.clarity.ms'],
}

describe('every CSP admits Microsoft Clarity (#2024)', () => {
  it.each([
    ['SPA vercel.json', spa],
    ['Edge hash CSP', buildCspWithHashes([]).value],
    ['Edge nonce CSP', buildCsp('n').value],
  ])('%s', (_name, csp) => {
    for (const [d, hosts] of Object.entries(NEEDS)) {
      expect(directive(csp, d), d).toEqual(expect.arrayContaining(hosts))
    }
    expect(csp, 'c.bing.com sets the Bing MUID cookie').not.toContain('bing.com')
  })
})
