import { describe, it, expect } from 'vitest'
import { REPORT_ORIGIN } from '../latest-report'
import { UPSTREAM_ORIGIN } from '../../../api/reports'

describe('report publication probe ↔ api/reports proxy origin (#2022)', () => {
  it('probes the same GitHub Pages origin the reports proxy forwards to', () => {
    expect(REPORT_ORIGIN).toBe(UPSTREAM_ORIGIN)
  })
})
