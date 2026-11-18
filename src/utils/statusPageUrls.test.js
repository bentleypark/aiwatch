import { describe, it, expect } from 'vitest'
import { STATUS_URL, STATUS_SOURCES } from './statusPageUrls.js'
import en from '../locales/en.js'
import ko from '../locales/ko.js'

describe('STATUS_SOURCES (multi-link services)', () => {
  const entries = Object.entries(STATUS_SOURCES)

  it('lists Lyceum with its own page first and the Instatus data source second (#1979)', () => {
    expect(STATUS_SOURCES.lyceum.map((s) => s.url)).toEqual([
      'https://status.lyceum.technology',
      'https://caspar.instatus.com',
    ])
  })

  it.each(entries)('%s: the first link is the STATUS_URL fallback', (id, sources) => {
    expect(sources[0].url).toBe(STATUS_URL[id])
  })

  it.each(entries)('%s: every link is https and every label exists in en and ko', (id, sources) => {
    for (const { url, labelKey } of sources) {
      expect(url).toMatch(/^https:\/\//)
      expect(en[labelKey], `en.${labelKey}`).toBeTruthy()
      expect(ko[labelKey], `ko.${labelKey}`).toBeTruthy()
    }
  })

  it.each(entries)('%s: links are distinct', (id, sources) => {
    expect(new Set(sources.map((s) => s.url)).size).toBe(sources.length)
  })
})
