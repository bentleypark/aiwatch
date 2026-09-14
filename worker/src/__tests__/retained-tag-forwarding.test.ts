import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { mergeRetainedIncidentHistory, carriedIncidentTags } from '../services'
import type { MonthlyIncidentEntry } from '../monthly-archive'

// #1390 — the `derived-consumer-registry` axes catch a consumer that READS a tag wrongly. They are
// structurally blind to a forwarder that DROPS one: a rehydration which simply omits a field contains no
// `.startUnknown` for the converse scan to find, and the file sits in `SU_SAFE` on a reason that is true
// of the rest of it. That is how `mergeRetainedIncidentHistory` came to rebuild an incident from a stored
// archive row carrying `autoMonitor` and `derived` but not `startUnknown` — and once the accumulator
// began deleting an absent flag, the round-trip erased it from a permanent public record.
//
// So this asks the opposite question: does every tag the STORED type declares survive the trip back?
// The list is read off `MonthlyIncidentEntry`'s own source, not hand-maintained here, so a tag added to
// the type without being added to `carriedIncidentTags` fails CI instead of going quiet.

const ARCHIVE_SRC = new URL('../monthly-archive.ts', import.meta.url)
const SERVICES_SRC = new URL('../services.ts', import.meta.url)

/** The optional fields `MonthlyIncidentEntry` declares that a rehydration must CARRY, derived from
 *  source on both sides so neither list can drift:
 *    - minus whatever `stripInternalFields` removes. That function is the repo's own declaration of
 *      which fields are accumulator bookkeeping rather than facts about the incident (`missedRuns`, the
 *      phantom-prune counter), and it is already the trust boundary for public emission. Reading it
 *      here rather than restating it is what stops this test and that function disagreeing.
 *    - minus whatever the forwarder already assigns by name (`impact`), which is carried, just not
 *      through the shared tag object. */
function declaredTags(): string[] {
  const src = readFileSync(ARCHIVE_SRC, 'utf-8')
  const body = src.slice(src.indexOf('export interface MonthlyIncidentEntry'))
  const iface = body.slice(0, body.indexOf('\n}\n'))
  const declared = [...iface.matchAll(/^\s{2}(\w+)\?:/gm)].map((m) => m[1])

  const strip = src.slice(src.indexOf('export function stripInternalFields'))
  const stripBody = strip.slice(0, strip.indexOf('\n}\n'))
  const internal = new Set([...stripBody.matchAll(/(\w+):\s*_\w+/g)].map((m) => m[1]))
  expect(internal.size, 'stripInternalFields named nothing — its shape changed and this scan is guessing').toBeGreaterThan(0)

  const fwd = readFileSync(SERVICES_SRC, 'utf-8')
  const merge = fwd.slice(fwd.indexOf('export function mergeRetainedIncidentHistory'))
  const mergeBody = merge.slice(0, merge.indexOf('\n}\n'))
  const explicit = new Set(declared.filter((f) => new RegExp(`^\\s*${f}:\\s*entry\\.${f}\\b`, 'm').test(mergeBody)))

  return declared.filter((f) => !internal.has(f) && !explicit.has(f))
}

describe('#1390 — every qualifying tag survives the archive → live round trip', () => {
  const tags = declaredTags()

  it('finds the declared tags (the scan is not vacuous)', () => {
    expect(tags.length, 'no optional fields parsed off MonthlyIncidentEntry — the interface shape changed').toBeGreaterThanOrEqual(3)
    expect(tags, 'the tag this test was written for must be among them').toContain('startUnknown')
  })

  it('`carriedIncidentTags` carries every one of them', () => {
    const src = readFileSync(new URL('../services.ts', import.meta.url), 'utf-8')
    const fn = src.slice(src.indexOf('export function carriedIncidentTags'))
    const body = fn.slice(0, fn.indexOf('\n}\n'))
    const missing = tags.filter((t) => !body.includes(`entry.${t}`))
    expect(missing, 'a tag the archive stores is not carried back onto the rehydrated incident, so every ' +
      'guard keyed on it goes quiet for a bridged row').toEqual([])
  })

  it('the real forwarder emits them end to end', () => {
    // The source scan above proves the helper names each tag; this proves the helper is actually wired
    // into the rehydration and that the tags reach the Incident.
    const entry = {
      id: 'e1', title: 'anchored', startedAt: '2026-09-05T07:09:00Z', resolvedAt: '2026-09-05T07:09:00Z',
      durationMin: 0, finalStatus: 'resolved', impact: 'major',
      autoMonitor: true, derived: 'status_history', derivedDay: '2026-09-05', startUnknown: true,
      missedRuns: 2, // internal bookkeeping — must NOT reach the live incident
    } as unknown as MonthlyIncidentEntry
    const [out] = mergeRetainedIncidentHistory([], [entry], '2026-01-01T00:00:00Z')
    for (const t of tags) {
      expect((out as unknown as Record<string, unknown>)[t], `${t} was dropped by mergeRetainedIncidentHistory`).toBeTruthy()
    }
    expect(out.retainedBridge, 'the bridge still stamps its own tag').toBe(true)
    expect((out as unknown as Record<string, unknown>).missedRuns, 'accumulator bookkeeping must not ride back onto a live incident').toBeUndefined()
  })

  it('carries nothing the entry does not have', () => {
    // The converse: a clean entry must not acquire a tag, or every bridged row would be permanently
    // qualified and the guards would go quiet in the other direction.
    expect(carriedIncidentTags({ id: 'e2', title: 't', startedAt: 'x', resolvedAt: null, durationMin: 5, finalStatus: 'resolved' } as MonthlyIncidentEntry)).toEqual({})
  })
})
