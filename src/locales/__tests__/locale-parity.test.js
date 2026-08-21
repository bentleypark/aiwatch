import { describe, it, expect } from 'vitest'
import en from '../en'
import ko from '../ko'

// #1268 — nothing checked that the two locale maps carry the same keys. `t()` falls back to rendering
// the raw dot-key, so the failure mode is a Korean reader seeing `svc.sourceUnknown.bodyProbe` on the
// card — visible only to whoever opens that exact state in that exact language, which is how it would
// have shipped: this change added one key to each file by hand, and `lint:korean` checks token leaks
// and term drift, not parity.
//
// Deliberately symmetric. An en-only key is the common direction (write the English, forget the
// Korean), but a ko-only key is just as broken for English readers and costs nothing to cover.
describe('locale parity (en ↔ ko)', () => {
  it('both maps define exactly the same keys', () => {
    const enKeys = Object.keys(en).sort()
    const koKeys = Object.keys(ko).sort()
    // Reported as the two DIFFERENCES rather than a whole-map diff, so a failure names the missing
    // key instead of printing ~850 lines.
    expect({
      missingInKo: enKeys.filter((k) => !(k in ko)),
      missingInEn: koKeys.filter((k) => !(k in en)),
    }).toEqual({ missingInKo: [], missingInEn: [] })
  })

  it('#1268 — the source-state keys ServiceDetails renders are present in BOTH locales', () => {
    // Parity alone cannot see this: deleting a key from en AND ko is symmetric, so the test above stays
    // green while every reader gets the raw dot-key rendered on the card. The component test cannot see
    // it either — it mocks `t` to the identity, so its assertions name keys, not strings.
    for (const k of [
      'svc.sourceDead.title', 'svc.sourceDead.body', 'svc.sourceDead.bodyProbe',
      'svc.sourceUnknown.title', 'svc.sourceUnknown.body', 'svc.sourceUnknown.bodyProbe',
      'svc.sourceUnknown.bodyAffected',
    ]) {
      expect(en[k], `en is missing ${k}`).toBeTruthy()
      expect(ko[k], `ko is missing ${k}`).toBeTruthy()
    }
  })

  it('no key maps to an empty string in either locale', () => {
    // An empty value renders as nothing, which is worse than the raw key: a silently missing sentence.
    const blank = (m) => Object.entries(m).filter(([, v]) => typeof v === 'string' && v.trim() === '').map(([k]) => k)
    expect({ en: blank(en), ko: blank(ko) }).toEqual({ en: [], ko: [] })
  })
})
