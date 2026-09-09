import test from 'node:test'
import assert from 'node:assert/strict'
import {
  dayRange, dayWindow, buildSearchUrl, isResolvableIdentifier, parseArgs, formatTable,
  formatCell, cellCount, searchCount, xrpc,
} from './bsky-outage-chatter.mjs'

// #1374 — what is gated is every place a silent wrong answer would be indistinguishable from a
// right one. That includes the fetching half: `searchCount` and `xrpc` take an injectable
// `fetchImpl`, so the cap, the shape guard and the error text are all exercised here with no
// account and no network. An earlier header claimed the network made them untestable; it did not.

test('dayRange is inclusive at both ends and walks UTC days', () => {
  assert.deepEqual(dayRange('2026-09-01', '2026-09-03'), ['2026-09-01', '2026-09-02', '2026-09-03'])
  assert.deepEqual(dayRange('2026-09-05', '2026-09-05'), ['2026-09-05'])
})

test('dayRange crosses a month boundary', () => {
  // A naive +1 on the date component would produce 2026-08-32.
  assert.deepEqual(dayRange('2026-08-30', '2026-09-01'), ['2026-08-30', '2026-08-31', '2026-09-01'])
})

test('dayRange throws on an unparseable date rather than returning an empty series', () => {
  // An empty array would read downstream as "no days measured", i.e. a silent zero.
  assert.throws(() => dayRange('nonsense', '2026-09-01'), /bad date range/)
})

test('dayRange throws on an inverted range rather than returning an empty series', () => {
  // Reproduced from an ordinary typo: `--start` a month ahead with `--end` omitted defaults `end` to
  // today, so `days` was `[]`, `probeDay` was `undefined`, and the instrument check requested
  // `undefinedT13:00:00Z` — a silent zero dressed as an access failure.
  assert.throws(() => dayRange('2026-09-09', '2026-09-01'), /is after/)
  assert.deepEqual(dayRange('2026-09-01', '2026-09-01'), ['2026-09-01'], 'a single-day range is not inverted')
})

test('dayWindow spans a whole UTC day', () => {
  assert.deepEqual(dayWindow('2026-09-03'), { since: '2026-09-03T00:00:00Z', until: '2026-09-03T23:59:59Z' })
})

test('buildSearchUrl carries since/until and url-encodes the query', () => {
  const u = buildSearchUrl('https://api.bsky.app', { q: 'claude down', since: 'A', until: 'B' })
  const p = new URL(u).searchParams
  assert.equal(new URL(u).pathname, '/xrpc/app.bsky.feed.searchPosts')
  assert.equal(p.get('q'), 'claude down')
  assert.equal(p.get('since'), 'A')
  assert.equal(p.get('until'), 'B')
  assert.equal(p.get('limit'), '100')
  assert.equal(p.get('cursor'), null)
  // The space must be encoded in the raw string, not only decoded back by URLSearchParams.
  assert.ok(!u.includes('claude down'))
})

test('buildSearchUrl includes the cursor only when paginating', () => {
  const u = buildSearchUrl('https://api.bsky.app', { q: 'x', since: 'A', until: 'B', cursor: 'c1' })
  assert.equal(new URL(u).searchParams.get('cursor'), 'c1')
})

test('isResolvableIdentifier rejects a bare username, accepts handle/email/DID', () => {
  // The reason this is a check and not a comment: a bare username 401s exactly like a wrong
  // password, so without it the operator debugs the credential instead of the identifier.
  assert.equal(isResolvableIdentifier('bentleypark'), false)
  assert.equal(isResolvableIdentifier(''), false)
  assert.equal(isResolvableIdentifier(undefined), false)
  assert.equal(isResolvableIdentifier('bentleypark.bsky.social'), true)
  assert.equal(isResolvableIdentifier('someone@example.com'), true)
  assert.equal(isResolvableIdentifier('did:plc:abc123'), true)
})

test('parseArgs defaults to the nine days ending at --end', () => {
  const a = parseArgs(['--end', '2026-09-09'])
  assert.equal(a.end, '2026-09-09')
  assert.equal(a.start, '2026-09-01')
  assert.equal(dayRange(a.start, a.end).length, 9)
})

test('parseArgs default window crosses a month boundary correctly', () => {
  assert.equal(parseArgs(['--end', '2026-09-03']).start, '2026-08-26')
})

test('parseArgs splits --queries and drops blanks', () => {
  assert.deepEqual(parseArgs(['--queries', 'a, b ,,c']).queries, ['a', 'b', 'c'])
})

test('parseArgs keeps the default appview unless overridden', () => {
  // Defaulting to public.api.bsky.app would 403 on every run; pinning the default is the fix.
  assert.equal(parseArgs([]).appview, 'https://api.bsky.app')
  assert.equal(parseArgs(['--appview', 'https://bsky.social']).appview, 'https://bsky.social')
})

test('formatTable totals each day down the column, and prints 0 for a missing cell', () => {
  const days = ['2026-09-03', '2026-09-06']
  const queries = ['claude down', 'chatgpt down']
  const counts = {
    'claude down': { '2026-09-03': { n: 421, capped: false }, '2026-09-06': { n: 19, capped: false } },
    'chatgpt down': { '2026-09-03': { n: 456, capped: false } },
  }
  const out = formatTable(counts, days, queries)
  const total = out.split('\n').find((l) => l.startsWith('TOTAL'))
  assert.match(total, /877/)   // 421 + 456
  assert.match(total, /\b19\b/) // 19 + a missing cell counted as 0, not skipped

  // The per-query ROW is asserted separately from the total: they are two different expressions in
  // formatTable, and a mutation making the row render a missing cell blank left the total correct
  // and this test green. A blank column silently reads as "no data" instead of "zero".
  const row = out.split('\n').find((l) => l.startsWith('chatgpt down'))
  assert.match(row, /\b0\b/)
  assert.equal(row.trimEnd().endsWith('0'), true, 'a missing cell must render 0, not empty')

  assert.match(out, /09-03/)
  assert.match(out, /09-06/)
})

test('formatCell marks a capped count so truncation cannot read as an exact number', () => {
  // Two capped readings would otherwise compare as "no change" when one could be several times the
  // other — the failure that defeats keeping a baseline as a control.
  assert.equal(formatCell({ n: 1042, capped: true }), '1042+')
  assert.equal(formatCell({ n: 421, capped: false }), '421')
  assert.equal(formatCell(undefined), '0')
})

test('cellCount reads the number out of either shape', () => {
  assert.equal(cellCount({ n: 7, capped: true }), 7)
  assert.equal(cellCount(undefined), 0)
})

test('formatTable propagates the cap marker into the column total', () => {
  // A column containing a capped cell has a lower-bound total; leaving the total unmarked would
  // present a truncated sum as exact.
  const days = ['2026-09-03']
  const queries = ['a', 'b']
  const out = formatTable({ a: { '2026-09-03': { n: 1000, capped: true } }, b: { '2026-09-03': { n: 5, capped: false } } }, days, queries)
  const total = out.split('\n').find((l) => l.startsWith('TOTAL'))
  assert.match(total, /1005\+/)
  const rowA = out.split('\n').find((l) => l.startsWith('a '))
  assert.match(rowA, /1000\+/)
})

test('formatTable leaves an uncapped column total unmarked', () => {
  const out = formatTable({ a: { '2026-09-03': { n: 5, capped: false } } }, ['2026-09-03'], ['a'])
  const total = out.split('\n').find((l) => l.startsWith('TOTAL'))
  assert.doesNotMatch(total, /\+/)
})

// ---- the fetching half, with an injected transport --------------------------

const res = (status, body, ct = 'application/json') => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: (k) => (k.toLowerCase() === 'content-type' ? ct : null) },
  json: async () => body,
  text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
})
const noSleep = async () => {}

test('searchCount flags capped when it stops at the cap, not when it finishes naturally', async () => {
  // The defect this pins: a bare count made "stopped at 1000" indistinguishable from a real 1000,
  // so two truncated readings compared as "no change".
  const page = { posts: Array(94).fill({}), cursor: 'more' }
  const capped = await searchCount('https://api.bsky.app', 't', 'q', 'A', 'B', 100,
    { fetchImpl: async () => res(200, page), sleep: noSleep })
  assert.equal(capped.capped, true)
  assert.ok(capped.n > 100, "n overshoots the cap by up to one page — this fixture's pages give 188")

  const done = await searchCount('https://api.bsky.app', 't', 'q', 'A', 'B', 1000,
    { fetchImpl: async () => res(200, { posts: [{}, {}] }), sleep: noSleep })
  assert.deepEqual(done, { n: 2, capped: false })
})

test('searchCount throws on a 200 whose shape has no posts array, instead of counting zero', async () => {
  // A silent zero here would be read by the doc's own guidance as "not caught by these queries".
  await assert.rejects(
    searchCount('https://api.bsky.app', 't', 'claude down', 'A', 'B', 1000,
      { fetchImpl: async () => res(200, { unexpected: true }), sleep: noSleep }),
    /no posts array for "claude down"/,
  )
})

test('xrpc reports status, content-type and a body excerpt — and asserts no cause', async () => {
  // The classification this replaced was wrong twice: first it described only the HTML branch, then
  // the rule itself was falsified (api.bsky.app answers HTML 403 with no Authorization header).
  await assert.rejects(
    xrpc('https://api.bsky.app/xrpc/app.bsky.feed.searchPosts', undefined,
      async () => res(403, '<html><body><h1>403 Forbidden</h1>\nRequest forbidden</body></html>', 'text/html'),
      noSleep),
    (e) => {
      assert.match(e.message, /HTTP 403/)
      assert.match(e.message, /\[text\/html\]/)
      assert.match(e.message, /403 Forbidden/)
      assert.doesNotMatch(e.message, /edge block|appview host|WAF/i,
        'must not name a cause — the body-shape-to-cause rule was falsified')
      return true
    },
  )
})

test('xrpc surfaces an XRPC error object without claiming what caused it', async () => {
  await assert.rejects(
    xrpc('https://bsky.social/xrpc/app.bsky.feed.searchPosts', undefined,
      async () => res(401, { error: 'AuthMissing', message: 'Authentication Required' }), noSleep),
    (e) => {
      assert.match(e.message, /HTTP 401/)
      assert.match(e.message, /AuthMissing/)
      return true
    },
  )
})

test('xrpc retries a 429 and gives up loudly rather than returning an empty result', async () => {
  let calls = 0
  await assert.rejects(
    xrpc('https://api.bsky.app/xrpc/app.bsky.feed.searchPosts', 't',
      async () => { calls += 1; return res(429, 'rate limited', 'text/plain') }, noSleep),
    /HTTP 429/,
  )
  assert.equal(calls, 4, 'three retries then a throw — never a silent zero')
})

test('xrpc sends the Authorization header only when a token is supplied', async () => {
  let seen
  await xrpc('https://api.bsky.app/xrpc/x', 'tok', async (_u, init) => { seen = init; return res(200, { ok: 1 }) }, noSleep)
  assert.equal(seen.headers.Authorization, 'Bearer tok')
  await xrpc('https://api.bsky.app/xrpc/x', undefined, async (_u, init) => { seen = init; return res(200, { ok: 1 }) }, noSleep)
  assert.equal(seen, undefined)
})
