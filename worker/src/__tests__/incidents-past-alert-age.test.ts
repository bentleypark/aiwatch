// #1224 — the cron's per-incident loop read a marker per incident-service pair, on every */5 run, while
// `buildIncidentAlerts` drops everything older than INCIDENT_ALERT_MAX_AGE_MS from BOTH its branches.
// Past that bound the reads and the hold have no reachable consumer, so they are skipped together.
//
// The gate's safety is ONE property: it skips no more than the alert build already skips. Three review
// rounds found gates that READ correctly and DECIDED something else — a status check smuggled into a
// nested ternary, an extra operand on a continuation line — so the decision now lives in one exported
// pure function (`markerReadPlan`) that these tests call directly, and the source-level assertions are
// reduced to the two things only source can express: that the cron uses the plan and nothing else, and
// that the accounting line exists. "Uses the plan" is enforced two ways: the flags are destructured to
// `const`, and each read statement is asserted to reference no `inc.` field but `inc.id`.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  canIncidentStillAlert, markerReadPlan, INCIDENT_ALERT_MAX_AGE_MS, buildIncidentAlerts,
  shouldHoldNewIncident, isFlapSuppressible, FLAP_HOLD_MS,
} from '../alerts'
import type { Incident } from '../types'
import type { ScoredService } from '../alerts'

const INDEX_SRC = readFileSync(join(__dirname, '..', 'index.ts'), 'utf8')
const NOW = Date.parse('2026-08-17T00:00:00Z')
const agoMs = (ms: number) => new Date(NOW - ms).toISOString()
const HOUR = 3600_000

function incAt(startedAt: string, o: Partial<Incident> = {}): Incident {
  return { id: 'inc_1', title: 'Elevated errors', status: 'resolved', impact: 'minor', duration: null, timeline: [], startedAt, ...o } as Incident
}
function svcWith(incidents: Incident[], id = 'openai', category: 'api' | 'app' = 'api'): ScoredService {
  return {
    id, name: 'OpenAI API', provider: 'OpenAI', category, status: 'degraded',
    statusUrl: 'https://status.openai.com', incidents, uptime30d: 99.5, latency: 200,
    lastChecked: new Date(NOW).toISOString(), aiwatchScore: 85, scoreGrade: 'good',
  } as ScoredService
}

// The bound IS the user-visible alerting window: past it neither a New nor a Resolved notice can fire on
// any channel. Every other case here is written relative to the constant, so they all slide with it —
// this is the one that would fail if it were retuned, which is why it states the absolute value.
describe('INCIDENT_ALERT_MAX_AGE_MS (#1224)', () => {
  it('is 24h — retuning it changes which outages get alerted at all', () => {
    expect(INCIDENT_ALERT_MAX_AGE_MS).toBe(86_400_000)
  })

})

describe('markerReadPlan — the one per-incident decision (#1224)', () => {
  const YOUNG = agoMs(HOUR)
  const OLD = agoMs(INCIDENT_ALERT_MAX_AGE_MS + 60_000)
  const cases: Array<{ label: string; startedAt: string; status: Incident['status']; alertable: boolean; readPending: boolean }> = [
    { label: 'old + ongoing', startedAt: OLD, status: 'investigating', alertable: false, readPending: false },
    { label: 'old + resolved', startedAt: OLD, status: 'resolved', alertable: false, readPending: false },
  ]

  it.each(cases)('$label → alertable=$alertable readPending=$readPending', ({ startedAt, status, alertable, readPending }) => {
    expect(markerReadPlan(incAt(startedAt, { status }), NOW)).toEqual({ alertable, readPending })
  })

  it('covers EVERY Incident status — a hand-picked sample missed `identified` entirely', () => {
    // types.ts: 'investigating' | 'identified' | 'monitoring' | 'resolved'. Excluding `identified` from
    // readPending pins firstSeenMs at null for the status a provider occupies during the whole
    // diagnosis window → held every cycle, forever, with a log line that reads as healthy.
    for (const status of ['investigating', 'identified', 'monitoring', 'resolved'] as const) {
      expect(markerReadPlan(incAt(YOUNG, { status }), NOW), status)
        .toEqual({ alertable: true, readPending: status !== 'resolved' })
    }
  })

  it('ignores autoMonitor — the tag changes hold ELIGIBILITY, never whether a marker is read', () => {
    for (const autoMonitor of [true, false]) {
      expect(markerReadPlan(incAt(YOUNG, { status: 'investigating', autoMonitor } as Partial<Incident>), NOW))
        .toEqual({ alertable: true, readPending: true })
    }
  })

  it('treats the bound itself as alertable (<=, the complement of the build\'s >)', () => {
    expect(markerReadPlan(incAt(agoMs(INCIDENT_ALERT_MAX_AGE_MS)), NOW).alertable).toBe(true)
  })

  it('is true for a future-dated startedAt (a provider clock ahead of ours is not "old")', () => {
    expect(markerReadPlan(incAt(new Date(NOW + HOUR).toISOString()), NOW).alertable).toBe(true)
  })

  // Fail OPEN: an incident we cannot date keeps its reads. Failing closed would let one malformed
  // provider timestamp suppress a live marker — dropping a New alert or re-firing one already sent.
  it.each([['unparseable', 'not-a-date'], ['empty', ''], ['missing', undefined], ['null', null], ['a numeric epoch', 1755000000000]])(
    'fails open on a %s startedAt', (_label, startedAt) => {
      const inc = { id: 'x', title: 't', status: 'investigating', impact: null, startedAt } as unknown as Incident
      expect(markerReadPlan(inc, NOW)).toEqual({ alertable: true, readPending: true })
    })
})

// The two load-bearing invariants, stated as PROPERTIES over the shapes the loop can actually see.
// Sampling them along the AGE axis alone (which is what this suite did for three rounds) leaves every
// other axis free: `buildIncidentAlerts`' cutoff can be honestly widened on impact, category,
// autoMonitor or service tier, and the gate then skips the roster read for incidents the build still
// emits for — which re-fires the 🔴 New alert every 5 min forever, because index.ts bypasses the
// key-exists dedup for `alerted:new:` and the post-send merge clobbers the stored roster each cycle.
const AGES = [0, HOUR, 23 * HOUR, INCIDENT_ALERT_MAX_AGE_MS, INCIDENT_ALERT_MAX_AGE_MS + 1, 25 * HOUR, 8 * 24 * HOUR, 60 * 24 * HOUR]
const STATUSES = ['investigating', 'identified', 'monitoring', 'resolved'] as const
const IMPACTS = ['critical', 'major', 'minor', null] as const
const TITLES = ['Elevated errors', 'Storage degraded — recovered', 'API Degraded']
const SVCS: Array<[string, 'api' | 'app', { flapSuppression?: boolean; holdShortIncidents?: boolean }]> = [
  ['openai', 'api', {}],
  ['modal', 'api', { flapSuppression: true }],
  ['langfuse', 'api', { holdShortIncidents: true }],
  ['chatgpt', 'app', {}],
]

type Combo = { age: number; status: typeof STATUSES[number]; impact: typeof IMPACTS[number]; title: string; svcId: string; category: 'api' | 'app'; cfg: { flapSuppression?: boolean; holdShortIncidents?: boolean }; autoMonitor: boolean }

function* combos(): Generator<Combo> {
  for (const age of AGES) for (const status of STATUSES) for (const impact of IMPACTS)
    for (const title of TITLES) for (const [svcId, category, cfg] of SVCS) for (const autoMonitor of [false, true])
      yield { age, status, impact, title, svcId, category, cfg, autoMonitor }
}

function incFor(c: Combo): Incident {
  return incAt(agoMs(c.age), {
    id: 'p_1', status: c.status, impact: c.impact, title: c.title, autoMonitor: c.autoMonitor,
    ...(c.status === 'resolved' ? { resolvedAt: new Date(Math.min(NOW, NOW - c.age + 30 * 60_000)).toISOString() } : {}),
  } as Partial<Incident>)
}

describe('the gate skips no more than buildIncidentAlerts skips (#1224)', () => {
  it('gate-skipped ⇒ build-skipped, for every shape the loop can see', () => {
    let skipped = 0, kept = 0
    for (const c of combos()) {
      const inc = incFor(c)
      const svc = svcWith([inc], c.svcId, c.category)
      if (canIncidentStillAlert(inc, NOW)) { kept++; continue }
      skipped++
      const label = JSON.stringify(c)
      expect(buildIncidentAlerts([svc], new Map(), NOW), label).toEqual([])
      expect(buildIncidentAlerts([svc], new Map([['p_1', new Set([c.svcId])]]), NOW), label).toEqual([])
    }
    // Non-vacuous in both directions: an `if` inside a loop passes for free if the branch never runs.
    expect(skipped).toBeGreaterThan(0)
    expect(kept).toBeGreaterThan(0)
  })

  // The `readPending` skip claims the value is PROVABLY UNUSED, not merely unused in the sampled rows.
  // Asserting the conclusion on 5 rows let a narrowing on the incident TITLE through, which pins
  // firstSeenMs at null for a flap-shaped incident → held every cycle, New and Resolved both dropped.
  it('a skipped pending:new read cannot change the hold decision', () => {
    let checked = 0
    for (const c of combos()) {
      const inc = incFor(c)
      const plan = markerReadPlan(inc, NOW)
      if (!plan.alertable || plan.readPending) continue
      checked++
      const seen = [null, 0, NOW - 60_000, NOW - 10 * 60_000].map(firstSeenMs =>
        shouldHoldNewIncident(c.svcId, c.cfg, inc, { alreadyAlerted: false, firstSeenMs, nowMs: NOW }))
      expect(new Set(seen).size, `hold depends on firstSeenMs: ${JSON.stringify(c)}`).toBe(1)
    }
    expect(checked).toBeGreaterThan(0)
  })
})

// The flap read is bounded INDEPENDENTLY of this gate, and the two bounds are unrelated: three review
// rounds mis-stated the relationship, and a live measurement (2026-08-17) found 29 of 29 flap reads per
// run were for incidents past the age bound. This pins the independence so the claim cannot drift again.
describe('the flap read is bounded by RUN time, not age (#1224)', () => {
  it('an old SHORT resolved flap is flap-suppressible while being past the age bound', () => {
    const old = agoMs(60 * 24 * HOUR)
    const inc = incAt(old, {
      id: 'flap_1', title: 'Storage degraded — recovered', status: 'resolved', impact: 'minor',
      resolvedAt: new Date(Date.parse(old) + 5 * 60_000).toISOString(),
    } as Partial<Incident>)
    expect(isFlapSuppressible('modal', { flapSuppression: true }, inc, NOW)).toBe(true)
    expect(canIncidentStillAlert(inc, NOW)).toBe(false)
  })
})

// The regression the first version of this gate introduced, kept because the failure is SILENT: the hold
// prints "holding new incident until it survives ~2 cycles" every cycle, which reads as healthy.
// `shouldHoldNewIncident` treats firstSeenMs=null as "first sight → hold", so a gate that skips the
// pending:new read while a LIVE marker exists pins the release clock at null → held permanently →
// `heldNewIncIds` → AI analysis never refreshed, and the marker re-stamped every cycle.
describe('the hold-release loop is intact for an ongoing incident (#1224)', () => {
  const HOLD_CFG = { holdShortIncidents: true }
  const ongoing = (startedAt: string) => incAt(startedAt, { id: 'live_1', status: 'investigating', impact: 'minor' })

  it('first sight holds, then releases once the stamp is older than FLAP_HOLD_MS', () => {
    const i = ongoing(agoMs(10 * 60_000))
    expect(shouldHoldNewIncident('mistral', HOLD_CFG, i, { alreadyAlerted: false, firstSeenMs: null, nowMs: NOW })).toBe(true)
    expect(shouldHoldNewIncident('mistral', HOLD_CFG, i, { alreadyAlerted: false, firstSeenMs: NOW - FLAP_HOLD_MS - 1, nowMs: NOW })).toBe(false)
  })

  // Why the whole hold block is gated and not just the read: an 8-day-old ONGOING hold-eligible incident
  // IS representable (`isShortIncidentHoldable` has no age or run bound), and entering the block with a
  // skipped read would hold it forever. The plan excluding it is what makes that unreachable.
  it('an ongoing incident past the bound is excluded from the block entirely', () => {
    const i = ongoing(agoMs(8 * 24 * HOUR))
    expect(markerReadPlan(i, NOW)).toEqual({ alertable: false, readPending: false })
    for (const cycle of [0, 1, 2, 100]) {
      expect(shouldHoldNewIncident('mistral', HOLD_CFG, i, { alreadyAlerted: false, firstSeenMs: null, nowMs: NOW + cycle * 300_000 })).toBe(true)
    }
  })

  // Why skipping the pending:new read for a RESOLVED incident is provably free rather than a bet on the
  // key's TTL: the resolved check runs BEFORE firstSeenMs is consulted, so the value cannot matter.
  it.each([['no marker', null], ['a live marker', NOW - 60_000]])(
    'a resolved incident is never held, with %s', (_label, firstSeenMs) => {
      const i = incAt(agoMs(10 * 60_000), { id: 'res_2', status: 'resolved' })
      expect(shouldHoldNewIncident('mistral', HOLD_CFG, i, { alreadyAlerted: false, firstSeenMs, nowMs: NOW })).toBe(false)
    })
})

// `cronAlertCheck` is not exported, so these pin what only source can express. Deliberately NARROW now:
// the decision itself is unit-tested above, so all these have to show is that the cron asks the plan and
// re-derives nothing from `inc` itself.
describe('wiring — the cron defers to the plan (#1224)', () => {
  /** The cron body, bounded by brace matching (bounding on the next `async function` overshoots the end
   *  of cronAlertCheck, so a gate planted in a dead helper below it would match). */
  const cronBody = (() => {
    const start = INDEX_SRC.indexOf('async function cronAlertCheck(')
    expect(start, 'cronAlertCheck not found').toBeGreaterThan(-1)
    let depth = 0
    for (let j = INDEX_SRC.indexOf('{', start); j < INDEX_SRC.length; j++) {
      if (INDEX_SRC[j] === '{') depth++
      else if (INDEX_SRC[j] === '}' && --depth === 0) return INDEX_SRC.slice(start, j + 1)
    }
    throw new Error('unbalanced braces in cronAlertCheck')
  })()

  /** The whole statement beginning with `startsWith`, continuation lines included so a moved-down
   *  `&& false` is visible, and COMMENTS STRIPPED so prose can neither satisfy nor break an assertion. */
  const statementAt = (startsWith: string): string => {
    const lines = cronBody.split('\n')
    const i = lines.findIndex(l => l.trim().startsWith(startsWith))
    expect(i, `no statement starting with ${startsWith}`).toBeGreaterThan(-1)
    const indent = lines[i].search(/\S/)
    const out: string[] = []
    for (let j = i; j < lines.length; j++) {
      const t = lines[j].trim()
      if (j > i && !t) break
      if (j > i && lines[j].search(/\S/) <= indent && /^[A-Za-z}/]/.test(t)) break
      const code = t.replace(/\/\/.*$/, '').trim()
      if (code) out.push(code)
    }
    return out.join(' ')
  }

  const occurrences = (needle: string) => cronBody.split(needle).length - 1
  /** Whole module, comments stripped and whitespace collapsed — so a `prettier` reflow (the repo ships
   *  .prettierrc + prettier, with no CI wiring, so format-on-save reaches these files) cannot fail an
   *  assertion that is really about token order. */
  const FLAT = INDEX_SRC.split('\n').map(l => l.replace(/\/\/.*$/, '')).join(' ').replace(/\s+/g, ' ')

  it('asks the plan once per incident, on the shared run clock', () => {
    // DESTRUCTURED, so both flags are `const`: a smuggled `plan.alertable = false` further down the
    // loop (which passed every assertion when this was one mutable object) is now a type error.
    expect(statementAt('const { alertable, readPending }')).toBe('const { alertable, readPending } = markerReadPlan(inc, runNowMs)')
    expect(occurrences('markerReadPlan(')).toBe(1)
    // And exactly one roster read exists at all — a second, ungated one restores the full per-pair cost
    // while the accounting line keeps printing a healthy `skipped=`.
    expect(occurrences('`alerted:new:${inc.id}`')).toBe(1)
  })

  it('uses ONE clock for the plan and for buildIncidentAlerts', () => {
    // Shared, so "the gate skips no more than the build" holds by construction rather than by program
    // order. Passing `scheduledTimeMs` to either side, or giving the build its own Date.now(), breaks it.
    expect(statementAt('const runNowMs =')).toBe('const runNowMs = Date.now()')
    // Declared exactly ONCE: a shadowing `const runNowMs` inside the loop leaves every assertion here
    // reading verbatim-correct while the gate runs on a different clock from the build — no roster
    // read, no pending read, no hold, for anything, while the build keeps emitting.
    expect(occurrences('const runNowMs')).toBe(1)
    expect(statementAt('const incidentAlerts =')).toBe('const incidentAlerts = buildIncidentAlerts(scored, alertedNewMap, runNowMs, suppressedIncIds)')
  })

  it('reads alerted:new behind the plan, and derives no predicate of its own from inc', () => {
    const stmt = statementAt('const wasAlerted =')
    expect(stmt).toMatch(/^const wasAlerted = alertable \? await env\.STATUS_CACHE\.get\(`alerted:new:\$\{inc\.id\}`\)\.catch\(/)
    // No property of `inc` may be consulted here: a status check smuggled in (even as a nested ternary,
    // which carries no `&&`) would drop every Resolved notice, since the roster gates that branch.
    expect(stmt.replace(/inc\.id/g, '')).not.toMatch(/\binc\./)
    expect(stmt.endsWith(': null')).toBe(true)
  })

  it('logs a roster read ERROR, under a cap that still lets the first ones through', () => {
    // A swallowed error means alertedNewMap misses an incident that WAS alerted → the #545 dedup bypass
    // re-emits its New alert every 5 min. A cap of 0 would satisfy a "the warn is present" assertion
    // while never executing, so the threshold is pinned too.
    const stmt = statementAt('const wasAlerted =')
    expect(stmt).toMatch(/if \(\+\+rosterReadErrors <= [1-9]\d*\) console\.warn\(\s*'\[cron\] #545 alerted:new read failed/)
    // And the value the catch RETURNS. `'1'` is the legacy roster form: parseAlertedRoster seeds it with
    // the current service, so a read error would mark the incident already-alerted — suppressing the 🔴
    // New alert outright and making a never-announced incident eligible for the Resolved branch.
    expect(stmt).toMatch(/#545 alerted:new read failed[^]*return null/)
    // The tail must be the catch's own close, so nothing can be chained onto it: a `.then()` that
    // consults `svc` (not `inc`, so the ban above misses it) would drop every Resolved notice for a
    // service that has already gone back to operational.
    expect(stmt).toMatch(/return null \}\) : null$/)
  })

  it('gates the whole hold block on the plan, not just the read inside it', () => {
    // Found by walking back from the hold decision to its ENCLOSING guard.
// ADJACENCY, not a walk-back: any search backwards from the hold decision can be fooled by a decoy
    // guard (an unbalanced one, or a balanced one hidden in a template literal). Requiring the two lines
    // to touch admits no decoy at all.
    expect(FLAT).toContain('if (config && alertable) { const alreadyAlerted = alertedNewMap')
    // Exactly one hold decision and one held-set write: a second, ungated copy appended below the block
    // would reinstate the permanent hold and this walk-back would never inspect it.
    expect(occurrences('shouldHoldNewIncident(')).toBe(1)
    expect(occurrences('heldNewIncIds.add(')).toBe(1)
  })

  it('reads pending:new behind the plan, and derives no predicate of its own from inc', () => {
    const stmt = statementAt('const pendingRaw =')
    expect(stmt).toMatch(/^const pendingRaw = readPending \? await env\.STATUS_CACHE\.get\(pendingNewKey\(inc\.id\)\)/)
    expect(stmt.replace(/inc\.id/g, '')).not.toMatch(/\binc\./)
    // '0' parses to firstSeenMs=0 ("first seen at the epoch"), claiming a marker existed and suppressing
    // the first-sight hold. `null` is what "no marker" means. The '0' inside the catch is the read-ERROR
    // sentinel and must stay, so this asserts the ternary's ELSE arm.
    expect(stmt.endsWith(': null')).toBe(true)
    expect(stmt).toMatch(/pendingReadErrors\+\+/)
    // The catch keeps the '0' READ-ERROR sentinel, which is a different value from the skip's `null`:
    // '0' parses to firstSeenMs=0 (age huge → do NOT hold → fire), preserving "a dropped real alert is
    // worse than one phantom on a KV blip". Returning `null` here instead would HOLD a real New alert
    // and re-stamp the marker on every erroring cycle — fail-open inverted to fail-closed.
    expect(stmt).toMatch(/#835 pending:new read failed[^]*return '0'/)
    expect(stmt).toMatch(/return '0' \}\) : null$/)
  })

  it('gates the flap read on the plan too', () => {
    // Measured 29 reads/run, 29 of them past the bound — the loop's largest remaining read. Safe by the
    // same argument: its suppression only subtracts from the same capped build, and its key is written
    // only for a resolved alert that actually sent.
    // Its own LINE, not statementAt (which would swallow the block body): the guard is the assertion.
    const guards = cronBody.split('\n').map(l => l.trim()).filter(l => l.includes('isFlapSuppressible('))
    expect(guards).toHaveLength(1)
    expect(guards[0]).toMatch(/^if \(config && alertable && isFlapSuppressible\(/)
    // Counted too: this counter is the only production artifact for the measurement the flap gating
    // rests on, and deleting it leaves the line printing `alerted:flap read=0` forever.
    expect(cronBody).toMatch(/isFlapSuppressible\([^)]*\)\) \{\s*\n\s*flapReads\+\+/)
  })

  it('leaves the #1106 withdrawal roster read UNGATED', () => {
    // A tombstoned incident is old BY DEFINITION and absent from the live list, so age-gating that read
    // would silence withdrawal notices entirely. The most natural place for a future reader of the
    // #1224 comments to "finish the job".
    const from = cronBody.indexOf('withdrawnTombstones.map(')
    expect(from, 'the #1106 tombstone loop was not found').toBeGreaterThan(-1)
    expect(FLAT).toContain('try { marker = await env.STATUS_CACHE.get(`alerted:new:${w.incId}`)')
  })

  it('keeps the two sets single-consumer — the safety argument depends on it', () => {
    // Gating the flap branch is safe because `suppressedIncIds` only ever subtracts from the same
    // capped build; the accepted AI-deferral delta is bounded because `heldNewIncIds` is read only by
    // refreshOrReanalyze. Neither is pinned anywhere else, so a future second consumer would break
    // both arguments with no failing test.
    // Split by LINE and by `;` — this codebase omits semicolons, so lines are the statement unit, but
    // an alias tucked onto the declaration line (`const s = new Set(); const alias = s`) or a second
    // consumer sharing an `.add(` line would otherwise hide inside an excluded line.
    const readsOf = (ident: string) => INDEX_SRC.split('\n')
      .map(l => l.replace(/\/\/.*$/, ''))
      .flatMap(l => l.split(';'))
      .map(x => x.trim())
      .filter(x => new RegExp(`\\b${ident}\\b`).test(x))
      .filter(x => !x.includes(`${ident}.add(`) && !x.includes(`${ident}.set(`)
        && x !== `const ${ident} = new Set<string>()` && x !== `const ${ident} = new Map<string, string>()`)
    // Count is line-shape independent (so a prettier reflow cannot fail it); the consumer's IDENTITY is
    // then checked against the collapsed source, tolerating any wrapping of the call.
    expect(readsOf('suppressedIncIds'), 'suppressedIncIds must stay single-consumer').toHaveLength(1)
    expect(FLAT).toMatch(/buildIncidentAlerts\(.{0,120}?suppressedIncIds/)
    expect(readsOf('flapKeysToWrite'), 'flapKeysToWrite must stay single-consumer').toHaveLength(1)
    expect(FLAT).toMatch(/flapKeysToWrite\.get\(incId\)/)
    expect(readsOf('heldNewIncIds').filter(l => !l.includes('heldNewIds=')),
      'heldNewIncIds must stay single-consumer').toHaveLength(1)
    expect(FLAT).toMatch(/refreshOrReanalyze\(.{0,200}?heldNewIncIds/)
    // The map the gate directly makes incomplete. Two consumers today (the capped build, and the
    // post-send roster merge, which only ever sees keys from alerts that build emitted); a third that
    // iterated it would silently read a partial map.
    // Excluding its declaration and the two sites that POPULATE it inside the gated loop, the map has
    // exactly two consumers: the capped build, and the post-send roster merge (which only ever sees
    // keys from alerts that build emitted). A third that iterated it would read a partial map.
    expect(readsOf('alertedNewMap').filter(l => !l.includes('new Map<') && !l.includes('.get(inc.id)')),
      'alertedNewMap consumers').toEqual([
      'const incidentAlerts = buildIncidentAlerts(scored, alertedNewMap, runNowMs, suppressedIncIds)',
      'const roster = alertedNewMap.get(incId) ?? new Set<string>()',
    ])
  })

  it('emits exactly ONE accounting line, after the loop, naming every counter', () => {
    // Otherwise unfalsifiable in production: a skipped read and an absent key are the same `null`. The
    // FIELDS are the deliverable, so replacing them with a constant must fail.
    expect(FLAT.split("console.log( '[cron] #1224 per-incident marker reads —'").length - 1
      + FLAT.split("console.log('[cron] #1224 per-incident marker reads —'").length - 1).toBe(1)
    expect(cronBody).toMatch(/^  console\.log\(\s*\n?\s*'\[cron\] #1224 per-incident marker reads —'/m)
    expect(cronBody.indexOf('#1224 per-incident marker reads')).toBeGreaterThan(cronBody.indexOf('for (const inc of svc.incidents'))
    const at = FLAT.indexOf("'[cron] #1224 per-incident marker reads —'")
    expect(at, 'the accounting line was not found').toBeGreaterThan(-1)
    const line = FLAT.slice(at, FLAT.indexOf(')', FLAT.indexOf('heldNewIds=', at)))
    // Each LABEL against its own counter: asserting only that every name appears somewhere in the line
    // let `alerted:new read=` and `skipped=` be swapped, which is the inverted-accounting failure that
    // reads as "the gate is barely firing" and invites widening the bound this change narrowed.
    // Only the pairing whose inversion MISLEADS: read⟷skipped inverted reads as "the gate is barely
    // firing", which invites widening the very bound this change narrowed. A renamed log field is not a
    // bug, so the other six are not pinned.
    const fields: Array<[string, string]> = [
      ['alerted:new read', 'rosterReads'],
      ['skipped', 'rosterSkips'],
    ]
    for (const [label, expr] of fields) {
      expect(line, `${label} must report ${expr}`).toContain(label + '=${' + expr + '}')
    }
  })

  it('counts a performed read as performed and a skipped one as skipped', () => {
    // An inverted pair does not look broken — it reads as "the gate is barely firing", which invites
    // widening the very bound this change narrowed.
    const i = cronBody.indexOf('const { alertable, readPending } = markerReadPlan')
    expect(cronBody.slice(i, cronBody.indexOf('const wasAlerted', i)))
      .toMatch(/if \(alertable\) rosterReads\+\+\s*\n\s*else rosterSkips\+\+/)
    expect(statementAt('if (readPending) pendingReads++')).toBe('if (readPending) pendingReads++')
  })
})
