import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseIncidentIoAllComponentUptimes } from '../parsers/incident-io'
import { auditAgedInOutOfScope } from '../roster-audit'

// #1518 — the audit check over a captured page instead of hand-built entries.
// status.fireworks.ai, 2026-09-28: the day the audit reported the two Nemotron ids.
const ENTRIES = parseIncidentIoAllComponentUptimes(
  readFileSync(join(__dirname, '..', 'parsers', '__tests__', 'fixtures', 'fireworks-page-2026-09-28.html'), 'utf8'),
)
const NOW = Date.parse('2026-09-28T00:00:00Z')

const NEMOTRON_ULTRA = '01M0VEYRP3Q4KM0RDEFG6EBBZC'
const NEMOTRON_LIGHTNING = '01M0VEYRP3YY99KM87D9CNZ7MG'

// fireworks' uptime scope before #1523, and after it added the two Nemotron ids.
const SCOPE_BEFORE = [
  '01KTM9PHXTQ0YX1ZM3TRVACTK8', '01KVEMYTCCD5S0RQWPBQZ431PE', '01KVEMZE3M15ZV46ZEB7X88H61',
  '01KYQSPPP8VB3N85P4Y2A01RSR', '01KYQSPPP80JDA3M7X73DNKHHD', '01KYQT4MDWSVEMPWCVPC90ZSA8',
  '01M03TGQ7XTQ8HAKZ8MDQ44HH5',
]
const SCOPE_AFTER = [...SCOPE_BEFORE, NEMOTRON_ULTRA, NEMOTRON_LIGHTNING]

describe('roster audit over the captured Fireworks page (#1518)', () => {
  it('reads every component the page lists, each with a date', () => {
    expect(ENTRIES).toHaveLength(17)
    expect(ENTRIES.every((e) => e.dataAvailableSince !== null)).toBe(true)
  })

  it('(b) reports exactly the two aged-in Nemotron ids against the pre-#1523 scope', () => {
    expect(auditAgedInOutOfScope(ENTRIES, SCOPE_BEFORE, [], NOW).sort()).toEqual([NEMOTRON_ULTRA, NEMOTRON_LIGHTNING].sort())
  })

  it('(b) reports nothing once they are in scope', () => {
    expect(auditAgedInOutOfScope(ENTRIES, SCOPE_AFTER, [], NOW)).toEqual([])
  })

  it('(b) reports nothing when they are excluded instead', () => {
    expect(auditAgedInOutOfScope(ENTRIES, SCOPE_BEFORE, [NEMOTRON_ULTRA, NEMOTRON_LIGHTNING], NOW)).toEqual([])
  })
})
