import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  parseStep0,
  checkStep0,
  renderStep0,
  summarizeHistory,
  summarizeProbe,
  detectUptime,
  compareProbe,
  measureCloudflareV3,
  measureAtlassian,
  runProbe,
} from './service-step0.mjs'

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'service-step0.mjs')

const codes = (r) => r.errors.map((e) => (e.row ? `${e.code}:${e.row}` : e.code))

const BLOCK = `## Step-0 audit
generated: 2026-11-12 by scripts/service-step0.mjs
source: cloudflare-v3
- uptime: none | scope=cloudflare-v3 summary+history | evidence=no uptime or percent key | status=measured
- history: n=10 | scope=card(2 ids) | window=2026-04-23..2026-11-11 | exhausted=no | by-impact=minor:8,none:2 | page-wide=571 | status=measured
- probe: gateway-level | control=yes | evidence=/ai/run 401/40ms equals /d1 control | status=measured
- gap: Inference & Infra already has nine other services | status=measured
- boundary: Workers AI is the product; AI Gateway is unproven | status=measured
verdict: hold
`

const withLine = (text, from, to) => {
  assert.ok(text.includes(from), `fixture lost the line: ${from}`)
  return text.replace(from, to)
}

describe('summarizeHistory', () => {
  const rows = [
    { id: 'a', type: 'incident', impact: 'minor', startsAt: '2026-11-10T00:00:00Z', componentIds: ['AI'] },
    { id: 'b', type: 'incident', impact: 'none', startsAt: '2026-10-27T00:00:00Z', componentIds: ['AI', 'WORKERS'] },
    { id: 'c', type: 'incident', impact: 'major', startsAt: '2026-10-01T00:00:00Z', componentIds: ['WORKERS'] },
    { id: 'd', type: 'incident', impact: 'minor', startsAt: '2026-05-01T00:00:00Z', componentIds: ['DC'] },
    { id: 'e', type: 'maintenance', impact: 'maintenance', startsAt: '2026-04-23T00:00:00Z', componentIds: ['AI'] },
  ]

  test('counts only the card ids, and reports the page-wide figure beside it so the scopes cannot be confused', () => {
    const s = summarizeHistory(rows, ['AI', 'GW'])
    assert.equal(s.n, 2)
    assert.deepEqual(s.byImpact, { minor: 1, none: 1 })
    assert.equal(s.pageWide, 4)
  })

  test('a maintenance row naming a card id is not an incident', () => {
    assert.equal(summarizeHistory(rows, ['AI']).n, 2)
    assert.equal(summarizeHistory([rows[4]], ['AI']).n, 0)
  })

  test('the window spans every fetched row, not only the card rows', () => {
    const s = summarizeHistory(rows, ['AI'])
    assert.equal(s.windowFrom, '2026-04-23')
    assert.equal(s.windowTo, '2026-11-10')
  })

  test('an id that no row names counts zero while the page-wide figure stays', () => {
    const s = summarizeHistory(rows, ['NOPE'])
    assert.equal(s.n, 0)
    assert.equal(s.pageWide, 4)
  })
})

describe('detectUptime', () => {
  test('reports none with the keys it looked at', () => {
    const r = detectUptime(['id', 'name', 'status', 'created_at'])
    assert.equal(r.result, 'none')
    assert.match(r.evidence, /id, name, status, created_at/)
  })

  test('reports present when a key names uptime or a percentage', () => {
    assert.equal(detectUptime(['id', 'uptime_percent']).result, 'present')
    assert.equal(detectUptime(['id', 'percent']).result, 'present')
  })

  test('prose that merely says "availability" is not a field', () => {
    assert.equal(detectUptime(['id', 'availability_notes_text']).result, 'none')
  })
})

describe('compareProbe', () => {
  const garbage = { kind: 'garbage', label: '/zzz', statuses: [404, 404, 404, 404, 404], timesMs: [190, 200, 185, 195, 192] }
  const sibling = { kind: 'sibling', label: '/d1', statuses: [401, 401, 401, 401, 401], timesMs: [44, 40, 50, 47, 55] }
  const probe = (statuses, timesMs) => ({ statuses, timesMs })

  test('the same status at about the same latency as a sibling path is the gateway, not the service', () => {
    assert.equal(compareProbe(probe([401, 401, 401, 401, 401], [40, 41, 39, 42, 40]), [garbage, sibling]).verdict, 'gateway-level')
  })

  test('the same status and latency as a garbage path is a catch-all', () => {
    assert.equal(compareProbe(probe([404, 404, 404, 404, 404], [180, 190, 200, 188, 191]), [garbage, sibling]).verdict, 'catch-all')
  })

  test('the same status at a very different latency is not a match', () => {
    assert.equal(compareProbe(probe([401, 401, 401, 401, 401], [400, 410, 390, 420, 405]), [garbage, sibling]).verdict, 'distinct')
  })

  test('a status no control gives is distinct and needs a human verdict', () => {
    assert.equal(compareProbe(probe([405, 405, 405, 405, 405], [39, 40, 41, 38, 42]), [garbage, sibling]).verdict, 'distinct')
  })

  test('a server error or no answer is unreachable, whatever the controls say', () => {
    assert.equal(compareProbe(probe([503, 503, 503, 503, 503], [40, 40, 40, 40, 40]), [garbage, sibling]).verdict, 'unreachable')
    assert.equal(compareProbe(probe([0, 0, 0, 0, 0], [10000, 10000, 10000, 10000, 10000]), [garbage, sibling]).verdict, 'unreachable')
  })

  test('the modal status decides, one stray response does not', () => {
    assert.equal(compareProbe(probe([401, 401, 401, 429, 401], [40, 41, 39, 42, 40]), [garbage, sibling]).verdict, 'gateway-level')
  })
})

describe('summarizeProbe', () => {
  const v = (verdict) => ({ verdict })
  test('candidates that agree on a negative verdict keep it', () => {
    assert.equal(summarizeProbe([v('catch-all'), v('catch-all')]), 'catch-all')
    assert.equal(summarizeProbe([v('gateway-level')]), 'gateway-level')
  })

  test('candidates that disagree, or any distinct one, are left for a person', () => {
    assert.equal(summarizeProbe([v('catch-all'), v('unreachable')]), 'distinct')
    assert.equal(summarizeProbe([v('gateway-level'), v('distinct')]), 'distinct')
  })
})

describe('checkStep0', () => {
  test('a complete measured block with a verdict passes', () => {
    assert.deepEqual(checkStep0(BLOCK), { ok: true, errors: [] })
  })

  test('no block at all', () => {
    assert.deepEqual(codes(checkStep0('just a comment')), ['no-block'])
  })

  test('replay of #1385 at work start: the probe row was "Not checked", so the check fails', () => {
    const state = withLine(BLOCK, '- probe: gateway-level | control=yes | evidence=/ai/run 401/40ms equals /d1 control | status=measured', '- probe: unmeasured | status=unmeasured')
    assert.ok(codes(checkStep0(withLine(state, 'verdict: hold', 'verdict: add'))).includes('row-unmeasured:probe'))
  })

  test('every row must be measured, each named in the error', () => {
    const t = withLine(withLine(BLOCK, '- uptime: none | scope=cloudflare-v3 summary+history | evidence=no uptime or percent key | status=measured', '- uptime: unmeasured | status=unmeasured'), '- boundary: Workers AI is the product; AI Gateway is unproven | status=measured', '- boundary: unmeasured | status=unmeasured')
    assert.deepEqual(codes(checkStep0(t)).filter((c) => c.startsWith('row-unmeasured')).sort(), ['row-unmeasured:boundary', 'row-unmeasured:uptime'])
  })

  test('a missing row is an error, not a pass', () => {
    const t = BLOCK.split('\n').filter((l) => !l.startsWith('- gap:')).join('\n')
    assert.ok(codes(checkStep0(t)).includes('row-missing:gap'))
  })

  test('the history row must carry its scope, window and whether the feed was exhausted', () => {
    const noScope = withLine(BLOCK, '| scope=card(2 ids) ', '')
    const noWindow = withLine(BLOCK, '| window=2026-04-23..2026-11-11 ', '')
    const noExhausted = withLine(BLOCK, '| exhausted=no ', '')
    const noN = withLine(BLOCK, 'history: n=10 |', 'history: ten |')
    assert.ok(codes(checkStep0(noScope)).includes('history-scope:history'))
    assert.ok(codes(checkStep0(noWindow)).includes('history-window:history'))
    assert.ok(codes(checkStep0(noExhausted)).includes('history-exhausted:history'))
    assert.ok(codes(checkStep0(noN)).includes('history-n:history'))
  })

  test('a probe still marked distinct has no human verdict yet', () => {
    const t = withLine(BLOCK, '- probe: gateway-level |', '- probe: distinct |')
    assert.ok(codes(checkStep0(t)).includes('probe-unresolved:probe'))
  })

  test('a probe row needs a control, and "representative" needs evidence', () => {
    assert.ok(codes(checkStep0(withLine(BLOCK, '| control=yes ', ''))).includes('probe-control:probe'))
    const rep = withLine(BLOCK, '- probe: gateway-level | control=yes | evidence=/ai/run 401/40ms equals /d1 control |', '- probe: representative | control=yes |')
    assert.ok(codes(checkStep0(rep)).includes('probe-evidence:probe'))
  })

  test('a gap or boundary row that still says unmeasured, or is empty, does not pass by flipping its status', () => {
    for (const row of ['gap', 'boundary']) {
      const line = BLOCK.split('\n').find((l) => l.startsWith(`- ${row}:`))
      assert.ok(codes(checkStep0(withLine(BLOCK, line, `- ${row}: unmeasured | status=measured`))).includes(`row-empty:${row}`), `${row} unmeasured`)
      assert.ok(codes(checkStep0(withLine(BLOCK, line, `- ${row}: | status=measured`))).includes(`row-empty:${row}`), `${row} empty`)
    }
  })

  test('uptime needs the evidence it was read from', () => {
    const t = withLine(BLOCK, '| evidence=no uptime or percent key ', '')
    assert.ok(codes(checkStep0(t)).includes('uptime-evidence:uptime'))
  })

  test('the block must say which source it measured and when', () => {
    assert.ok(codes(checkStep0(withLine(BLOCK, 'source: cloudflare-v3\n', ''))).includes('block-source'))
    assert.ok(codes(checkStep0(withLine(BLOCK, 'generated: 2026-11-12 by scripts/service-step0.mjs\n', ''))).includes('block-generated'))
  })

  test('the verdict must be add or hold', () => {
    assert.ok(codes(checkStep0(withLine(BLOCK, 'verdict: hold\n', ''))).includes('verdict-missing'))
    assert.ok(codes(checkStep0(withLine(BLOCK, 'verdict: hold', 'verdict: maybe'))).includes('verdict-missing'))
  })

  test('a thin card (no uptime, no representative probe) may be added only with a stated reason', () => {
    const add = withLine(BLOCK, 'verdict: hold', 'verdict: add')
    assert.ok(codes(checkStep0(add)).includes('thin-card-ack'))
    assert.deepEqual(checkStep0(`${add}thin-card-ack: fills the only gap in the Image bucket\n`), { ok: true, errors: [] })
    assert.deepEqual(checkStep0(BLOCK), { ok: true, errors: [] })
  })

  test('a card with uptime is not thin, however the probe came out', () => {
    const t = withLine(withLine(BLOCK, '- uptime: none | scope=cloudflare-v3 summary+history |', '- uptime: present | scope=card(2 ids) |'), 'verdict: hold', 'verdict: add')
    assert.deepEqual(checkStep0(t), { ok: true, errors: [] })
  })

  test('uptime present on a scope wider than the card does not stop a card from being thin', () => {
    const t = withLine(withLine(BLOCK, '- uptime: none | scope=cloudflare-v3 summary+history |', '- uptime: present | scope=page |'), 'verdict: hold', 'verdict: add')
    assert.ok(codes(checkStep0(t)).includes('uptime-scope:uptime'))
  })

  test('a card with a representative probe is not thin', () => {
    const t = withLine(withLine(BLOCK, '- probe: gateway-level | control=yes | evidence=/ai/run 401/40ms equals /d1 control |', '- probe: representative | control=yes | evidence=public health endpoint, 200, distinct from controls |'), 'verdict: hold', 'verdict: add')
    assert.deepEqual(checkStep0(t), { ok: true, errors: [] })
  })
})

describe('checkStep0 row values (a value outside the allowed set is not a measurement)', () => {
  const ADD = 'verdict: add\nthin-card-ack: needed for the platform context'
  test('an uptime that is neither none nor present is refused, and cannot slip a thin card past its acknowledgement', () => {
    const odd = withLine(withLine(BLOCK, '- uptime: none |', '- uptime: yes |'), 'verdict: hold', 'verdict: add')
    assert.deepEqual(codes(checkStep0(odd)), ['uptime-result:uptime'])
  })

  test('a probe result outside the known set is refused', () => {
    assert.deepEqual(codes(checkStep0(withLine(BLOCK, '- probe: gateway-level |', '- probe: fine |'))), ['probe-result:probe'])
  })

  test('probe none needs evidence but not a control: nothing was reached to control against', () => {
    const none = withLine(BLOCK, '- probe: gateway-level | control=yes | evidence=/ai/run 401/40ms equals /d1 control |', '- probe: none | evidence=no endpoint answers without a key |')
    assert.deepEqual(codes(checkStep0(none)), [])
    const bare = withLine(BLOCK, '- probe: gateway-level | control=yes | evidence=/ai/run 401/40ms equals /d1 control |', '- probe: none |')
    assert.deepEqual(codes(checkStep0(bare)), ['probe-evidence:probe'])
  })

  test('a probe other than none needs the control', () => {
    assert.deepEqual(codes(checkStep0(withLine(BLOCK, ' control=yes |', ' |'))), ['probe-control:probe'])
  })

  test('a thin card added with a reason passes', () => {
    assert.deepEqual(codes(checkStep0(withLine(BLOCK, 'verdict: hold', ADD))), [])
  })
})

describe('checkStep0 against a previous record that cannot be read', () => {
  const flipped = withLine(BLOCK, 'verdict: hold', 'verdict: add\nthin-card-ack: needed for the platform context')
  test('an empty previous file, one with no block, or raw measure output with no verdict is refused, never read as no change', () => {
    for (const previous of ['', '{"body":"## Step-0 audit\\n- uptime: none"}', BLOCK.replace('verdict: hold\n', '')]) {
      assert.deepEqual(codes(checkStep0(flipped, { previous })), ['previous-unreadable'], previous)
    }
  })

  test('a previous record with a verdict is read as before', () => {
    assert.deepEqual(codes(checkStep0(flipped, { previous: BLOCK })), ['verdict-change-missing'])
  })
})

describe('checkStep0 against a previous record (a verdict change must account for the evidence that moved)', () => {
  const previous = BLOCK
  const flipped = (text) => withLine(text, 'verdict: hold', 'verdict: add\nthin-card-ack: needed for the platform context')

  test('the same verdict needs nothing, even when rows moved', () => {
    const moved = withLine(BLOCK, 'n=10', 'n=12')
    assert.deepEqual(checkStep0(moved, { previous }), { ok: true, errors: [] })
  })

  test('a changed verdict with no verdict-change line is refused', () => {
    assert.ok(codes(checkStep0(flipped(withLine(BLOCK, 'n=10', 'n=40')), { previous })).includes('verdict-change-missing'))
  })

  test('every row that moved must be listed', () => {
    const cur = `${flipped(withLine(withLine(BLOCK, 'n=10', 'n=40'), '| exhausted=no', '| exhausted=yes'))}verdict-change: history\n`
    assert.deepEqual(codes(checkStep0(cur, { previous })), [])
    const two = `${flipped(withLine(withLine(BLOCK, 'n=10', 'n=40'), '- gap: Inference & Infra already has nine other services', '- gap: the Image bucket has one service'))}verdict-change: history\n`
    assert.ok(codes(checkStep0(two, { previous })).includes('verdict-change-unlisted:gap'))
  })

  test('a listed row that did not move is refused', () => {
    const cur = `${flipped(withLine(BLOCK, 'n=10', 'n=40'))}verdict-change: history, probe\n`
    assert.ok(codes(checkStep0(cur, { previous })).includes('verdict-change-unmoved:probe'))
  })

  test('a re-measurement that only moved the latency, the window or the page-wide count did not move those rows', () => {
    const remeasured = withLine(withLine(withLine(BLOCK, 'evidence=/ai/run 401/40ms equals /d1 control', 'evidence=/ai/run 401/43ms equals /d1 control'), '2026-04-23..2026-11-11', '2026-04-23..2026-11-12'), 'page-wide=571', 'page-wide=570')
    const cur = `${flipped(withLine(remeasured, 'n=10', 'n=40'))}verdict-change: history\n`
    assert.deepEqual(codes(checkStep0(cur, { previous })), [])
  })

  test('a moved window or page-wide count alone does not oblige listing the history row', () => {
    const shifted = withLine(withLine(withLine(BLOCK, '2026-04-23..2026-11-11', '2026-04-23..2026-11-12'), 'page-wide=571', 'page-wide=570'), '- gap: Inference & Infra already has nine other services', '- gap: the Image bucket has one service')
    assert.deepEqual(codes(checkStep0(`${flipped(shifted)}verdict-change: gap\n`, { previous })), [])
  })

  test('each decision-relevant field, moved alone, moves its row', () => {
    const alone = [
      ['uptime', withLine(BLOCK, '- uptime: none | scope=cloudflare-v3 summary+history |', '- uptime: none | scope=card(2 ids) |')],
      ['history', withLine(BLOCK, '| exhausted=no ', '| exhausted=yes ')],
      ['history', withLine(BLOCK, '| scope=card(2 ids) |', '| scope=card(3 ids) |')],
      ['history', withLine(BLOCK, 'n=10', 'n=11')],
      ['gap', withLine(BLOCK, '- gap: Inference & Infra already has nine other services', '- gap: Inference & Infra has ten services')],
      ['boundary', withLine(BLOCK, 'AI Gateway is unproven', 'AI Gateway is proven')],
    ]
    for (const [row, cur] of alone) {
      const out = codes(checkStep0(`${flipped(cur)}verdict-change: probe\n`, { previous }))
      assert.ok(out.includes(`verdict-change-unlisted:${row}`), `${row}: ${out.join(',')}`)
    }
  })

  test('a probe run without its controls moved the probe row', () => {
    const cur = withLine(BLOCK, '| control=yes ', '| control=no ')
    assert.ok(codes(checkStep0(`${flipped(cur)}verdict-change: history\n`, { previous })).includes('verdict-change-unlisted:probe'))
  })

  test('a probe whose verdict changed did move, whatever the latency', () => {
    const cur = withLine(BLOCK, '- probe: gateway-level | control=yes | evidence=/ai/run 401/40ms equals /d1 control |', '- probe: representative | control=yes | evidence=public health endpoint, 200 |')
    assert.ok(codes(checkStep0(`${flipped(cur)}verdict-change: history\n`, { previous })).includes('verdict-change-unlisted:probe'))
  })

  test('a flip on a record where nothing moved is refused', () => {
    const cur = `${flipped(BLOCK)}verdict-change: history\n`
    assert.ok(codes(checkStep0(cur, { previous })).includes('verdict-change-unmoved:history'))
  })
})

describe('renderStep0 / parseStep0', () => {
  const measured = {
    generated: '2026-11-12',
    source: 'cloudflare-v3',
    uptime: { result: 'none', scope: 'cloudflare-v3 summary+history', evidence: 'no uptime or percent key' },
    history: { n: 10, scope: 'card(2 ids)', windowFrom: '2026-04-23', windowTo: '2026-11-11', exhausted: 'no', byImpact: { minor: 8, none: 2 }, pageWide: 571 },
    probe: { result: 'gateway-level', control: true, evidence: '/ai/run 401/40ms equals /d1 control' },
  }

  test('what measure prints parses back to the same rows', () => {
    const p = parseStep0(renderStep0(measured))
    assert.equal(p.rows.uptime.result, 'none')
    assert.equal(p.rows.history.fields.n, '10')
    assert.equal(p.rows.history.fields['page-wide'], '571')
    assert.equal(p.rows.history.fields['by-impact'], 'minor:8,none:2')
    assert.equal(p.rows.probe.result, 'gateway-level')
  })

  test('the printed block cannot pass check: gap, boundary and the verdict are left to a human', () => {
    const r = checkStep0(renderStep0(measured))
    assert.deepEqual(codes(r).sort(), ['row-unmeasured:boundary', 'row-unmeasured:gap', 'verdict-missing'].sort())
  })

  test('a source the script cannot read is printed unmeasured, never skipped', () => {
    const text = renderStep0({ generated: '2026-11-12', source: 'rootly', uptime: null, history: null, probe: null })
    const r = checkStep0(text)
    for (const row of ['uptime', 'history', 'probe']) assert.ok(codes(r).includes(`row-unmeasured:${row}`))
  })
})

describe('measureCloudflareV3', () => {
  const summary = { success: true, result: { components: [{ id: 'AI', name: 'Workers AI', status: 'operational', group_id: 'g', type: 'component' }, { id: 'GW', name: 'AI Gateway', status: 'operational', group_id: 'g', type: 'component' }] } }
  const incident = (id, comps, startsAt) => ({ id, type: 'incident', impact: 'minor', starts_at: startsAt, components: comps.map((c) => ({ id: c })) })
  const pages = [
    { result: [incident('a', ['AI'], '2026-11-10T00:00:00Z'), incident('b', ['WORKERS'], '2026-11-09T00:00:00Z')], result_info: { next_cursor: 'c2' } },
    { result: [incident('c', ['AI', 'GW'], '2026-10-01T00:00:00Z')], result_info: { next_cursor: 'c3' } },
    { result: [{ id: 'm', type: 'maintenance', impact: 'maintenance', starts_at: '2026-05-01T00:00:00Z', components: [{ id: 'AI' }] }], result_info: {} },
  ]
  const fakeFetch = (log) => async (url) => {
    log.push(url)
    if (url.endsWith('/api/v3/summary')) return { ok: true, json: async () => summary }
    const u = new URL(url)
    const cursor = u.searchParams.get('cursor')
    const page = cursor === 'c2' ? pages[1] : cursor === 'c3' ? pages[2] : pages[0]
    return { ok: true, json: async () => ({ success: true, ...page }) }
  }

  test('follows the cursor to the end and says the feed was exhausted', async () => {
    const log = []
    const m = await measureCloudflareV3({ fetchImpl: fakeFetch(log), ids: ['AI', 'GW'], maxPages: 10 })
    assert.equal(m.exhausted, 'yes')
    assert.equal(m.rows.length, 4)
    assert.equal(log.filter((u) => u.includes('/history')).length, 3)
    assert.deepEqual(m.history.byImpact, { minor: 2 })
    assert.equal(m.history.n, 2)
    assert.equal(m.history.pageWide, 3)
    assert.equal(m.uptime.result, 'none')
  })

  test('stopping at the page cap is reported as not exhausted', async () => {
    const m = await measureCloudflareV3({ fetchImpl: fakeFetch([]), ids: ['AI'], maxPages: 2 })
    assert.equal(m.exhausted, 'no')
    assert.equal(m.rows.length, 3)
  })

  test('a first history page that does not answer leaves the card unmeasured, never an empty feed', async () => {
    const f = async (url) => (url.endsWith('/api/v3/summary')
      ? { ok: true, json: async () => summary }
      : { ok: false, status: 503, json: async () => ({}) })
    const m = await measureCloudflareV3({ fetchImpl: f, ids: ['AI'], maxPages: 5 })
    assert.equal(m.history, null)
    assert.equal(m.uptime, null)
  })

  test('uptime is read from the card components, not from the first component of the page', async () => {
    const f = (components) => async (url) => (url.endsWith('/api/v3/summary')
      ? { ok: true, json: async () => ({ success: true, result: { components } }) }
      : { ok: true, json: async () => ({ success: true, result: [], result_info: {} }) })
    const other = await measureCloudflareV3({ fetchImpl: f([{ id: 'X', uptime_pct: 1 }, { id: 'AI', name: 'Workers AI' }]), ids: ['AI'], maxPages: 1 })
    assert.equal(other.uptime.result, 'none')
    assert.match(other.uptime.scope, /^card/)
    const own = await measureCloudflareV3({ fetchImpl: f([{ id: 'X' }, { id: 'AI', uptime_pct: 99.9 }]), ids: ['AI'], maxPages: 1 })
    assert.equal(own.uptime.result, 'present')
  })

  test('when none of the card ids is among the summary components, uptime is unmeasured rather than none', async () => {
    const f = async (url) => (url.endsWith('/api/v3/summary')
      ? { ok: true, json: async () => ({ success: true, result: { components: [{ id: 'X' }] } }) }
      : { ok: true, json: async () => ({ success: true, result: [], result_info: {} }) })
    const m = await measureCloudflareV3({ fetchImpl: f, ids: ['AI'], maxPages: 1 })
    assert.equal(m.uptime, null)
    assert.equal(m.history, null)
  })

  test('one typo among several card ids leaves the card unmeasured', async () => {
    const m = await measureCloudflareV3({ fetchImpl: fakeFetch([]), ids: ['AI', 'GWX'], maxPages: 5 })
    assert.equal(m.history, null)
    assert.equal(m.uptime, null)
  })

  test('with unknown card ids the history is not even requested', async () => {
    const log = []
    const f = async (url) => { log.push(url); return url.endsWith('/api/v3/summary') ? { ok: true, json: async () => ({ success: true, result: { components: [{ id: 'X' }] } }) } : { ok: true, json: async () => ({ success: true, result: [], result_info: {} }) } }
    await measureCloudflareV3({ fetchImpl: f, ids: ['AI'], maxPages: 5 })
    assert.equal(log.filter((u) => u.includes('/history')).length, 0)
  })

  test('an unreadable summary leaves every row unmeasured instead of throwing', async () => {
    const m = await measureCloudflareV3({ fetchImpl: async () => ({ ok: false, status: 503, json: async () => ({}) }), ids: ['AI'], maxPages: 2 })
    assert.equal(m.uptime, null)
    assert.equal(m.history, null)
  })
})

describe('measureAtlassian', () => {
  const incidents = Array.from({ length: 50 }, (_, i) => ({
    id: `i${i}`, impact: 'minor', created_at: `2026-11-${String(10 - (i % 9)).padStart(2, '0')}T00:00:00Z`,
    components: i < 3 ? [{ id: 'C1' }] : [{ id: 'OTHER' }],
  }))
  // components.json as an Atlassian page serves it: a group and its children, groups flagged `group: true`.
  const COMPONENTS = { components: [
    { id: 'C1', group: false, group_id: 'G1' },
    { id: 'C2', group: false, group_id: 'G1' },
    { id: 'G1', group: true, group_id: null },
  ] }
  const fakeFetch = (html, { components = COMPONENTS, list = incidents, pageOk = true, incidentsOk = true } = {}) => async (url) => {
    if (url.endsWith('/api/v2/incidents.json')) return incidentsOk ? { ok: true, json: async () => ({ incidents: list }) } : { ok: false, status: 503, json: async () => ({}) }
    if (url.endsWith('/api/v2/components.json')) {
      return components === null ? { ok: false, status: 503, json: async () => ({}) } : { ok: true, json: async () => components }
    }
    return pageOk ? { ok: true, text: async () => html } : { ok: false, status: 403, text: async () => html }
  }
  const measure = (fetchImpl, ids) => measureAtlassian({ fetchImpl, baseUrl: 'https://status.example.com', ids })

  test('a feed that returns exactly its cap is flagged as possibly truncated, and counts only the card ids', async () => {
    const m = await measure(fakeFetch('<html></html>'), ['C1'])
    assert.equal(m.history.n, 3)
    assert.equal(m.history.pageWide, 50)
    assert.equal(m.exhausted, 'unknown')
  })

  test('a feed shorter than its cap is complete', async () => {
    const m = await measure(fakeFetch('', { list: incidents.slice(0, 7) }), ['C1'])
    assert.equal(m.exhausted, 'yes')
    assert.equal(m.history.pageWide, 7)
  })

  test('an id that is not a component of the page leaves the card unmeasured, never a quiet zero', async () => {
    const m = await measure(fakeFetch(''), ['TYPO'])
    assert.equal(m.history, null)
    assert.equal(m.uptime, null)
    assert.deepEqual(m.unresolved.map((u) => u.id), ['TYPO'])
    assert.match(m.unresolved[0].reason, /not a component/)
  })

  test('one typo among several card ids leaves the card unmeasured, naming only the id that failed', async () => {
    const m = await measure(fakeFetch(''), ['TYPO', 'C1'])
    assert.equal(m.history, null)
    assert.deepEqual(m.unresolved.map((u) => u.id), ['TYPO'])
  })

  test('a group id is not a card component: incidents never name a group, so a measured zero would be false', async () => {
    const m = await measure(fakeFetch(''), ['G1'])
    assert.equal(m.history, null)
    assert.equal(m.uptime, null)
    assert.match(m.unresolved[0].reason, /group/)
  })

  test('the group\'s child ids are measured, and a group id mixed in still refuses the card', async () => {
    assert.equal((await measure(fakeFetch(''), ['C1', 'C2'])).history.n, 3)
    assert.equal((await measure(fakeFetch(''), ['C1', 'G1'])).history, null)
  })

  test('a components.json that does not answer, or is empty (an incident.io page), leaves the card unmeasured', async () => {
    assert.equal((await measure(fakeFetch('', { components: null }), ['C1'])).history, null)
    assert.equal((await measure(fakeFetch('', { components: { components: [] } }), ['C1'])).history, null)
  })

  test('a page that does not answer leaves uptime unmeasured while the history is still measured, whatever body the failure carries', async () => {
    const m = await measure(fakeFetch('<title>Just a moment...</title>', { pageOk: false }), ['C1'])
    assert.equal(m.uptime, null)
    assert.equal(m.history.n, 3)
  })

  test('a failed response whose body would read as a placeholder is not read as the page', async () => {
    const m = await measure(fakeFetch('<div data-uptime-lazy="C1"></div>', { pageOk: false }), ['C1'])
    assert.equal(m.uptime, null)
  })

  test('an incidents.json that does not answer leaves the history unmeasured, never an empty feed', async () => {
    const m = await measure(fakeFetch('<div data-uptime-lazy="C1"></div>', { incidentsOk: false }), ['C1'])
    assert.equal(m.history, null)
    assert.equal(m.uptime.result, 'present')
  })

  test('uptime is present only when a lazy-uptime placeholder is keyed by one of the card ids', async () => {
    const own = await measure(fakeFetch('<div data-uptime-lazy="C1"></div>'), ['C1'])
    assert.equal(own.uptime.result, 'present')
    assert.match(own.uptime.scope, /^card/)
  })

  test('placeholders for other components of the page do not make the card look like it publishes uptime', async () => {
    const other = await measure(fakeFetch('<div data-uptime-lazy="OTHER"></div><div data-uptime-lazy="MORE"></div>'), ['C1'])
    assert.equal(other.uptime.result, 'none')
    assert.match(other.uptime.scope, /^card/)
    assert.match(other.uptime.evidence, /2 placeholders/)
  })

  test('a page with no placeholder at all is none', async () => {
    assert.equal((await measure(fakeFetch('<p>nothing</p>'), ['C1'])).uptime.result, 'none')
  })

  test('the placeholders are matched on any of several card ids', async () => {
    const m = await measure(fakeFetch('<div data-uptime-lazy="C2"></div>'), ['C1', 'C2'])
    assert.equal(m.uptime.result, 'present')
  })
})

describe('runProbe', () => {
  test('samples each url the requested number of times and records status and time', async () => {
    const calls = []
    const fetchImpl = async (url) => { calls.push(url); return { status: url.includes('garbage') ? 404 : 401 } }
    const out = await runProbe({ fetchImpl, urls: ['https://x.test/a', 'https://x.test/garbage'], samples: 3, timeoutMs: 1000 })
    assert.equal(calls.length, 6)
    assert.deepEqual(out[0].statuses, [401, 401, 401])
    assert.deepEqual(out[1].statuses, [404, 404, 404])
    assert.equal(out[0].timesMs.length, 3)
  })

  test('a request that throws is a status 0 sample', async () => {
    const out = await runProbe({ fetchImpl: async () => { throw new Error('boom') }, urls: ['https://x.test/a'], samples: 2, timeoutMs: 1000 })
    assert.deepEqual(out[0].statuses, [0, 0])
  })
})

describe('CLI check', () => {
  const dir = mkdtempSync(join(tmpdir(), 'step0-'))
  const file = (name, text) => { const p = join(dir, name); writeFileSync(p, text); return p }

  test('exits 0 for a passing block and 1 with the error codes for a failing one', () => {
    execFileSync('node', [SCRIPT, 'check', file('ok.md', BLOCK)], { encoding: 'utf8' })
    const bad = spawnSync('node', [SCRIPT, 'check', file('bad.md', withLine(BLOCK, 'status=measured\nverdict', 'status=unmeasured\nverdict'))], { encoding: 'utf8' })
    assert.equal(bad.status, 1)
    assert.match(bad.stdout + bad.stderr, /row-unmeasured/)
  })

  test('--previous applies the verdict-change rule', () => {
    const prev = file('prev.md', BLOCK)
    const cur = file('cur.md', withLine(BLOCK, 'verdict: hold', 'verdict: add\nthin-card-ack: x'))
    const r = spawnSync('node', [SCRIPT, 'check', cur, '--previous', prev], { encoding: 'utf8' })
    assert.equal(r.status, 1)
    assert.match(r.stdout + r.stderr, /verdict-change-missing/)
  })

  test('measure refuses a page cap that is not a positive integer before touching the network', () => {
    for (const bad of ['0', 'abc', '-3']) {
      const r = spawnSync('node', [SCRIPT, 'measure', '--source', 'cloudflare-v3', '--ids', 'a', '--max-pages', bad], { encoding: 'utf8' })
      assert.equal(r.status, 2, bad)
    }
  })

  test('an unknown subcommand or a missing file exits 2', () => {
    assert.equal(spawnSync('node', [SCRIPT, 'frobnicate'], { encoding: 'utf8' }).status, 2)
    assert.equal(spawnSync('node', [SCRIPT, 'check', join(dir, 'nope.md')], { encoding: 'utf8' }).status, 2)
  })
})
