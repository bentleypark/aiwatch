import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { hashToPage, pageToHash, PAGE_NAMES } from '../hashRoute'

describe('hashToPage', () => {
  let replaceSpy
  let historySpy

  beforeEach(() => {
    replaceSpy = vi.spyOn(window.location, 'replace').mockImplementation(() => {})
    historySpy = vi.spyOn(window.history, 'replaceState').mockImplementation(() => {})
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('maps an empty hash to overview', () => {
    expect(hashToPage('')).toEqual({ name: 'overview' })
    expect(hashToPage('#')).toEqual({ name: 'overview' })
  })

  it('maps known page hashes to their page', () => {
    for (const name of PAGE_NAMES) {
      expect(hashToPage(`#${name}`)).toMatchObject({ name })
    }
  })

  // #673: the deleted in-dashboard #about-score page must redirect to the public
  // /methodology page Score section so externally-referenced links (the monthly
  // report + bookmarks) never 404.
  it('redirects legacy #about-score to /methodology#score', () => {
    const page = hashToPage('#about-score')
    expect(replaceSpy).toHaveBeenCalledWith('/methodology#score')
    expect(page).toEqual({ name: 'overview' })
  })

  it('does NOT redirect ordinary page hashes', () => {
    hashToPage('#latency')
    hashToPage('#ranking')
    expect(replaceSpy).not.toHaveBeenCalled()
  })

  it('carries a ?focus= suffix onto the settings page (#546)', () => {
    expect(hashToPage('#settings?focus=alerts')).toEqual({ name: 'settings', focus: 'alerts' })
    expect(hashToPage('#settings')).toEqual({ name: 'settings' })
  })

  it('carries ?service= and ?period= onto the incidents page (#1612)', () => {
    expect(hashToPage('#incidents?service=openai&period=30')).toEqual({ name: 'incidents', filters: { service: 'openai', period: 30 } })
    expect(hashToPage('#incidents?period=90')).toEqual({ name: 'incidents', filters: { period: 90 } })
  })

  it('drops an unknown incidents filter value instead of applying it (#1612)', () => {
    expect(hashToPage('#incidents?service=not-a-service&period=14')).toEqual({ name: 'incidents' })
    expect(hashToPage('#incidents?service=claude&period=abc')).toEqual({ name: 'incidents', filters: { service: 'claude' } })
  })

  it('resolves a service id to a service page', () => {
    expect(hashToPage('#claude')).toEqual({ name: 'service', serviceId: 'claude' })
  })

  it('cleans up an unknown hash and falls back to overview', () => {
    expect(hashToPage('#nonsense-xyz')).toEqual({ name: 'overview' })
    expect(historySpy).toHaveBeenCalled()
    expect(replaceSpy).not.toHaveBeenCalled()
  })
})

describe('pageToHash', () => {
  it('round-trips page names', () => {
    expect(pageToHash({ name: 'overview' })).toBe('')
    expect(pageToHash({ name: 'latency' })).toBe('#latency')
    expect(pageToHash({ name: 'service', serviceId: 'openai' })).toBe('#openai')
  })
})
