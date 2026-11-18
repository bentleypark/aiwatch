import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { clarityInitBody, clarityInitScript, CLARITY_PROJECT_ID } from '../clarity'
import { CLARITY_ID } from '../../../src/utils/clarity.js'
import { extractInlineScripts } from '../csp-hash'

const ID = 'abc123xyz'
const w = window as unknown as { clarity?: { q?: unknown[] }; happyDOM: { setURL(u: string): void; settings: { disableJavaScriptFileLoading: boolean } } }
const tags = () => Array.from(document.querySelectorAll<HTMLScriptElement>('script[src^="https://www.clarity.ms/tag/"]'))

function run(consent: string | null, url: string) {
  w.happyDOM.setURL(url)
  const store = new Map<string, string>(consent === null ? [] : [['aiwatch-cookie-consent', consent]])
  vi.stubGlobal('localStorage', { getItem: (k: string) => store.get(k) ?? null })
  new Function(clarityInitBody(ID))()
}

beforeEach(() => {
  w.happyDOM.settings.disableJavaScriptFileLoading = true
  tags().forEach((s) => s.remove())
  delete w.clarity
})
afterEach(() => vi.unstubAllGlobals())

describe('Edge Clarity init (#2024)', () => {
  it('granted on ai-watch.dev: injects the tag and signals analytics consent', () => {
    run('granted', 'https://ai-watch.dev/is-claude-down')
    expect(tags().map((s) => s.src)).toEqual([`https://www.clarity.ms/tag/${ID}`])
    expect(Array.from(w.clarity!.q![0] as ArrayLike<unknown>)).toEqual(['consentv2', { ad_Storage: 'denied', analytics_Storage: 'granted' }])
  })

  it.each([
    ['denied', 'https://ai-watch.dev/is-claude-down'],
    [null, 'https://ai-watch.dev/is-claude-down'],
    ['granted', 'http://localhost:3333/is-claude-down'],
    ['granted', 'https://aiwatch-git-x.vercel.app/intro'],
  ])('consent %s on %s: nothing loads', (consent, url) => {
    run(consent, url)
    expect(tags()).toHaveLength(0)
    expect(w.clarity).toBeUndefined()
  })

  it('emits nothing for an empty project id, and a nonce-stamped script once it is', () => {
    expect(clarityInitScript('n0nce', '')).toBe('')
    const html = clarityInitScript('n0nce', ID)
    expect(html.startsWith('<script nonce="n0nce">')).toBe(true)
    expect(extractInlineScripts(html)).toEqual([clarityInitBody(ID)])
  })

  it('the Edge and SPA project ids are the same value', () => {
    expect(CLARITY_PROJECT_ID).toBe(CLARITY_ID)
  })

  it('refuses an id that could break out of the script string', () => {
    expect(clarityInitScript(undefined, "x';alert(1)//")).toBe('')
  })
})
