import { describe, it, expect } from 'vitest'
import en from '../en.js'
import ko from '../ko.js'

// #537 — Overview stat cards must render a SHORT label (top) + a DISTINCT descriptive
// sub (bottom), not the same phrase twice. The bug: operational/degraded cards passed the
// same i18n key to both `labelKey` and `sub` (Overview.jsx StatCard), so "services running"
// / "partially affected" printed twice. This pins the i18n contract the fix established:
// every stat card has a non-empty `.sub` key whose text differs from its label, in both locales.
const CARDS = ['operational', 'degraded', 'down', 'uptime']

describe('Overview stat-card label/sub i18n contract (#537)', () => {
  for (const [name, map] of [['en', en], ['ko', ko]]) {
    describe(name, () => {
      for (const card of CARDS) {
        const labelKey = `overview.stats.${card}`
        const subKey = `overview.stats.${card}.sub`
        it(`${card}: label + sub both present and not identical`, () => {
          expect(map[labelKey], `${labelKey} missing`).toBeTruthy()
          expect(map[subKey], `${subKey} missing`).toBeTruthy()
          expect(map[labelKey]).not.toBe(map[subKey])
        })
      }
    })
  }
})
