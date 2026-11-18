import { describe, test, expect, beforeEach } from 'vitest'
import { shouldLoadClarity, initClarity, clearClarityCookies, clarityTagUrl } from '../clarity.js'

const hasClarityCookie = () => /(^|;\s*)_cl(ck|sk)=/.test(document.cookie)

const ID = 'abc123xyz'
const tags = () => document.querySelectorAll('script[src^="https://www.clarity.ms/tag/"]')

beforeEach(() => {
  window.happyDOM.settings.disableJavaScriptFileLoading = true
  tags().forEach((s) => s.remove())
  delete window.clarity
})

describe('shouldLoadClarity (#2024)', () => {
  test.each([
    [{ id: ID, consent: 'granted', host: 'ai-watch.dev' }, true],
    [{ id: ID, consent: 'denied', host: 'ai-watch.dev' }, false],
    [{ id: ID, consent: null, host: 'ai-watch.dev' }, false],
    [{ id: ID, consent: 'granted', host: 'localhost' }, false],
    [{ id: ID, consent: 'granted', host: 'aiwatch-git-x.vercel.app' }, false],
    [{ id: '', consent: 'granted', host: 'ai-watch.dev' }, false],
    [{ id: undefined, consent: 'granted', host: 'ai-watch.dev' }, false],
    [{ id: 'bad id"><script>', consent: 'granted', host: 'ai-watch.dev' }, false],
  ])('%o → %s', (input, expected) => {
    expect(shouldLoadClarity(input)).toBe(expected)
  })
})

describe('initClarity', () => {
  test('granted: injects the tag once and signals analytics consent', () => {
    expect(initClarity('granted', { id: ID, host: 'ai-watch.dev' })).toBe(true)
    expect(initClarity('granted', { id: ID, host: 'ai-watch.dev' })).toBe(false)
    expect([...tags()].map((s) => s.src)).toEqual([clarityTagUrl(ID)])
    expect(Array.from(window.clarity.q[0])).toEqual(['consentv2', { ad_Storage: 'denied', analytics_Storage: 'granted' }])
  })

  test.each([['denied'], [null]])('consent %s: no tag, no clarity global', (consent) => {
    expect(initClarity(consent, { id: ID, host: 'ai-watch.dev' })).toBe(false)
    expect(tags()).toHaveLength(0)
    expect(window.clarity).toBeUndefined()
  })

  test('any host but ai-watch.dev (local, preview): no tag even with consent', () => {
    expect(initClarity('granted', { id: ID, host: 'localhost' })).toBe(false)
    expect(tags()).toHaveLength(0)
  })
})

describe('Clarity cookies after a revoke', () => {
  test('a denied consent on load removes _clck / _clsk', () => {
    document.cookie = '_clck=abc;path=/'
    document.cookie = '_clsk=def;path=/'
    expect(hasClarityCookie()).toBe(true)
    initClarity('denied', { id: ID, host: 'ai-watch.dev' })
    expect(hasClarityCookie()).toBe(false)
  })

  test('clearClarityCookies removes them', () => {
    document.cookie = '_clck=abc;path=/'
    clearClarityCookies()
    expect(hasClarityCookie()).toBe(false)
  })

  test('an absent consent leaves cookies alone', () => {
    document.cookie = '_clck=abc;path=/'
    initClarity(null, { id: ID, host: 'ai-watch.dev' })
    expect(hasClarityCookie()).toBe(true)
    document.cookie = '_clck=;expires=Thu, 01 Jan 1970 00:00:00 GMT;path=/'
  })
})
