import { test } from 'node:test'
import assert from 'node:assert/strict'
import { withRetry } from './scrape-deepseek-feed.mjs'

const noSleep = () => Promise.resolve() // skip real backoff delay in tests

test('withRetry — returns the result on first success (no retry)', async () => {
  let calls = 0
  const r = await withRetry(async () => { calls++; return 'ok' }, { sleep: noSleep })
  assert.equal(r, 'ok')
  assert.equal(calls, 1)
})

test('withRetry — retries a transient failure then succeeds', async () => {
  let calls = 0
  const r = await withRetry(async () => {
    calls++
    if (calls < 3) throw new Error(`flake ${calls}`)
    return 'recovered'
  }, { attempts: 3, sleep: noSleep })
  assert.equal(r, 'recovered')
  assert.equal(calls, 3)
})

test('withRetry — throws the LAST error after exhausting attempts', async () => {
  let calls = 0
  await assert.rejects(
    withRetry(async () => { calls++; throw new Error(`fail ${calls}`) }, { attempts: 3, sleep: noSleep }),
    /fail 3/,
  )
  assert.equal(calls, 3)
})

test('withRetry — backoff is linear (delayMs * attempt), no sleep after the final attempt', async () => {
  const waited = []
  await assert.rejects(
    withRetry(async () => { throw new Error('x') }, {
      attempts: 3,
      delayMs: 1000,
      sleep: (ms) => { waited.push(ms); return Promise.resolve() },
    }),
  )
  assert.deepEqual(waited, [1000, 2000]) // 2 sleeps between 3 attempts; none after the last
})

test('withRetry — attempts:1 runs once and never sleeps before throwing', async () => {
  let calls = 0
  const waited = []
  await assert.rejects(
    withRetry(async () => { calls++; throw new Error('once') }, { attempts: 1, sleep: (ms) => { waited.push(ms); return Promise.resolve() } }),
    /once/,
  )
  assert.equal(calls, 1)
  assert.deepEqual(waited, []) // no sleep with a single attempt
})

test('withRetry — default sleep (real timer) is wired and resolves', async () => {
  let calls = 0
  const r = await withRetry(async () => { calls++; if (calls < 2) throw new Error('flake'); return 'ok' }, { attempts: 2, delayMs: 1 })
  assert.equal(r, 'ok') // exercised the real setTimeout-based default sleep (delayMs:1)
})

test('importing the module runs no side effects (main is guarded, no env exit)', async () => {
  // If this import didn't throw / exit, the guard + in-main env check both hold.
  const mod = await import('./scrape-deepseek-feed.mjs')
  assert.equal(typeof mod.withRetry, 'function')
})
