import { describe, it, expect, vi } from 'vitest'
import {
  goneAlertedIds, servicesMissing, sourcesReadable, advanceHold, parseHold, classifyGone, listIds, runGoneCheck as runGoneCheckWith, formatGoneAlert,
  GONE_HANDLED_PREFIX, GONE_SEEN_PREFIX, GONE_DAILY_PREFIX, GONE_BATCH_MAX, GONE_HOLD_MS, GONE_GAP_MS,
} from '../alerted-gone'
import { PHANTOM_PRUNE_AFTER_MISSED_RUNS } from '../monthly-archive'
import type { ServiceStatus } from '../types'
import type { SuppressionEntry } from '../suppression'

const NOW = Date.parse('2026-10-13T12:00:00Z')
const DATE = '2026-10-13'
const TICK = 300_000
const LATER = NOW + GONE_HOLD_MS + 1
type Embed = { title: string; description: string; color: number }
const runGoneCheck = (kv: KVNamespace, send: (e: Embed) => Promise<boolean>, scored: ServiceStatus[], withdrawn: Set<string>, nowMs: number, blind: Set<string> = new Set()) =>
  runGoneCheckWith(kv, send, scored, withdrawn, nowMs, blind)

function fakeKV(seed: Record<string, string> = {}, opts: { incomplete?: string; listThrows?: boolean; getThrows?: (k: string) => boolean } = {}) {
  const store: Record<string, string> = { ...seed }
  return {
    store,
    get: vi.fn(async (k: string) => {
      if (opts.getThrows?.(k)) throw new Error('kv get down')
      return store[k] ?? null
    }),
    put: vi.fn(async (k: string, v: string) => { store[k] = v }),
    delete: vi.fn(async (k: string) => { delete store[k] }),
    list: vi.fn(async ({ prefix }: { prefix: string }) => {
      if (opts.listThrows) throw new Error('kv list down')
      return {
        keys: Object.keys(store).filter((k) => k.startsWith(prefix)).map((name) => ({ name })),
        list_complete: opts.incomplete !== prefix,
      }
    }),
  } as unknown as KVNamespace & { store: Record<string, string> }
}

const svc = (id: string, over: Partial<ServiceStatus> = {}, incidentIds: string[] = []) =>
  ({ id, name: `Name-${id}`, status: 'operational', incidents: incidentIds.map((i) => ({ id: i, status: 'investigating' })), ...over }) as unknown as ServiceStatus

const announce = (kv: ReturnType<typeof fakeKV>, incId: string, svcIds: string[]) => { kv.store[`alerted:new:${incId}`] = JSON.stringify(svcIds) }
const close = (kv: ReturnType<typeof fakeKV>, incId: string) => { kv.store[`alerted:res:${incId}`] = '1' }
/** A hold that is confirmed at LATER and was last refreshed one tick before it. */
const heldFor = (incId: string) => ({ [`${GONE_SEEN_PREFIX}${incId}`]: JSON.stringify({ first: NOW, last: LATER - TICK }) })
const sendOk = () => vi.fn(async (_embed: Embed) => true)
const monthly = (rows: Record<string, Array<{ id: string; title: string; finalStatus: string }>>) =>
  JSON.stringify({ services: Object.fromEntries(Object.entries(rows).map(([s, incidents]) => [s, { incidents }])) })

describe('#1118 goneAlertedIds — announced, never closed, not withdrawn', () => {
  it('each exclusion is load-bearing: dropping any one of them changes the answer', () => {
    expect(goneAlertedIds(['x'], new Set(), new Set())).toEqual(['x'])
    expect(goneAlertedIds(['x'], new Set(['x']), new Set())).toEqual([])
    expect(goneAlertedIds(['x'], new Set(), new Set(['x']))).toEqual([])
  })
})

describe('#1118 servicesMissing — judged per card, not across all of them', () => {
  const by = (...s: ServiceStatus[]) => new Map(s.map((x) => [x.id, x]))
  it('names the announced services whose own list lacks the incident, even when a sibling carries it', () => {
    expect(servicesMissing('i', ['openai', 'chatgpt'], by(svc('openai'), svc('chatgpt', {}, ['i'])))).toEqual(['openai'])
  })
  it('a retained-bridge entry listed on the card counts as carried: it is shown, so it is not a drop', () => {
    const bridged = { ...svc('windsurf'), incidents: [{ id: 'i', status: 'investigating', retainedBridge: true }] } as unknown as ServiceStatus
    expect(servicesMissing('i', ['windsurf'], by(bridged))).toEqual([])
  })
  it('is empty when every announced card carries it', () => {
    expect(servicesMissing('i', ['a', 'b'], by(svc('a', {}, ['i']), svc('b', {}, ['i'])))).toEqual([])
  })
  it('a service absent from this cycle counts as missing', () => {
    expect(servicesMissing('i', ['gone'], by(svc('a', {}, ['i'])))).toEqual(['gone'])
  })
})

describe('#1118 sourcesReadable', () => {
  const by = (...s: ServiceStatus[]) => new Map(s.map((x) => [x.id, x]))
  it('requires every service to have been read this cycle', () => {
    expect(sourcesReadable(['ok'], by(svc('ok')))).toBe(true)
    expect(sourcesReadable(['ok', 'missing'], by(svc('ok')))).toBe(false)
    expect(sourcesReadable([], by(svc('ok')))).toBe(false)
  })
  it.each([
    ['unknown status', { status: 'unknown' }],
    ['sourceDead', { sourceDead: true }],
    ['sourceUnknown', { sourceUnknown: true }],
    ['active-only overlay', { liveIncidentsActiveOnly: true }],
    ['expired feed (DeepSeek App serves an empty list)', { incidentSourceStale: true }],
  ] as const)('an unreadable source (%s) is not evidence of an absence', (_n, over) => {
    expect(sourcesReadable(['x'], by(svc('x', over as Partial<ServiceStatus>)))).toBe(false)
  })
})

describe('#1118 advanceHold — continuous absence only', () => {
  it('starts on first sight and confirms after GONE_HOLD_MS of ticks', () => {
    let hold = null as ReturnType<typeof parseHold>
    let confirmed = false
    for (let t = 0; t <= GONE_HOLD_MS; t += TICK) ({ next: hold, confirmed } = advanceHold(hold, NOW + t))
    expect(confirmed).toBe(true)
    expect(advanceHold(hold, NOW + GONE_HOLD_MS - TICK).confirmed).toBe(false)
  })
  it('a gap longer than GONE_GAP_MS restarts the hold', () => {
    const { next, confirmed } = advanceHold({ first: NOW, last: NOW + GONE_GAP_MS }, NOW + 2 * GONE_GAP_MS + 1)
    expect(confirmed).toBe(false)
    expect(next.first).toBe(NOW + 2 * GONE_GAP_MS + 1)
  })
  it('a missing hold starts one', () => {
    expect(advanceHold(null, NOW).next).toEqual({ first: NOW, last: NOW })
  })
  it('outlasts the phantom prune that tombstones a withdrawn incident', () => {
    expect(GONE_HOLD_MS).toBeGreaterThan(PHANTOM_PRUNE_AFTER_MISSED_RUNS * TICK)
  })
  it('parseHold rejects anything that is not a {first,last} pair', () => {
    expect(parseHold(null)).toBeNull()
    expect(parseHold('not json')).toBeNull()
    expect(parseHold('{"first":1}')).toBeNull()
    expect(parseHold('{"first":1,"last":2}')).toEqual({ first: 1, last: 2 })
  })
})

describe('#1118 classifyGone', () => {
  const row = (finalStatus: string, frozen = false) => ({ title: 'Elevated errors on Kimi', finalStatus: finalStatus as 'resolved', frozen })
  it('an accumulator row that saw it resolve is not a drop', () => {
    expect(classifyGone('i1', ['fireworks'], row('resolved'), [])).toBe('resolved')
    expect(classifyGone('i1', ['fireworks'], row('resolved', true), [])).toBe('resolved')
  })
  it('a still-open current-month row, or no row at all, is reported', () => {
    expect(classifyGone('i1', ['fireworks'], row('investigating'), [])).toBe('reported')
    expect(classifyGone('i1', ['fireworks'], null, [])).toBe('reported')
  })
  it('an unresolved row from a closed month cannot tell open from resolved', () => {
    expect(classifyGone('i1', ['fireworks'], row('investigating', true), [])).toBe('unverified')
  })
  it('an operator suppression by id hides it even with no row', () => {
    const list: SuppressionEntry[] = [{ scope: 'incident', incId: 'i1' }]
    expect(classifyGone('i1', ['fireworks'], null, list)).toBe('suppressed')
    expect(classifyGone('i2', ['fireworks'], null, list)).toBe('reported')
  })
  it('a service-pattern suppression needs the title, and applies only to its own service', () => {
    const list: SuppressionEntry[] = [{ scope: 'service-pattern', svcId: 'fireworks', match: 'kimi' }]
    expect(classifyGone('i1', ['fireworks'], row('investigating'), list)).toBe('suppressed')
    expect(classifyGone('i1', ['openai'], row('investigating'), list)).toBe('reported')
    expect(classifyGone('i1', ['fireworks'], null, list)).toBe('reported')
  })
})

describe('#1118 listIds', () => {
  it('returns the ids under the prefix', async () => {
    const kv = fakeKV({ 'alerted:new:a': '[]', 'alerted:new:b': '[]', 'alerted:res:a': '1' })
    expect(await listIds(kv, 'alerted:new:')).toEqual(new Set(['a', 'b']))
  })
  it('an incomplete or failed listing is null, not a partial set', async () => {
    expect(await listIds(fakeKV({ 'alerted:new:a': '[]' }, { incomplete: 'alerted:new:' }), 'alerted:new:')).toBeNull()
    expect(await listIds(fakeKV({}, { listThrows: true }), 'alerted:new:')).toBeNull()
  })
})

describe('#1118 runGoneCheck', () => {
  it('the #1104 shape: announced, open at the provider, dropped by a filter → held across ticks, then reported once', async () => {
    const kv = fakeKV()
    announce(kv, 'inc-1', ['openai'])
    const send = sendOk()
    const scored = [svc('openai')]
    for (let t = 0; t < GONE_HOLD_MS; t += TICK) {
      await runGoneCheck(kv, send, scored, new Set(), NOW + t)
      expect(send).not.toHaveBeenCalled()
    }
    const last = await runGoneCheck(kv, send, scored, new Set(), NOW + GONE_HOLD_MS)
    expect(last?.outcomes.reported).toBe(1)
    expect(send).toHaveBeenCalledTimes(1)
    expect(send.mock.calls[0][0].description).toContain('inc-1')
    expect(kv.store[`${GONE_HANDLED_PREFIX}inc-1`]).toBe('reported')

    await runGoneCheck(kv, send, scored, new Set(), NOW + GONE_HOLD_MS + TICK)
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('an incident that comes back restarts the hold: a later single absence is not reported', async () => {
    const kv = fakeKV()
    announce(kv, 'inc-1', ['openai'])
    const send = sendOk()
    await runGoneCheck(kv, send, [svc('openai')], new Set(), NOW)
    await runGoneCheck(kv, send, [svc('openai', {}, ['inc-1'])], new Set(), NOW + TICK)
    const run = await runGoneCheck(kv, send, [svc('openai')], new Set(), NOW + GONE_HOLD_MS + TICK)
    expect(run).toMatchObject({ pending: 1 })
    expect(send).not.toHaveBeenCalled()
  })

  it('judged per card: carried by a sibling service but missing from the one it was announced on → reported, naming that one', async () => {
    const kv = fakeKV(heldFor('inc-1'))
    announce(kv, 'inc-1', ['openai', 'chatgpt'])
    const send = sendOk()
    await runGoneCheck(kv, send, [svc('openai'), svc('chatgpt', {}, ['inc-1'])], new Set(), LATER)
    expect(send).toHaveBeenCalledTimes(1)
    expect(send.mock.calls[0][0].description).toContain('missing from Name-openai')
    expect(send.mock.calls[0][0].description).not.toContain('Name-chatgpt')
  })

  it('production baseline 2026-10-13: 48 announced, every one closed, carried or withdrawn → nothing is reported', async () => {
    const kv = fakeKV()
    for (let i = 0; i < 44; i++) { announce(kv, `done-${i}`, ['fireworks']); close(kv, `done-${i}`) }
    announce(kv, 'langsmith-open', ['langsmith'])
    announce(kv, 'fireworks-open', ['fireworks'])
    announce(kv, 'chatgpt-republished', ['chatgpt'])
    announce(kv, 'fireworks-withdrawn', ['fireworks'])
    const scored = [svc('langsmith', {}, ['langsmith-open']), svc('fireworks', {}, ['fireworks-open']), svc('chatgpt', {}, ['chatgpt-republished'])]
    const send = sendOk()
    const run = await runGoneCheck(kv, send, scored, new Set(['fireworks-withdrawn']), LATER)
    expect(run).toMatchObject({ candidates: 0 })
    expect(send).not.toHaveBeenCalled()
  })

  it('a closed incident is not reported', async () => {
    const kv = fakeKV(heldFor('inc-1'))
    announce(kv, 'inc-1', ['openai']); close(kv, 'inc-1')
    const send = sendOk()
    await runGoneCheck(kv, send, [svc('openai')], new Set(), LATER)
    expect(send).not.toHaveBeenCalled()
  })

  it('an incident carried by every card it was announced on is not reported', async () => {
    const kv = fakeKV(heldFor('inc-1'))
    announce(kv, 'inc-1', ['openai', 'chatgpt'])
    const send = sendOk()
    await runGoneCheck(kv, send, [svc('openai', {}, ['inc-1']), svc('chatgpt', {}, ['inc-1'])], new Set(), LATER)
    expect(send).not.toHaveBeenCalled()
  })

  it('a withdrawn tombstone that no card carries is left to the withdrawal path', async () => {
    const kv = fakeKV(heldFor('inc-1'))
    announce(kv, 'inc-1', ['openai'])
    const send = sendOk()
    const run = await runGoneCheck(kv, send, [svc('openai')], new Set(['inc-1']), LATER)
    expect(run).toMatchObject({ candidates: 0 })
    expect(send).not.toHaveBeenCalled()
  })

  it('a tombstone whose incident a sibling card still carries does not hide the miss: that notice is held', async () => {
    const kv = fakeKV(heldFor('inc-1'))
    announce(kv, 'inc-1', ['openai', 'chatgpt'])
    const send = sendOk()
    await runGoneCheck(kv, send, [svc('openai'), svc('chatgpt', {}, ['inc-1'])], new Set(['inc-1']), LATER)
    expect(send).toHaveBeenCalledTimes(1)
    expect(send.mock.calls[0][0].description).toContain('missing from Name-openai')
  })

  it('a withdrawal marker settles it as withdrawn, silently', async () => {
    const kv = fakeKV({ 'alerted:wd:inc-1': '1' })
    announce(kv, 'inc-1', ['openai'])
    const send = sendOk()
    const run = await runGoneCheck(kv, send, [svc('openai')], new Set(), LATER)
    expect(run?.outcomes.withdrawn).toBe(1)
    expect(send).not.toHaveBeenCalled()
  })

  it.each([
    ['sourceDead', { sourceDead: true }],
    ['unknown status', { status: 'unknown' }],
    ['active-only overlay', { liveIncidentsActiveOnly: true }],
    ['expired feed', { incidentSourceStale: true }],
  ] as const)('holds without touching the hold or sending while the source is unreadable (%s)', async (_n, over) => {
    const kv = fakeKV(heldFor('inc-1'))
    announce(kv, 'inc-1', ['deepseekapp'])
    const send = sendOk()
    const before = kv.store[`${GONE_SEEN_PREFIX}inc-1`]
    const run = await runGoneCheck(kv, send, [svc('deepseekapp', over as Partial<ServiceStatus>)], new Set(), LATER)
    expect(run).toMatchObject({ candidates: 1, skipped: 1 })
    expect(send).not.toHaveBeenCalled()
    expect(kv.store[`${GONE_SEEN_PREFIX}inc-1`]).toBe(before)
  })

  it('a service whose feed gives no resolved signal is skipped, not reported (Azure OpenAI retitles and never resolves)', async () => {
    const kv = fakeKV(heldFor('inc-1'))
    announce(kv, 'inc-1', ['azureopenai'])
    const send = sendOk()
    const run = await runGoneCheck(kv, send, [svc('azureopenai')], new Set(), LATER, new Set(['azureopenai']))
    expect(run).toMatchObject({ candidates: 1, skipped: 1 })
    expect(send).not.toHaveBeenCalled()
    expect(kv.store[`${GONE_HANDLED_PREFIX}inc-1`]).toBeUndefined()
  })

  it('an unreadable handled marker is skipped, never re-reported', async () => {
    const kv = fakeKV(heldFor('inc-1'), { getThrows: (k) => k === `${GONE_HANDLED_PREFIX}inc-1` })
    announce(kv, 'inc-1', ['openai'])
    const send = sendOk()
    await runGoneCheck(kv, send, [svc('openai')], new Set(), LATER)
    expect(send).not.toHaveBeenCalled()
  })

  it('an unreadable withdrawal marker does not abort the other candidates', async () => {
    const kv = fakeKV({ ...heldFor('inc-1'), ...heldFor('inc-2') }, { getThrows: (k) => k === 'alerted:wd:inc-1' })
    announce(kv, 'inc-1', ['openai']); announce(kv, 'inc-2', ['openai'])
    const send = sendOk()
    const run = await runGoneCheck(kv, send, [svc('openai')], new Set(), LATER)
    expect(run).not.toBeNull()
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('writes no daily counter on a cycle that settles nothing', async () => {
    const kv = fakeKV()
    announce(kv, 'inc-1', ['openai'])
    await runGoneCheck(kv, sendOk(), [svc('openai')], new Set(), NOW)
    expect(kv.store[`${GONE_DAILY_PREFIX}${DATE}`]).toBeUndefined()
  })

  it('does not count a report that was not delivered, even when another incident is settled the same cycle', async () => {
    const kv = fakeKV({ ...heldFor('inc-1'), ...heldFor('inc-2'), 'incident:suppressions': JSON.stringify([{ scope: 'incident', incId: 'inc-2' }]) })
    announce(kv, 'inc-1', ['openai']); announce(kv, 'inc-2', ['openai'])
    await runGoneCheck(kv, vi.fn(async (_e: Embed) => false), [svc('openai')], new Set(), LATER)
    expect(JSON.parse(kv.store[`${GONE_DAILY_PREFIX}${DATE}`])).toEqual({ outcomes: { suppressed: 1 }, reportedBySvc: {} })
  })

  it('a current-month accumulator row that saw it resolve settles it as resolved, silently', async () => {
    const kv = fakeKV({ ...heldFor('inc-1'), 'incidents:monthly:2026-10': monthly({ openai: [{ id: 'inc-1', title: 'T', finalStatus: 'resolved' }] }) })
    announce(kv, 'inc-1', ['openai'])
    const send = sendOk()
    const run = await runGoneCheck(kv, send, [svc('openai')], new Set(), LATER)
    expect(run?.outcomes.resolved).toBe(1)
    expect(send).not.toHaveBeenCalled()
  })

  it('a still-open current-month row supplies the title of the report', async () => {
    const kv = fakeKV({ ...heldFor('inc-1'), 'incidents:monthly:2026-10': monthly({ openai: [{ id: 'inc-1', title: 'Elevated errors', finalStatus: 'investigating' }] }) })
    announce(kv, 'inc-1', ['openai'])
    const send = sendOk()
    await runGoneCheck(kv, send, [svc('openai')], new Set(), LATER)
    expect(send.mock.calls[0][0].description).toContain('Elevated errors')
  })

  it('an unresolved row left in the closed previous month is unverified, not reported', async () => {
    const kv = fakeKV({
      'incidents:monthly:2026-09': monthly({ openai: [{ id: 'inc-1', title: 'Boundary incident', finalStatus: 'investigating' }] }),
      [`${GONE_SEEN_PREFIX}inc-1`]: JSON.stringify({ first: Date.parse('2026-10-04T00:00:00Z'), last: Date.parse('2026-10-04T00:00:00Z') + GONE_HOLD_MS - TICK }),
    })
    announce(kv, 'inc-1', ['openai'])
    const send = sendOk()
    const run = await runGoneCheck(kv, send, [svc('openai')], new Set(), Date.parse('2026-10-04T00:00:00Z') + GONE_HOLD_MS)
    expect(run?.outcomes.unverified).toBe(1)
    expect(send).not.toHaveBeenCalled()
  })

  it('an operator-suppressed incident settles as suppressed, silently', async () => {
    const kv = fakeKV({ ...heldFor('inc-1'), 'incident:suppressions': JSON.stringify([{ scope: 'incident', incId: 'inc-1' }]) })
    announce(kv, 'inc-1', ['openai'])
    const send = sendOk()
    const run = await runGoneCheck(kv, send, [svc('openai')], new Set(), LATER)
    expect(run?.outcomes.suppressed).toBe(1)
    expect(send).not.toHaveBeenCalled()
  })

  it('an unreadable suppression list holds the report instead of guessing', async () => {
    const kv = fakeKV(heldFor('inc-1'), { getThrows: (k) => k === 'incident:suppressions' })
    announce(kv, 'inc-1', ['openai'])
    const send = sendOk()
    const run = await runGoneCheck(kv, send, [svc('openai')], new Set(), LATER)
    expect(run?.skipped).toBe(1)
    expect(send).not.toHaveBeenCalled()
    expect(kv.store[`${GONE_HANDLED_PREFIX}inc-1`]).toBeUndefined()
  })

  it('an unreadable hold marker neither confirms nor stamps', async () => {
    const kv = fakeKV(heldFor('inc-1'), { getThrows: (k) => k === `${GONE_SEEN_PREFIX}inc-1` })
    announce(kv, 'inc-1', ['openai'])
    const send = sendOk()
    const before = kv.store[`${GONE_SEEN_PREFIX}inc-1`]
    const run = await runGoneCheck(kv, send, [svc('openai')], new Set(), LATER)
    expect(run?.skipped).toBe(1)
    expect(send).not.toHaveBeenCalled()
    expect(kv.store[`${GONE_SEEN_PREFIX}inc-1`]).toBe(before)
  })

  it('a corrupt hold marker restarts the hold', async () => {
    const kv = fakeKV({ [`${GONE_SEEN_PREFIX}inc-1`]: 'garbage' })
    announce(kv, 'inc-1', ['openai'])
    const send = sendOk()
    const run = await runGoneCheck(kv, send, [svc('openai')], new Set(), LATER)
    expect(run).toMatchObject({ pending: 1 })
    expect(send).not.toHaveBeenCalled()
    expect(parseHold(kv.store[`${GONE_SEEN_PREFIX}inc-1`])).toEqual({ first: LATER, last: LATER })
  })

  it('a legacy announce roster names no service, so it is skipped, never reported', async () => {
    const kv = fakeKV(heldFor('inc-1'))
    kv.store['alerted:new:inc-1'] = '1'
    const send = sendOk()
    const run = await runGoneCheck(kv, send, [svc('openai')], new Set(), LATER)
    expect(run?.skipped).toBe(1)
    expect(send).not.toHaveBeenCalled()
  })

  it('an announce roster whose read fails is skipped and counted, never reported', async () => {
    const kv = fakeKV(heldFor('inc-1'), { getThrows: (k) => k === 'alerted:new:inc-1' })
    announce(kv, 'inc-1', ['openai'])
    const send = sendOk()
    const run = await runGoneCheck(kv, send, [svc('openai')], new Set(), LATER)
    expect(run).toMatchObject({ candidates: 1, skipped: 1 })
    expect(send).not.toHaveBeenCalled()
  })

  it('an unreadable accumulator holds the report: a resolved incident is not turned into an alert by a failed read', async () => {
    const seed = { ...heldFor('inc-1'), 'incidents:monthly:2026-10': monthly({ openai: [{ id: 'inc-1', title: 'T', finalStatus: 'resolved' }] }) }
    const kv = fakeKV(seed, { getThrows: (k) => k.startsWith('incidents:monthly:') })
    announce(kv, 'inc-1', ['openai'])
    const send = sendOk()
    const run = await runGoneCheck(kv, send, [svc('openai')], new Set(), LATER)
    expect(run).toMatchObject({ skipped: 1 })
    expect(send).not.toHaveBeenCalled()
    expect(kv.store[`${GONE_HANDLED_PREFIX}inc-1`]).toBeUndefined()
  })

  it('a failed send leaves the incident unhandled so it is reported again next cycle', async () => {
    const kv = fakeKV(heldFor('inc-1'))
    announce(kv, 'inc-1', ['openai'])
    const send = vi.fn(async (_embed: Embed) => false)
    await runGoneCheck(kv, send, [svc('openai')], new Set(), LATER)
    expect(kv.store[`${GONE_HANDLED_PREFIX}inc-1`]).toBeUndefined()
    const retry = sendOk()
    await runGoneCheck(kv, retry, [svc('openai')], new Set(), LATER + TICK)
    expect(retry).toHaveBeenCalledTimes(1)
  })

  it('an incomplete or failed listing runs nothing', async () => {
    const send = sendOk()
    const kv = fakeKV({}, { incomplete: 'alerted:res:' })
    announce(kv, 'inc-1', ['openai'])
    expect(await runGoneCheck(kv, send, [svc('openai')], new Set(), LATER)).toBeNull()
    expect(send).not.toHaveBeenCalled()
    expect(await runGoneCheck(fakeKV({}, { listThrows: true }), send, [svc('openai')], new Set(), LATER)).toBeNull()
  })

  it('books the outcome counters by day, and the reported ones by service', async () => {
    const kv = fakeKV({ ...heldFor('inc-1'), ...heldFor('inc-2') })
    announce(kv, 'inc-1', ['openai', 'chatgpt']); announce(kv, 'inc-2', ['openai'])
    kv.store['incident:suppressions'] = JSON.stringify([{ scope: 'incident', incId: 'inc-2' }])
    await runGoneCheck(kv, sendOk(), [svc('openai'), svc('chatgpt')], new Set(), LATER)
    expect(JSON.parse(kv.store[`${GONE_DAILY_PREFIX}${DATE}`])).toEqual({
      outcomes: { reported: 1, suppressed: 1 },
      reportedBySvc: { openai: 1, chatgpt: 1 },
    })
  })

  it('an incident missing from several cards is one report, naming each', async () => {
    const kv = fakeKV(heldFor('inc-1'))
    announce(kv, 'inc-1', ['openai', 'chatgpt'])
    const send = sendOk()
    await runGoneCheck(kv, send, [svc('openai'), svc('chatgpt')], new Set(), LATER)
    expect(send).toHaveBeenCalledTimes(1)
    expect(send.mock.calls[0][0].description).toContain('Name-openai, Name-chatgpt')
  })
})

describe('#1118 formatGoneAlert', () => {
  it('caps the lines and says how many were left out', () => {
    const reports = Array.from({ length: GONE_BATCH_MAX + 3 }, (_, i) => ({ incId: `i${i}`, svcIds: ['s'], title: `T${i}` }))
    const embed = formatGoneAlert(reports, new Map())
    expect(embed.description).toContain('…and 3 more')
    expect(embed.description.match(/^• /gm)).toHaveLength(GONE_BATCH_MAX)
    expect(embed.title).toContain(`${GONE_BATCH_MAX + 3} announced incidents`)
  })
  it('says so when the title is no longer held', () => {
    expect(formatGoneAlert([{ incId: 'i', svcIds: ['s'], title: null }], new Map()).description).toContain('title no longer held')
  })
})
