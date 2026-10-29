import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  classifyBrowserRun, browserRunDataPoint, runBrowserRead, BROWSER_RUN_INDEX, onReaderTick, createReader,
} from './mistral-browser-run.mjs'
import {
  CloudflareChallengeError, RosterShortError, MistralPageContractError,
  readV3Roster, readIncidentLinks, readIncidentPage, loadV3Roster,
} from './scrape-mistral-status.mjs'
import { readFileSync } from 'node:fs'
import { handleMistralEmail } from '../worker/src/mistral-email.ts'

// #1851 — cases from the 2026-10-29 Browser Run probe: 15 of 15 cards after scrolling, 10 of 15
// without, and a 403 carrying `cf-mitigated: challenge`.

const INCIDENT = 'https://status.mistral.ai/incidents/0b6c5a8e-1f2d-4c3b-9a7e-5d4f3c2b1a09'
const response = (status, headers = {}) => ({ ok: () => status < 400, status: () => status, headers: () => headers })
const cards = (n) => Array.from({ length: n }, (_, i) => ({ id: `c${i}`, name: `Component ${i}`, iconClass: 'text-pothos-500', bars: [] }))

/** A page whose first navigation answers `first`, whose roster reads `rosters` in turn, and whose history lists one incident. */
function probePage({ first = response(200), rosters = [{ expected: 15, cards: cards(15) }] } = {}) {
  let navigations = 0
  return {
    goto: async () => (navigations++ === 0 ? first : response(200)),
    waitForSelector: async () => {},
    evaluate: async (fn) => {
      if (fn === readV3Roster) return rosters.length > 1 ? rosters.shift() : rosters[0]
      if (fn === readIncidentLinks) return [INCIDENT]
      if (fn === readIncidentPage) return { title: 'API errors', rows: [['Resolved', 'October 20, 2026 at 10:12 PM UTC', 'Fixed.']] }
    },
  }
}

function harness(page, { status = 200 } = {}) {
  const posts = []
  const points = []
  let now = 1_000
  return {
    posts,
    points,
    run: () => runBrowserRead({
      withPage: async (fn) => fn(page),
      workerUrl: 'https://aiwatch-worker',
      token: 't',
      transport: async (url, init) => {
        posts.push({ url, body: JSON.parse(init.body), auth: init.headers.Authorization })
        return { ok: status < 400, status, text: async () => '{}' }
      },
      record: (p) => points.push(p),
      clock: () => (now += 20_000),
    }),
  }
}

test('a full read the Worker stores is a pass, pushed to the feed endpoint with the scraper payload', async () => {
  const h = harness(probePage({ rosters: [{ expected: 15, cards: cards(10) }, { expected: 15, cards: cards(15) }] }))
  assert.equal(await h.run(), 'pass')
  assert.deepEqual(h.posts.map((p) => p.url), ['https://aiwatch-worker/api/internal/mistral-feed', 'https://aiwatch-worker/api/internal/mistral-feed-observation'])
  assert.deepEqual(h.posts[1].body, { delivery: 'stored', listed: 1, fetched: 1, available: 1, uptimeLostTooltips: 0 })
  assert.equal(h.posts[0].auth, 'Bearer t')
  assert.equal(h.posts[0].body.components.length, 15)
  assert.equal(h.posts[0].body.uptime.length, 15)
  assert.deepEqual(h.posts[0].body.coverage, { listed: 1, fetched: 1, available: 1 })
  assert.deepEqual(h.points, [{
    blobs: [BROWSER_RUN_INDEX, 'pass'], doubles: [1, 20_000, 15, 1, 1], indexes: [BROWSER_RUN_INDEX],
  }])
})

test('a challenged first navigation is recorded as challenged and pushes nothing', async () => {
  const h = harness(probePage({ first: response(403, { 'cf-mitigated': 'challenge' }) }))
  assert.equal(await h.run(), 'challenged')
  assert.deepEqual(h.posts.map((p) => [p.url, p.body]), [['https://aiwatch-worker/api/internal/mistral-feed-observation', { delivery: 'not-posted' }]])
  assert.deepEqual(h.points[0].doubles, [1, 20_000, 0, 0, 0])
})

test('a full read the Worker refuses is rejected, with the read counters kept', async () => {
  const h = harness(probePage(), { status: 422 })
  assert.equal(await h.run(), 'rejected')
  assert.deepEqual(h.points[0].blobs, [BROWSER_RUN_INDEX, 'rejected'])
  assert.deepEqual(h.points[0].doubles, [1, 20_000, 15, 1, 1])
})

test('a page-contract failure reaches the observation endpoint the Worker alerts on', async () => {
  const h = harness(probePage({ rosters: [{ expected: 0, cards: [] }] }))
  assert.equal(await h.run(), 'page-contract')
  assert.deepEqual(h.posts.map((p) => [p.url, p.body]), [['https://aiwatch-worker/api/internal/mistral-feed-observation', { delivery: 'not-posted', failure: 'page-contract' }]])
})

test('a roster that stays at 10 of 15 throws RosterShortError, which classifies as roster-short', async () => {
  const page = probePage({ rosters: [{ expected: 15, cards: cards(10) }] })
  const err = await loadV3Roster(page, 2, async () => {}).catch((e) => e)
  assert.ok(err instanceof RosterShortError)
  assert.equal(classifyBrowserRun('not-posted', err), 'roster-short')
})

test('each failure class maps to its own outcome; an unknown error is error, and delivery wins over the error', () => {
  assert.equal(classifyBrowserRun('not-posted', new CloudflareChallengeError('x')), 'challenged')
  assert.equal(classifyBrowserRun('not-posted', new MistralPageContractError('x')), 'page-contract')
  assert.equal(classifyBrowserRun('not-posted', new Error('Navigation timeout')), 'error')
  assert.equal(classifyBrowserRun('not-posted', undefined), 'error')
  assert.equal(classifyBrowserRun('rejected', new Error('push failed: HTTP 422')), 'rejected')
  assert.equal(classifyBrowserRun('stored', undefined), 'pass')
})

test('a failing record sink does not turn the outcome into a throw', async () => {
  const outcome = await runBrowserRead({
    withPage: async () => { throw new Error('browser unavailable') },
    workerUrl: 'https://aiwatch-worker',
    token: 't',
    transport: async () => { throw new Error('unreachable') },
    record: () => { throw new Error('WAE down') },
  })
  assert.equal(outcome, 'error')
})

test('the data point carries zero counters when no payload was read', () => {
  assert.deepEqual(browserRunDataPoint('error', 5, undefined).doubles, [1, 5, 0, 0, 0])
})

test('a tick reads at :41 or on a consumed wake; any KV failure means no wake and never costs the :41 read', async () => {
  const tick = async (hhmm, kv) => {
    let reads = 0
    const ran = await onReaderTick({ scheduledTime: Date.parse(`2026-10-29T${hhmm}:00Z`), env: { STATUS_CACHE: kv }, read: async () => { reads++ } })
    return { ran, reads }
  }
  const store = (entries = []) => {
    const m = new Map(entries)
    return { m, get: async (k) => m.get(k) ?? null, delete: async (k) => { m.delete(k) } }
  }
  const fail = async () => { throw new Error('KV 503') }
  const cases = [
    ['08:23', store(), { ran: false, reads: 0 }],
    ['08:41', store(), { ran: true, reads: 1 }],
    ['08:40', store(), { ran: false, reads: 0 }],
    ['08:42', store(), { ran: false, reads: 0 }],
    ['08:23', store([['mistral:wake', '1']]), { ran: true, reads: 1 }],
    ['08:41', store([['mistral:wake', '1']]), { ran: true, reads: 1 }],
    ['08:41', { get: fail, delete: fail }, { ran: true, reads: 1 }],
    ['08:41', { get: async () => '1', delete: fail }, { ran: true, reads: 1 }],
    ['08:23', { get: fail, delete: fail }, { ran: false, reads: 0 }],
    ['08:23', { get: async () => '1', delete: fail }, { ran: false, reads: 0 }],
  ]
  for (const [hhmm, kv, want] of cases) assert.deepEqual(await tick(hhmm, kv), want, `${hhmm}`)

  const woken = store([['mistral:wake', '1']])
  assert.deepEqual(await tick('08:23', woken), { ran: true, reads: 1 })
  assert.equal(woken.m.has('mistral:wake'), false, 'the flag is consumed')
  assert.deepEqual(await tick('08:24', woken), { ran: false, reads: 0 }, 'a consumed flag does not read again')
})

test('the flag the email handler sets is the one a reader tick consumes, from the same STATUS_CACHE namespace', async () => {
  const m = new Map()
  const kv = { get: async (k) => m.get(k) ?? null, put: async (k, v) => { m.set(k, v) }, delete: async (k) => { m.delete(k) } }
  const pending = []
  const headers = new Headers({ from: 'Mistral AI <notifications@rootly.com>', subject: 'Mistral AI | API errors' })
  await handleMistralEmail({ headers, from: 'x@rootly.com', forward: async () => {} }, { STATUS_CACHE: kv }, { waitUntil: (p) => pending.push(p) })
  await Promise.all(pending)
  let reads = 0
  await onReaderTick({ scheduledTime: Date.parse('2026-10-29T08:23:00Z'), env: { STATUS_CACHE: kv }, read: async () => { reads++ } })
  assert.equal(reads, 1)
  assert.equal(m.size, 0)

  const kvId = (path) => {
    const block = readFileSync(new URL(path, import.meta.url), 'utf8').split('[[kv_namespaces]]').find((b) => /binding\s*=\s*"STATUS_CACHE"/.test(b))
    return /\bid\s*=\s*"([^"]+)"/.exec(block ?? '')?.[1]
  }
  assert.ok(kvId('../worker/wrangler.toml'))
  assert.equal(kvId('../mistral-reader/wrangler.toml'), kvId('../worker/wrangler.toml'))
})

test('a reader with no STATUS_CACHE binding still reads at :41, and says so in the log', async () => {
  const warns = []
  const warn = console.warn
  console.warn = (msg) => warns.push(msg)
  try {
    let reads = 0
    const read = async () => { reads++ }
    await onReaderTick({ scheduledTime: Date.parse('2026-10-29T08:41:00Z'), env: {}, read })
    await onReaderTick({ scheduledTime: Date.parse('2026-10-29T08:23:00Z'), env: {}, read })
    assert.equal(reads, 1)
  } finally {
    console.warn = warn
  }
  assert.equal(warns.length, 2)
  assert.match(warns[0], /\[browser-run\] wake flag unreadable/)
})

test('the reader Worker reads at :41 and on a wake, launching on env.BROWSER and pushing over env.AIWATCH with env.MISTRAL_FEED_TOKEN', async () => {
  const m = new Map()
  const launched = []
  let closed = 0
  const posts = []
  const points = []
  const env = {
    BROWSER: 'browser-binding',
    MISTRAL_FEED_TOKEN: 'tok',
    STATUS_CACHE: { get: async (k) => m.get(k) ?? null, delete: async (k) => { m.delete(k) } },
    AIWATCH: { fetch: async (url, init) => { posts.push([url, init.headers.Authorization]); return { ok: true, status: 200, text: async () => '{}' } } },
    ANALYTICS: { writeDataPoint: (p) => points.push(p) },
  }
  const reader = createReader(async (binding) => {
    launched.push(binding)
    return { newPage: async () => probePage(), close: async () => { closed++ } }
  })
  await reader.scheduled({ scheduledTime: Date.parse('2026-10-29T08:23:00Z') }, env)
  assert.equal(launched.length, 0)
  await reader.scheduled({ scheduledTime: Date.parse('2026-10-29T08:41:00Z') }, env)
  m.set('mistral:wake', '1')
  await reader.scheduled({ scheduledTime: Date.parse('2026-10-29T08:24:00Z') }, env)
  assert.deepEqual(launched, ['browser-binding', 'browser-binding'])
  assert.equal(closed, 2)
  assert.deepEqual(posts.map(([url]) => url), Array(2).fill(['https://aiwatch-worker/api/internal/mistral-feed', 'https://aiwatch-worker/api/internal/mistral-feed-observation']).flat())
  assert.ok(posts.every(([, auth]) => auth === 'Bearer tok'))
  assert.deepEqual(points.map((p) => p.blobs[1]), ['pass', 'pass'])
})
