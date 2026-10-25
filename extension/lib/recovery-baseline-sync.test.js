// #1772 — pins render.js's hand copy of the past-recovery sentence to the worker's canonical one.
import { describe, it, expect } from 'vitest'
import { recoveryBaselineText } from './render.js'
import { recoveryBaselineText as canonical } from '../../worker/src/recovery-baseline-text'

describe('recoveryBaselineText ↔ worker/src/recovery-baseline-text sync (#1772)', () => {
  it('produces the same sentence', () => {
    for (const [medianMin, p80Min] of [[0, 45], [60, 120], [64, 161], [119.6, 1500]]) {
      const b = { n: 12, medianMin, p80Min, since: '2026-07-22' }
      expect(recoveryBaselineText(b)).toBe(canonical(b))
    }
  })
})
