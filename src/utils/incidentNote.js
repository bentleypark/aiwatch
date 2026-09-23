/**
 * Which explanatory note an incident row carries, as ONE decision both pages call.
 *
 * Three populations reach a reader with a duration they must not read literally, and each needs a
 * different sentence. Inlined as a ternary in each page, the choice was pinned only by comparing where
 * the two key names appear in the file's text — which passes for a dead branch and for a swapped order
 * alike (#1480 review). A function is what a test can drive with an incident and an assertion.
 *
 * ORDER IS LOAD-BEARING: a zero-length record carries `startUnknown` too, so it must be tested first
 * or it silently receives #1390's note, which claims the provider published a recovery before the
 * start — something a zero-length source never did.
 */
export function incidentNoteKey(incident) {
  if (incident?.derived === 'status_history') return 'incidents.derived.note'
  if (incident?.zeroLengthRecord) return 'incidents.zeroLengthRecord.note'
  if (incident?.startUnknown) return 'incidents.startUnknown.note'
  return undefined
}

/** The rendered note, or undefined when the incident needs none. */
export function incidentNote(incident, t) {
  const key = incidentNoteKey(incident)
  return key ? t(key) : undefined
}
