import { describe, it, expect } from 'vitest'
import { SERVICES } from '../services'

const tl = SERVICES.find((s) => s.id === 'twelvelabs')!

const JOCKEY_IDS = ['j86pqszy5w90', '27kd6568skjp', '3pksbw640gn9', 'rgbmm56z696d', 'sjbv0n38bs7n', 'cns848tdzn22', 'jzy4m39608m3']

describe('twelvelabs component groups', () => {
  it('puts the seven Jockey components under Jockey and every other displayed component under APIs', () => {
    const groups = tl.componentGroups!
    for (const id of tl.displayComponentIds!) expect(groups[id]).toBe(JOCKEY_IDS.includes(id) ? 'Jockey' : 'APIs')
    expect(JOCKEY_IDS.every((id) => tl.displayComponentIds!.includes(id))).toBe(true)
  })

  it('keeps the APIs group header out of the displayed components', () => {
    expect(tl.displayComponentIds).not.toContain(tl.statusComponentId)
  })
})
