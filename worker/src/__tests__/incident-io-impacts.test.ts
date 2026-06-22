import { describe, it, expect } from 'vitest'
import { parseIncidentIoComponentImpacts } from '../parsers/incident-io'

// Minimal incident.io page chunk: the parser slices the array between `component_impacts` and
// `component_uptimes`, so the fixture just needs those markers around a JSON array.
const html = `<script>self.__next_f.push([1,"x:{\\"component_impacts\\":[` +
  `{"component_id":"CC","start_at":"2026-06-12T01:00:00.000Z","end_at":"2026-06-12T03:00:00.000Z","status":"degraded_performance"},` +
  `{"component_id":"RESP","start_at":"2026-06-16T01:00:00.000Z","end_at":"2026-06-16T02:00:00.000Z","status":"partial_outage"},` +
  `{"component_id":"CC","start_at":"2026-06-15T18:05:00.000Z","end_at":"2026-06-15T20:00:00.000Z","status":"degraded_performance"},` +
  `{"component_id":"FEDRAMP","start_at":"2026-06-20T01:00:00.000Z","end_at":"2026-06-20T05:00:00.000Z","status":"full_outage"}` +
  `],"component_uptimes":[]}"])</script>`

// #693 follow-up — the parser keys dailyImpact by the impact's actual ISO start timestamp (NOT a bare
// UTC date) so the client can bucket it into the viewer's LOCAL day (fixing the UTC-vs-local off-by-one).
describe('parseIncidentIoComponentImpacts — ISO-keyed, multi-component group aggregation (#693 follow-up)', () => {
  it('keys by the real ISO start timestamp (so the client can bucket to the local day)', () => {
    expect(parseIncidentIoComponentImpacts(html, 'CC')).toEqual({
      '2026-06-12T01:00:00.000Z': 'minor',
      '2026-06-15T18:05:00.000Z': 'minor', // 18:05Z → next local day east of UTC; the client decides
    })
  })

  it('a list aggregates across the group (one ISO key per impact, worst-of left to the client)', () => {
    expect(parseIncidentIoComponentImpacts(html, ['CC', 'RESP'])).toEqual({
      '2026-06-12T01:00:00.000Z': 'minor',
      '2026-06-15T18:05:00.000Z': 'minor',
      '2026-06-16T01:00:00.000Z': 'major', // partial_outage
    })
  })

  it('ids NOT in the group are excluded (FedRAMP must not appear for the API group)', () => {
    const out = parseIncidentIoComponentImpacts(html, ['CC', 'RESP'])
    expect(Object.keys(out).some((k) => k.startsWith('2026-06-20'))).toBe(false)
    // …but including it does surface it (proves the id filter is the only gate).
    expect(parseIncidentIoComponentImpacts(html, ['CC', 'RESP', 'FEDRAMP'])['2026-06-20T01:00:00.000Z']).toBe('critical')
  })

  it('a multi-day span emits the real start + end + noon for full middle days', () => {
    const spanHtml = `<script>self.__next_f.push([1,"x:{\\"component_impacts\\":[` +
      `{"component_id":"CC","start_at":"2026-06-10T22:00:00.000Z","end_at":"2026-06-12T03:00:00.000Z","status":"partial_outage"}` +
      `],"component_uptimes":[]}"])</script>`
    expect(parseIncidentIoComponentImpacts(spanHtml, 'CC')).toEqual({
      '2026-06-10T22:00:00.000Z': 'major', // start day → real start
      '2026-06-11T12:00:00.000Z': 'major', // full middle day → noon
      '2026-06-12T03:00:00.000Z': 'major', // end day → real end
    })
  })
})
