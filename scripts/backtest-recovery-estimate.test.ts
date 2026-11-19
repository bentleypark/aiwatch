import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  backtest, CONFORMAL_MIN_POOL, firstAiEstimates, hadLiveNotice, interval, metricsOf, pairedInterval, predict, priorTo, quantile, report, type Scored,
} from './backtest-recovery-estimate'
import type { TrainingRow } from './build-recovery-training-set'

const T0 = Date.parse('2026-08-01T00:00:00Z')
const iso = (min: number) => new Date(T0 + min * 60_000).toISOString()
let seq = 0
function row(p: { svc?: string; group?: string | null; startMin: number; durationMin: number; stage?: string | null; firstAtMin?: number; id?: string; timesInverted?: boolean }): TrainingRow {
  const startedAt = iso(p.startMin)
  const resolvedAt = iso(p.startMin + p.durationMin)
  const stage = p.stage === undefined ? 'investigating' : p.stage
  return {
    svc: p.svc ?? 'a', provider: null, category: 'api', group: p.group === undefined ? 'llm' : p.group,
    id: p.id ?? `i${++seq}`, title: 'Elevated errors', finalImpact: 'minor', startedAt, resolvedAt, durationMin: p.durationMin,
    derived: false, startUnknown: false, timesInverted: p.timesInverted ?? false,
    first: stage === null ? null : { at: iso(p.firstAtMin ?? p.startMin + 1), stage, body: 'x', source: 'atlassian', delayMin: 1 },
  }
}
const history = (n: number, durationMin: number, svc = 'a', startMin = -100_000) =>
  Array.from({ length: n }, (_, i) => row({ svc, startMin: startMin + i * 1000, durationMin }))

test('hadLiveNotice: an update before resolution at a non-final stage only', () => {
  assert.equal(hadLiveNotice(row({ startMin: 0, durationMin: 60 })), true)
  assert.equal(hadLiveNotice(row({ startMin: 0, durationMin: 60, stage: null })), false)
  assert.equal(hadLiveNotice(row({ startMin: 0, durationMin: 60, stage: 'resolved' })), false)
  assert.equal(hadLiveNotice(row({ startMin: 0, durationMin: 60, stage: 'postmortem' })), false)
  assert.equal(hadLiveNotice(row({ startMin: 0, durationMin: 60, firstAtMin: 60 })), false, 'posted at resolution')
})

test('priorTo keeps a row resolved one minute before the start and drops one resolved one minute after', () => {
  const before = row({ startMin: -61, durationMin: 60 })
  const after = row({ startMin: -59, durationMin: 60 })
  assert.deepEqual(priorTo([before, after], iso(0)), [before])
})

const long = (n: number) => Array.from({ length: n }, (_, i) => row({ startMin: -10 - i, durationMin: 100_000 }))

test('long incidents still open at the target start do not reach its bound', () => {
  const target = row({ startMin: 0, durationMin: 30 })
  const [scored] = backtest([...history(10, 60), ...long(3), target], iso(0))
  assert.equal(scored.id, target.id)
  assert.equal(scored.bounds.pastP80, 60)
})

test('the same long incidents, resolved before the start, do reach it', () => {
  const target = row({ startMin: 200_000, durationMin: 30 })
  const [scored] = backtest([...history(10, 60), ...long(3), target], iso(200_000))
  assert.equal(scored.bounds.pastP80, 100_000)
})

test('a timesInverted row is not scored', () => {
  const bad = row({ startMin: 10, durationMin: 60, timesInverted: true })
  assert.deepEqual(backtest([...history(10, 60), bad], iso(0)), [])
})

test('timesInverted rows are not used as history', () => {
  const inverted = Array.from({ length: 3 }, (_, i) => ({ ...row({ startMin: -50_000 - i, durationMin: 100_000 }), timesInverted: true }))
  const target = row({ startMin: 200_000, durationMin: 30 })
  const [scored] = backtest([...history(10, 60), ...inverted, target], iso(200_000))
  assert.equal(scored.bounds.pastP80, 60)
})

test('group and all-service back-off read only rows resolved before the target started', () => {
  const target = row({ svc: 'a', startMin: 0, durationMin: 30 })
  const groupOpen = Array.from({ length: 10 }, (_, i) => row({ svc: 'b', startMin: -10 - i, durationMin: 100_000 }))
  const groupDone = history(10, 120, 'b')
  const [g] = backtest([...groupDone, ...groupOpen, target], iso(0))
  assert.equal(g.bounds.backoffP80, 120, 'group: open rows left out')
  const ungrouped = (r: TrainingRow) => ({ ...r, group: null })
  const t2 = ungrouped(row({ svc: 'a', startMin: 0, durationMin: 30 }))
  const [a] = backtest([...groupDone.map(ungrouped), ...groupOpen.map(ungrouped), t2], iso(0))
  assert.equal(a.bounds.backoffP80, 120, 'all services: open rows left out')
})

test('back-off takes the provider before the group, for both backoffP80 and stageP80', () => {
  const target = { ...row({ svc: 'a', startMin: 0, durationMin: 30 }), provider: 'P' }
  const sibling = history(10, 90, 'b').map((r) => ({ ...r, provider: 'P' }))
  const groupOnly = history(10, 150, 'c').map((r) => ({ ...r, provider: 'Q' }))
  const [s] = backtest([...sibling, ...groupOnly, target], iso(0))
  assert.equal(s.bounds.backoffP80, 90)
  assert.equal(s.bounds.stageP80, 90)
})

test('provider back-off reads only sibling rows resolved before the target started', () => {
  const target = { ...row({ svc: 'a', startMin: 0, durationMin: 30 }), provider: 'P' }
  const sibling = history(10, 90, 'b').map((r) => ({ ...r, provider: 'P' }))
  const open = Array.from({ length: 10 }, (_, i) => ({ ...row({ svc: 'b', startMin: -10 - i, durationMin: 100_000 }), provider: 'P' }))
  const [s] = backtest([...sibling, ...open, target], iso(0))
  assert.equal(s.bounds.backoffP80, 90)
})

test('group back-off reaches a resolved group row the service lacks', () => {
  const target = row({ svc: 'a', startMin: 0, durationMin: 30 })
  const other = history(10, 240, 'c').map((r) => ({ ...r, group: 'voice' }))
  const [g] = backtest([...history(10, 120, 'b'), ...other, target], iso(0))
  assert.equal(g.bounds.backoffP80, 120)
})

test('predict backs off service → group → all, and pastP80 needs the service floor', () => {
  const target = row({ startMin: 0, durationMin: 30 })
  const svc9 = history(9, 60)
  const group = history(10, 120, 'b')
  const all = history(10, 240, 'c')
  assert.equal(predict(target, svc9, group, [...svc9, ...group, ...all], []).pastP80, undefined)
  assert.equal(predict(target, svc9, group, [...svc9, ...group, ...all], []).backoffP80, 120)
  assert.equal(predict(target, svc9, [], [...svc9, ...all], []).backoffP80, 240)
  assert.equal(predict(target, history(10, 60), group, all, []).backoffP80, 60)
})

test('stageP80 uses rows at the target first-update stage, and is absent without a live notice', () => {
  const target = row({ startMin: 0, durationMin: 30, stage: 'identified' })
  const identified = Array.from({ length: 10 }, (_, i) => row({ startMin: -100_000 + i * 1000, durationMin: 300, stage: 'identified' }))
  const investigating = history(60, 60)
  assert.equal(predict(target, [...identified, ...investigating], [], [], []).stageP80, 300)
  assert.equal(predict(row({ startMin: 0, durationMin: 30, stage: null }), [...identified, ...investigating], [], [], []).stageP80, undefined)
})

test('stageP80 does not count a history row whose first update came only at its resolution', () => {
  const target = row({ startMin: 0, durationMin: 30, stage: 'identified' })
  const late = Array.from({ length: 10 }, (_, i) => row({ startMin: -100_000 + i * 1000, durationMin: 300, stage: 'identified', firstAtMin: -100_000 + i * 1000 + 300 }))
  const noUpdate = Array.from({ length: 10 }, (_, i) => row({ startMin: -50_000 + i * 1000, durationMin: 60, stage: null }))
  assert.equal(predict(target, [...late, ...noUpdate, ...history(40, 60)], [], [], []).stageP80, 60)
})

test('stageP80 without a same-stage cell takes the back-off value: service, then provider', () => {
  const target = { ...row({ startMin: 0, durationMin: 30, stage: 'identified' }), provider: 'P' }
  const sibling = history(10, 90, 'b').map((r) => ({ ...r, provider: 'P' }))
  assert.equal(predict(target, history(10, 60), [], [], [], sibling).stageP80, 60)
  assert.equal(predict(target, history(3, 60), [], [], [], sibling).stageP80, 90)
})

test('a same-stage cell of the service wins over the provider, and the service p80 wins over the provider', () => {
  const target = { ...row({ startMin: 0, durationMin: 30, stage: 'identified' }), provider: 'P' }
  const identified = Array.from({ length: 10 }, (_, i) => row({ startMin: -100_000 + i * 1000, durationMin: 300, stage: 'identified' }))
  const sibling = history(10, 90, 'b').map((r) => ({ ...r, provider: 'P' }))
  const b = predict(target, [...identified, ...history(60, 60)], [], [], [], sibling)
  assert.equal(b.stageP80, 300)
  assert.equal(b.backoffP80, 60)
})

test('stageP80 with no same-stage rows anywhere backs off to the group, then to all services', () => {
  const target = row({ startMin: 0, durationMin: 30, stage: 'identified' })
  const thin = history(3, 60)
  assert.equal(predict(target, thin, history(10, 120, 'b'), history(10, 240, 'c'), []).stageP80, 120)
  assert.equal(predict(target, thin, [], history(10, 240, 'c'), []).stageP80, 240)
})

test('the conformal pool counts only scored incidents that had a past p80', () => {
  const withPast = Array.from({ length: CONFORMAL_MIN_POOL - 1 }, (_, i) => row({ startMin: i * 10, durationMin: 5 }))
  const noPast = Array.from({ length: 10 }, (_, i) => row({ svc: 'z', group: null, startMin: i * 10 + 1, durationMin: 5 }))
  const target = row({ startMin: 10_000, durationMin: 30 })
  const t = backtest([...history(10, 60), ...withPast, ...noPast, target], iso(0)).find((s) => s.id === target.id)!
  assert.equal(t.bounds.conformalP80, undefined)
})

test('the walk-forward scores in start order whatever the input order, so earlier incidents reach the pool', () => {
  const early = Array.from({ length: CONFORMAL_MIN_POOL }, (_, i) => row({ startMin: i * 10, durationMin: 5 }))
  const target = row({ startMin: 10_000, durationMin: 30 })
  const t = backtest([target, ...early.reverse(), ...history(10, 60)], iso(0)).find((s) => s.id === target.id)!
  assert.ok(t.bounds.conformalP80 !== undefined)
})

test('--from compares instants, so an offset timestamp past the cut is scored', () => {
  const r = { ...row({ startMin: 0, durationMin: 30 }), startedAt: '2026-05-05T17:05:49.232-07:00', resolvedAt: '2026-05-05T17:35:49.232-07:00' }
  assert.equal(backtest([...history(10, 60, 'a', -10_000_000), r], '2026-05-06T00:00:00Z').length, 1)
})

test('conformalP80 needs the pool floor and scales pastP80 by exp(q80 of the residuals)', () => {
  const target = row({ startMin: 0, durationMin: 30 })
  const residuals = Array.from({ length: CONFORMAL_MIN_POOL }, (_, i) => Math.log(i < 24 ? 1 : 2))
  assert.equal(predict(target, history(10, 60), [], [], residuals.slice(1)).conformalP80, undefined)
  assert.equal(predict(target, history(10, 60), [], [], residuals).conformalP80, 60)
  residuals[23] = Math.log(2)
  assert.equal(Math.round(predict(target, history(10, 60), [], [], residuals).conformalP80!), 120)
})

test('the conformal pool holds only incidents resolved before the target started', () => {
  const svc = history(10, 60)
  const early = Array.from({ length: CONFORMAL_MIN_POOL }, (_, i) => row({ startMin: i * 10, durationMin: 5 }))
  const target = row({ startMin: CONFORMAL_MIN_POOL * 10 + 1, durationMin: 30 })
  const openAtStart = Array.from({ length: 10 }, (_, i) => row({ startMin: CONFORMAL_MIN_POOL * 10 - i * 0.1, durationMin: 10_000 }))
  const scored = backtest([...svc, ...early, ...openAtStart, target], iso(0))
  const t = scored.find((s) => s.id === target.id)!
  assert.ok(t.bounds.conformalP80! < 60, 'pool is the 30 short early incidents, not the open one')
})

test('metricsOf applies the accuracyOf bands: 0.5× bound accurate, below it over, above the bound uncovered', () => {
  const s = (durationMin: number): Scored => ({ id: `m${durationMin}`, svc: 'a', startedAt: iso(0), durationMin, live: true, bounds: { pastP80: 60 } })
  const m = metricsOf([s(30), s(29), s(60), s(61)], 'pastP80')
  assert.deepEqual(m, { n: 4, coverage: 0.75, accurate: 0.5, over: 0.25, medianRatio: 1 })
})

test('pairedInterval is zero for identical candidates and repeats under the same seed', () => {
  const items: Scored[] = Array.from({ length: 40 }, (_, i) => ({ id: `p${i}`, svc: 'a', startedAt: iso(i), durationMin: i + 1, live: true, bounds: { pastP80: 20, stageP80: 20, conformalP80: 25 } }))
  assert.deepEqual(pairedInterval(items, 'stageP80', 'pastP80', 'coverage', 200), [0, 0])
  assert.deepEqual(pairedInterval(items, 'conformalP80', 'pastP80', 'coverage', 200), pairedInterval(items, 'conformalP80', 'pastP80', 'coverage', 200))
  const [lo, hi] = pairedInterval(items, 'conformalP80', 'pastP80', 'coverage', 200)
  assert.ok(lo > 0 && hi >= lo)
})

test('pairedInterval resamples rows sharing an incident id together', () => {
  const one = (id: string, svc: string, i: number): Scored => ({ id, svc, startedAt: iso(0), durationMin: 15, live: true, bounds: { pastP80: 10, conformalP80: i % 3 === 0 ? 20 : 10 } })
  const singles = Array.from({ length: 30 }, (_, i) => one(`c${i}`, 'a', i))
  const doubled = singles.flatMap((s, i) => [s, one(s.id, 'b', i)])
  assert.deepEqual(pairedInterval(doubled, 'conformalP80', 'pastP80', 'coverage', 300), pairedInterval(singles, 'conformalP80', 'pastP80', 'coverage', 300))
})

test('report prints the candidate minus the base, so a candidate that covers more reads positive', () => {
  const items: Scored[] = Array.from({ length: 40 }, (_, i) => ({ id: `d${i}`, svc: 'a', startedAt: iso(i), durationMin: 15, live: true, bounds: { pastP80: 10, conformalP80: i % 2 ? 40 : 10 } }))
  const line = report('t', items, ['pastP80', 'conformalP80']).split('\n').find((l) => l.startsWith('| conformalP80'))!
  const [lo] = line.split('|')[6].trim().slice(1, -1).split(',').map(Number)
  assert.ok(lo > 0, line)
  assert.equal(line.split('|')[7].trim(), '[0.0, 0.0]', 'Δaccurate: neither bound lands in the accurate band')
})

test('pairedInterval defaults to a 95% interval, wider than a 90% one', () => {
  const items: Scored[] = Array.from({ length: 40 }, (_, i) => ({ id: `w${i}`, svc: 'a', startedAt: iso(i), durationMin: 15, live: true, bounds: { pastP80: 10, conformalP80: i % 2 ? 20 : 10 } }))
  const d95 = pairedInterval(items, 'conformalP80', 'pastP80', 'coverage', 500)
  assert.deepEqual(d95, pairedInterval(items, 'conformalP80', 'pastP80', 'coverage', 500, 2005, 0.95))
  const d90 = pairedInterval(items, 'conformalP80', 'pastP80', 'coverage', 500, 2005, 0.9)
  assert.ok(d95[1] - d95[0] > d90[1] - d90[0])
})

test('report scores every candidate on the incidents where all of them have a bound', () => {
  const items: Scored[] = [
    { id: 'r1', svc: 'a', startedAt: iso(0), durationMin: 10, live: true, bounds: { pastP80: 20, stageP80: 20 } },
    { id: 'r2', svc: 'a', startedAt: iso(1), durationMin: 30, live: true, bounds: { pastP80: 20 } },
  ]
  const out = report('t', items, ['pastP80', 'stageP80'])
  assert.match(out, /^### t: where pastP80, stageP80 all have a bound \(n 1, unique incidents 1\)/)
  assert.match(out, /\| pastP80 \| 100\.0% \|/)
})

test('firstAiEstimates takes the earliest numeric snapshot before resolution and skips null or zero ones', () => {
  const m = firstAiEstimates([[
    { svcId: 'a', incId: '1', resolvedAt: iso(60), predictionSnapshots: [{ at: iso(5), estimateHours: 4 }, { at: iso(1), estimateHours: null }, { at: iso(3), estimateHours: 2 }] },
    { svcId: 'a', incId: '2', resolvedAt: iso(60), predictionSnapshots: [{ at: iso(1), estimateHours: 0 }] },
    { svcId: 'a', incId: '3', resolvedAt: iso(60) },
    { svcId: 'a', incId: '4', resolvedAt: iso(60), predictionSnapshots: [{ at: iso(60), estimateHours: 3 }, { at: iso(61), estimateHours: 1 }] },
  ]])
  assert.deepEqual([...m], [['a|1', 2]])
})

test('interval takes the 2.5% and 97.5% nearest-rank points for a 95% level', () => {
  const xs = Array.from({ length: 100 }, (_, i) => 99 - i)
  assert.deepEqual(interval(xs, 0.95), [2, 97])
  assert.deepEqual(interval(xs, 0.9), [4, 94])
})

test('quantile is nearest-rank', () => {
  assert.equal(quantile([5, 1, 4, 2, 3], 0.8), 4)
  assert.equal(quantile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.8), 8)
})

test('backtest attaches the AI estimate by service and id, in minutes', () => {
  const target = row({ startMin: 0, durationMin: 30, id: 'ai1' })
  const [scored] = backtest([...history(10, 60), target], iso(0), new Map([['a|ai1', 1.5], ['b|ai1', 9]]))
  assert.equal(scored.bounds.ai, 90)
})
