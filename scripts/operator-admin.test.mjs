import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { acquireLock, confirmMutation, CONFIRM_WAIT_MS } from './operator-admin.mjs'

// Virtual clock: sleep() parks on a timer queue; run() fires timers in time order until the
// callers settle, so concurrent CLI runs interleave deterministically.
function makeClock() {
  let now = 0
  const timers = []
  return {
    now: () => now,
    sleep: (ms) => new Promise((resolve) => timers.push({ at: now + ms, resolve })),
    async run(promises) {
      let done = false
      const all = Promise.all(promises).then((v) => { done = true; return v })
      for (;;) {
        await new Promise((r) => setImmediate(r))
        if (done || timers.length === 0) return all
        timers.sort((a, b) => a.at - b.at)
        const t = timers.shift()
        now = t.at
        t.resolve()
      }
    },
  }
}

// The admin endpoint's shape: read the whole list, mutate it, write it back. Each read returns the
// newest write at least `lagMs` old, so a write within the lag is invisible to the next request.
function makeLaggingEndpoint(clock, lagMs) {
  const writes = [{ at: -Infinity, list: [] }]
  const read = () => writes.filter((w) => w.at <= clock.now() - lagMs).at(-1).list
  return {
    latest: () => writes.at(-1).list,
    send: (body) => async () => {
      const list = read()
      const has = list.includes(body.id)
      const changed = body.action === 'add' ? !has : has
      if (changed) writes.push({ at: clock.now(), list: body.action === 'add' ? [...list, body.id] : list.filter((x) => x !== body.id) })
      return { ok: true, status: 200, json: { ok: true, changed } }
    },
  }
}

const LAG = 60_000

async function cli(clock, endpoint, body, startAt, { confirm }) {
  await clock.sleep(startAt)
  const send = endpoint.send(body)
  const first = await send()
  assert.equal(first.json.changed, true)
  if (!confirm) return null
  return confirmMutation({ send, sleep: clock.sleep })
}

test('two adds 5s apart: without the confirm the first add is lost (the #1740 reproduction)', async () => {
  const clock = makeClock()
  const ep = makeLaggingEndpoint(clock, LAG)
  await clock.run([
    cli(clock, ep, { action: 'add', id: 'A' }, 0, { confirm: false }),
    cli(clock, ep, { action: 'add', id: 'B' }, 5_000, { confirm: false }),
  ])
  assert.deepEqual(ep.latest(), ['B'])
})

test('two adds 5s apart: with the confirm both entries survive, and the lost one is re-written', async () => {
  const clock = makeClock()
  const ep = makeLaggingEndpoint(clock, LAG)
  const [a, b] = await clock.run([
    cli(clock, ep, { action: 'add', id: 'A' }, 0, { confirm: true }),
    cli(clock, ep, { action: 'add', id: 'B' }, 5_000, { confirm: true }),
  ])
  assert.deepEqual([...ep.latest()].sort(), ['A', 'B'])
  assert.deepEqual([a.confirmed, a.resends], [true, 1])
  assert.deepEqual([b.confirmed, b.resends], [true, 0])
})

test('two adds at any gap within the lag: both survive and both exit confirmed only when stored', async () => {
  for (let gap = 0; gap <= LAG + 5_000; gap += 1_000) {
    const clock = makeClock()
    const ep = makeLaggingEndpoint(clock, LAG)
    const [a, b] = await clock.run([
      cli(clock, ep, { action: 'add', id: 'A' }, 0, { confirm: true }),
      cli(clock, ep, { action: 'add', id: 'B' }, gap, { confirm: true }),
    ])
    assert.deepEqual([...ep.latest()].sort(), ['A', 'B'], `gap ${gap}ms`)
    assert.deepEqual([a.confirmed, b.confirmed], [true, true], `gap ${gap}ms`)
  }
})

test('three adds back to back (the #1740 case): all three survive', async () => {
  const clock = makeClock()
  const ep = makeLaggingEndpoint(clock, LAG)
  const runs = await clock.run(['A', 'B', 'C'].map((id, i) => cli(clock, ep, { action: 'add', id }, i * 3_000, { confirm: true })))
  assert.deepEqual([...ep.latest()].sort(), ['A', 'B', 'C'])
  assert.ok(runs.every((r) => r.confirmed))
})

test('runs one after another, each waiting for its confirm, keep every entry', async () => {
  const clock = makeClock()
  const ep = makeLaggingEndpoint(clock, LAG)
  await clock.run([(async () => {
    for (const id of ['A', 'B', 'C', 'D']) {
      const r = await cli(clock, ep, { action: 'add', id }, 0, { confirm: true })
      assert.equal(r.confirmed, true)
    }
  })()])
  assert.deepEqual(ep.latest(), ['A', 'B', 'C', 'D'])
})

test('an add and a remove of another entry: the remove does not resurrect, the add survives', async () => {
  const clock = makeClock()
  const ep = makeLaggingEndpoint(clock, LAG)
  await clock.run([cli(clock, ep, { action: 'add', id: 'X' }, 0, { confirm: true })])
  const [add, rm] = await clock.run([
    cli(clock, ep, { action: 'add', id: 'A' }, 0, { confirm: true }),
    cli(clock, ep, { action: 'remove', id: 'X' }, 5_000, { confirm: true }),
  ])
  assert.deepEqual(ep.latest(), ['A'])
  assert.equal(add.confirmed, true)
  assert.equal(rm.confirmed, true)
})

test('each check waits the confirm interval before re-sending', async () => {
  const waits = []
  let sends = 0
  const r = await confirmMutation({
    send: async () => { sends++; return { ok: true, json: { changed: false } } },
    sleep: async (ms) => { waits.push(ms) },
  })
  assert.deepEqual(waits, [CONFIRM_WAIT_MS])
  assert.equal(sends, 1)
  assert.equal(r.confirmed, true)
})

test('a list that never holds the change is reported unconfirmed after the last check', async () => {
  let sends = 0
  const r = await confirmMutation({
    send: async () => { sends++; return { ok: true, json: { changed: true } } },
    sleep: async () => {},
    attempts: 3,
  })
  assert.equal(r.confirmed, false)
  assert.equal(sends, 3)
  assert.equal(r.resends, 3)
})

test('a failed re-send stops the loop and is reported unconfirmed', async () => {
  let sends = 0
  const fail = { ok: false, status: 502, json: { ok: false } }
  const r = await confirmMutation({
    send: async () => { sends++; return fail },
    sleep: async () => {},
  })
  assert.equal(r.confirmed, false)
  assert.equal(sends, 1)
  assert.equal(r.last, fail)
})

// ── The CLIs end to end against a local stand-in for the admin endpoints ──
import http from 'node:http'
import { spawn } from 'node:child_process'

async function withEndpoint(changedSeq, fn, getFields = {}) {
  const posts = []
  const stored = new Set()
  const stateful = (b) => {
    const key = b.incId ?? b.id
    const changed = b.action === 'add' ? !stored.has(key) : stored.has(key)
    if (b.action === 'add') stored.add(key)
    else stored.delete(key)
    return changed
  }
  const server = http.createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => { raw += c })
    req.on('end', () => {
      if (req.method === 'POST') posts.push(JSON.parse(raw))
      const step = changedSeq === 'stateful'
        ? stateful(JSON.parse(raw || '{}'))
        : changedSeq[Math.min(posts.length - 1, changedSeq.length - 1)]
      if (req.method === 'POST' && step === 'drop') return req.socket.destroy()
      if (req.url.startsWith('/refuse/') || (req.method === 'POST' && step === 502)) {
        res.writeHead(502, { 'Content-Type': 'application/json' })
        return res.end(JSON.stringify({ ok: false }))
      }
      const changed = req.method === 'POST' ? step : undefined
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true, ...(changed === undefined ? {} : { changed }), ...(req.method === 'GET' ? getFields : {}) }))
    })
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  try {
    return await fn(`http://127.0.0.1:${server.address().port}`, posts)
  } finally {
    server.close()
  }
}

function runCli(script, args, workerUrl, { tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'op-admin-')), waitMs = '0' } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [new URL(script, import.meta.url).pathname, ...args], {
      env: { ...process.env, ADMIN_API_KEY: 'k', WORKER_URL: workerUrl, OPERATOR_CONFIRM_WAIT_MS: waitMs, TMPDIR: tmpdir },
    })
    let out = ''
    child.stdout.on('data', (c) => { out += c })
    child.stderr.on('data', (c) => { out += c })
    const timer = setTimeout(() => child.kill(), 60_000)
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, out }) })
  })
}

const CLIS = [
  ['suppress-incident.mjs', ['add', '--scope', 'incident', '--incId', 'i1']],
  ['duration-override.mjs', ['add', '--id', 'i1', '--minutes', '18']],
]

for (const [script, args] of CLIS) {
  test(`${script}: a write is re-sent until the endpoint answers changed:false`, async () => {
    await withEndpoint([true, true, false], async (url, posts) => {
      const r = await runCli(script, args, url)
      assert.equal(r.code, 0, r.out)
      assert.equal(posts.length, 3)
      assert.deepEqual(posts[2], posts[0])
      assert.match(r.out, /check 2\/3: confirmed/)
    })
  })

  test(`${script}: a write that is never confirmed exits 1 after the last check`, async () => {
    await withEndpoint([true], async (url, posts) => {
      const r = await runCli(script, args, url)
      assert.equal(r.code, 1, r.out)
      assert.match(r.out, /NOT CONFIRMED/)
      assert.equal(posts.length, 4)
    })
  })

  test(`${script}: a refused first write exits 1 without confirming`, async () => {
    await withEndpoint([true], async (url, posts) => {
      const r = await runCli(script, args, url.replace(/:(\d+)$/, ':$1/refuse'))
      assert.equal(r.code, 1, r.out)
      assert.equal(posts.length, 1)
    })
  })

  test(`${script}: a --confirm value other than off is refused before any request`, async () => {
    await withEndpoint([true], async (url, posts) => {
      const r = await runCli(script, [...args, '--confirm', 'of'], url)
      assert.equal(r.code, 2, r.out)
      assert.equal(posts.length, 0)
    })
  })

  test(`${script}: a failed confirm request is reported as such, not as a list that lacks the change`, async () => {
    await withEndpoint([true, 502], async (url, posts) => {
      const r = await runCli(script, args, url)
      assert.equal(r.code, 1, r.out)
      assert.equal(posts.length, 2)
      assert.match(r.out, /NOT CONFIRMED: a confirm request failed \(HTTP 502\)/)
      assert.doesNotMatch(r.out, /did not hold this change/)
    })
  })

  test(`${script}: a confirm request that cannot connect is reported as NOT CONFIRMED`, async () => {
    await withEndpoint([true, 'drop'], async (url, posts) => {
      const r = await runCli(script, args, url)
      assert.equal(r.code, 1, r.out)
      assert.equal(posts.length, 2)
      assert.match(r.out, /NOT CONFIRMED: a confirm request failed \(/)
    })
  })

  test(`${script}: --confirm off sends once`, async () => {
    await withEndpoint([true], async (url, posts) => {
      const r = await runCli(script, [...args, '--confirm', 'off'], url)
      assert.equal(r.code, 0, r.out)
      assert.equal(posts.length, 1)
    })
  })
}

for (const minutes of ['', ' ', '0x10', '1e2', '-1', 'abc']) {
  test(`duration-override.mjs: --minutes ${JSON.stringify(minutes)} is refused before any request`, async () => {
    await withEndpoint([true], async (url, posts) => {
      const r = await runCli('duration-override.mjs', ['add', '--id', 'i1', '--minutes', minutes], url)
      assert.equal(r.code, 2, r.out)
      assert.equal(posts.length, 0)
    })
  })
}

test('duration-override.mjs: --minutes 0 and 12.5 are sent as numbers', async () => {
  for (const [minutes, expected] of [['0', 0], ['12.5', 12.5]]) {
    await withEndpoint([true], async (url, posts) => {
      const r = await runCli('duration-override.mjs', ['add', '--id', 'i1', '--minutes', minutes, '--confirm', 'off'], url)
      assert.equal(r.code, 0, r.out)
      assert.equal(posts[0].durationMin, expected)
    })
  }
})

test('#1814 suppress-incident sends --svc as svcId for an incident-scope entry', async () => {
  await withEndpoint([true, false], async (url, posts) => {
    const r = await runCli('suppress-incident.mjs', ['add', '--scope', 'incident', '--incId', 'i1', '--svc', 'cursor'], url)
    assert.equal(r.code, 0, r.out)
    assert.equal(posts[0].svcId, 'cursor')
    assert.equal(posts[0].incId, 'i1')
  }, { incidentSvcScope: true })
})

test('#1814 suppress-incident --svc writes nothing to a Worker that does not scope incident suppressions', async () => {
  await withEndpoint([true, false], async (url, posts) => {
    const r = await runCli('suppress-incident.mjs', ['add', '--scope', 'incident', '--incId', 'i1', '--svc', 'cursor'], url)
    assert.equal(r.code, 2, r.out)
    assert.equal(posts.length, 0)
    assert.match(r.out, /Deploy the Worker first/)
  })
})

test('#1814 suppress-incident --svc reports a failed check as a failure, not as an old Worker', async () => {
  await withEndpoint([true], async (url, posts) => {
    const r = await runCli('suppress-incident.mjs', ['add', '--scope', 'incident', '--incId', 'i1', '--svc', 'cursor'], `${url}/refuse`)
    assert.equal(r.code, 1, r.out)
    assert.equal(posts.length, 0)
    assert.doesNotMatch(r.out, /Deploy the Worker first/)
  })
  const r = await runCli('suppress-incident.mjs', ['add', '--scope', 'incident', '--incId', 'i1', '--svc', 'cursor'], 'http://127.0.0.1:1')
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /Network error/)
})

test('two runs of one CLI started together do not interleave their writes', async () => {
  const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'op-admin-'))
  await withEndpoint('stateful', async (url, posts) => {
    const [a, b] = await Promise.all(['A', 'B'].map((incId) =>
      runCli('suppress-incident.mjs', ['add', '--scope', 'incident', '--incId', incId], url, { tmpdir, waitMs: '300' })))
    assert.equal(a.code, 0, a.out)
    assert.equal(b.code, 0, b.out)
    const order = posts.map((p) => p.incId).join('')
    assert.ok(order === 'AABB' || order === 'BBAA', order)
  })
})

test('a lock left by a process that is no longer running stops the run with its path, before any request', async () => {
  const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'op-admin-'))
  const dead = spawn(process.execPath, ['-e', ''])
  await new Promise((r) => dead.on('close', r))
  const lockPath = path.join(tmpdir, 'aiwatch-admin-api-admin-suppress.lock')
  fs.writeFileSync(lockPath, String(dead.pid))
  await withEndpoint('stateful', async (url, posts) => {
    const r = await runCli('suppress-incident.mjs', ['add', '--scope', 'incident', '--incId', 'A'], url, { tmpdir })
    assert.equal(r.code, 2, r.out)
    assert.ok(r.out.includes(lockPath), r.out)
    assert.equal(posts.length, 0)
  })
  assert.equal(fs.readFileSync(lockPath, 'utf8'), String(dead.pid))
})

for (const [signal, exitCode] of [['SIGINT', 130], ['SIGTERM', 143]]) {
  test(`a run stopped by ${signal} while it holds the lock releases it`, async () => {
    const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'op-admin-'))
    const lockPath = path.join(tmpdir, 'aiwatch-admin-api-admin-suppress.lock')
    await withEndpoint('stateful', async (url, posts) => {
      const child = spawn(process.execPath, [new URL('suppress-incident.mjs', import.meta.url).pathname, 'add', '--scope', 'incident', '--incId', 'A'], {
        env: { ...process.env, ADMIN_API_KEY: 'k', WORKER_URL: url, OPERATOR_CONFIRM_WAIT_MS: '60000', TMPDIR: tmpdir },
      })
      let out = ''
      child.stdout.on('data', (c) => { out += c })
      const closed = new Promise((r) => child.on('close', (c, sig) => r(c ?? sig)))
      let done = false
      closed.then(() => { done = true })
      while (!out.includes('Confirming') && !done) await new Promise((r) => setTimeout(r, 20))
      assert.equal(done, false, `exited before the confirm wait: ${out}`)
      assert.equal(fs.existsSync(lockPath), true)
      child.kill(signal)
      assert.equal(await closed, exitCode)
      assert.equal(posts.length, 1)
    })
    assert.equal(fs.existsSync(lockPath), false)
  })
}

test('a lock held by a process this user cannot signal (EPERM) counts as held', async () => {
  const lockPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'op-admin-')), 'x.lock')
  fs.writeFileSync(lockPath, '1')
  let polls = 0
  const lines = []
  const got = await acquireLock(lockPath, {
    sleep: async () => { if (++polls === 2) fs.rmSync(lockPath) },
    log: (l) => lines.push(l),
  })
  assert.equal(polls, 2)
  assert.equal(lines.length, 1)
  assert.match(lines[0], /Waiting for another run/)
  assert.equal(fs.readFileSync(lockPath, 'utf8'), String(process.pid))
  got.release()
  assert.equal(fs.existsSync(lockPath), false)
})

test('release does not remove a lock that another run now holds', async () => {
  const lockPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'op-admin-')), 'x.lock')
  const got = await acquireLock(lockPath, { sleep: async () => {} })
  fs.rmSync(lockPath)
  fs.writeFileSync(lockPath, '1')
  got.release()
  assert.equal(fs.readFileSync(lockPath, 'utf8'), '1')
})

test('eight processes contending for one lock never hold it at the same time', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'op-admin-'))
  const lockPath = path.join(dir, 'x.lock')
  const logPath = path.join(dir, 'log')
  const mod = new URL('operator-admin.mjs', import.meta.url).href
  const worker = `
    import fs from 'node:fs'
    import { acquireLock } from ${JSON.stringify(mod)}
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
    for (let i = 0; i < 15; i++) {
      const got = await acquireLock(${JSON.stringify(lockPath)}, { sleep, pollMs: 1 })
      if (!got.release) { fs.appendFileSync(${JSON.stringify(logPath)}, 'stale ' + process.pid + '\\n'); process.exit(3) }
      fs.appendFileSync(${JSON.stringify(logPath)}, 'in ' + process.pid + '\\n')
      await sleep(2)
      fs.appendFileSync(${JSON.stringify(logPath)}, 'out ' + process.pid + '\\n')
      got.release()
    }`
  const codes = await Promise.all(Array.from({ length: 8 }, () => new Promise((resolve) => {
    const c = spawn(process.execPath, ['--input-type=module', '-e', worker])
    let err = ''
    c.stderr.on('data', (d) => { err += d })
    c.on('close', (code) => resolve(code === 0 ? 0 : `${code} ${err}`))
  })))
  assert.deepEqual(codes, Array(8).fill(0))
  const lines = fs.readFileSync(logPath, 'utf8').trim().split('\n')
  assert.equal(lines.length, 8 * 15 * 2)
  for (let i = 0; i < lines.length; i += 2) {
    const [a, pa] = lines[i].split(' ')
    const [b, pb] = lines[i + 1].split(' ')
    assert.deepEqual([a, b, pa], ['in', 'out', pb], `overlap at line ${i}`)
  }
})
