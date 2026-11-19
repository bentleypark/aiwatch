import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildServiceRows, indexFirstUpdates, matchXaiByStart, rowsByService, XAI_MATCH_WINDOW_MIN } from './build-recovery-training-set'

const atl = (t: string, body = 'Investigating') => ({ kind: 'atlassian', status: 200, n: 5, first: { t, s: 'investigating', body } })
const io = (...updates: Array<[string, string, string]>) => ({ status: 200, updates: updates.map(([published_at, to_status, text]) => ({ published_at, to_status, text })) })

test('indexFirstUpdates takes Atlassian from the join pull and incident.io from its own pull', () => {
  const byId = indexFirstUpdates(
    {
      'https://status.claude.com|abc': atl('2026-05-01T10:00:00Z', 'We are investigating.'),
      'status.openai.com|01K': { kind: 'incidentio', status: 200, first: { t: '2026-05-02T00:00:00Z', s: 'investigating', body: '{"feature_set":"mrkdwn","text_node":{"ty' } },
    },
    { 'status.openai.com|01K': io(['2026-05-02T09:00:00Z', 'resolved', 'Fixed.'], ['2026-05-02T08:00:00Z', 'investigating', 'Looking into it.']) },
  )
  assert.deepEqual(byId.get('abc'), { at: '2026-05-01T10:00:00Z', stage: 'investigating', body: 'We are investigating.', source: 'atlassian' })
  assert.deepEqual(byId.get('01K'), { at: '2026-05-02T08:00:00Z', stage: 'investigating', body: 'Looking into it.', source: 'incidentio' })
})

test('indexFirstUpdates never takes an incident.io body from the join pull', () => {
  const byId = indexFirstUpdates({ 'status.openai.com|01K': { kind: 'incidentio', status: 200, first: { t: '2026-05-02T00:00:00Z', s: 'investigating', body: '{"feature_set"' } } }, {})
  assert.equal(byId.has('01K'), false)
})

test('indexFirstUpdates leaves out a failed fetch and an empty timeline', () => {
  const byId = indexFirstUpdates(
    { 'h|a': { kind: 'atlassian', status: 404 }, 'h|b': { kind: 'atlassian', status: 200, first: null } },
    { 'i|c': { status: 404 }, 'i|d': io() },
  )
  assert.equal(byId.size, 0)
})

test('indexFirstUpdates refuses one id under two hosts', () => {
  assert.throws(() => indexFirstUpdates({ 'h1|x': atl('2026-05-01T00:00:00Z'), 'h2|x': atl('2026-05-01T00:00:00Z') }, {}), /keyed under h1 and h2/)
})

const xaiInc = (id: string, started_at: string, updates: string[]) => ({
  id,
  started_at,
  incident_updates: updates.map((created_at) => ({ status: `s@${created_at}`, body: `b@${created_at}`, created_at })),
})

test('matchXaiByStart takes the one incident inside the window, earliest update first', () => {
  const got = matchXaiByStart('2026-10-01T10:00:00Z', [xaiInc('p1', '2026-10-01T10:05:00Z', ['2026-10-01T11:00:00Z', '2026-10-01T10:05:00Z']), xaiInc('p2', '2026-10-02T10:00:00Z', ['2026-10-02T10:00:00Z'])])
  assert.deepEqual(got, { at: '2026-10-01T10:05:00Z', stage: 's@2026-10-01T10:05:00Z', body: 'b@2026-10-01T10:05:00Z', source: 'xai-compat' })
})

test('matchXaiByStart returns null for none or several inside the window', () => {
  const t = '2026-10-01T10:00:00Z'
  const outside = new Date(Date.parse(t) + (XAI_MATCH_WINDOW_MIN + 1) * 60_000).toISOString()
  assert.equal(matchXaiByStart(t, [xaiInc('p', outside, [outside])]), null)
  assert.equal(matchXaiByStart(t, [xaiInc('a', t, [t]), xaiInc('b', '2026-10-01T10:09:00Z', [t])]), null)
})

const cfg = { id: 'claude', provider: 'Anthropic', category: 'api' as const, autoMonitorTitles: [/^auto check$/] }
const row = (id: string, over: Partial<{ title: string; startedAt: string; resolvedAt: string | null; durationMin: number; autoMonitor: boolean }> = {}) => ({
  id,
  title: 'Elevated errors',
  startedAt: '2026-05-01T10:00:00Z',
  resolvedAt: '2026-05-01T11:00:00Z',
  durationMin: 60,
  ...over,
})

test('buildServiceRows keeps the rows summarizeRecoveryHistory counts, with an override applied', () => {
  const rows = buildServiceRows(
    cfg,
    [row('a'), row('a'), row('open', { resolvedAt: null }), row('stamped', { autoMonitor: true }), row('auto', { title: 'auto check' }), row('zero', { durationMin: 0 }), row('ovr')],
    [{ id: 'ovr', durationMin: 7, reason: 'r', by: 'operator', createdAt: '2026-05-02T00:00:00Z' }],
    new Map(),
    [],
  )
  assert.deepEqual(rows.map((r) => [r.id, r.durationMin]), [['a', 60], ['ovr', 7]])
})

test('buildServiceRows emits every column from the archive row, the config and the first update, and no update count', () => {
  const archived = { ...row('a'), impact: 'major', derived: 'status_history', startUnknown: true }
  const [r] = buildServiceRows(cfg, [archived], [], new Map([['a', { at: '2026-05-01T10:12:00Z', stage: 'identified', body: 'x', source: 'atlassian' as const }]]), [])
  assert.deepEqual(r, {
    svc: 'claude',
    provider: 'Anthropic',
    category: 'api',
    group: 'llm',
    id: 'a',
    title: 'Elevated errors',
    finalImpact: 'major',
    startedAt: '2026-05-01T10:00:00Z',
    resolvedAt: '2026-05-01T11:00:00Z',
    durationMin: 60,
    derived: true,
    startUnknown: true,
    timesInverted: false,
    first: { at: '2026-05-01T10:12:00Z', stage: 'identified', body: 'x', source: 'atlassian', delayMin: 12 },
  })
})

test('buildServiceRows flags a row that resolves before it starts', () => {
  const rows = buildServiceRows(cfg, [row('inv', { startedAt: '2026-07-16T13:46:43Z', resolvedAt: '2026-05-22T12:54:43Z', durationMin: 1 }), row('ok')], [], new Map(), [])
  assert.deepEqual(rows.map((r) => [r.id, r.timesInverted]), [['inv', true], ['ok', false]])
})

test('buildServiceRows matches by start time only on the x.ai compat services', () => {
  const xai = [xaiInc('p', '2026-05-01T10:00:00Z', ['2026-05-01T10:00:00Z'])]
  assert.equal(buildServiceRows(cfg, [row('a')], [], new Map(), xai)[0].first, null)
  for (const id of ['cursor', 'grokbot']) assert.equal(buildServiceRows({ ...cfg, id }, [row('a')], [], new Map(), xai)[0].first?.source, 'xai-compat', id)
})

test('rowsByService concatenates each service across archive months', () => {
  const got = rowsByService([{ services: { claude: { incidentList: [row('a')] } } }, { services: { claude: { incidentList: [row('b')] }, openai: {} } }])
  assert.deepEqual([...got].map(([s, rs]) => [s, rs.map((r) => r.id)]), [['claude', ['a', 'b']], ['openai', []]])
})
