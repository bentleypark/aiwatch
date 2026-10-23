// Shared by the operator CLIs for the whole-list admin endpoints (suppress-incident.mjs,
// duration-override.mjs). Both endpoints read-modify-write one KV value, and KV is eventually
// consistent, so a 200 does not prove the entry survived a concurrent write (#1740).

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const WORKER_URL = process.env.WORKER_URL ?? 'https://aiwatch-worker.p2c2kbf.workers.dev'
export const CONFIRM_WAIT_MS = Number(process.env.OPERATOR_CONFIRM_WAIT_MS || 130_000)
const CONFIRM_ATTEMPTS = 3

export async function adminRequest(path, adminKey, method, body) {
  const res = await fetch(`${WORKER_URL}${path}`, {
    method,
    headers: {
      'X-Admin-Key': adminKey,
      'Content-Type': 'application/json',
      // Browser-like UA — workers.dev routes reject the default fetch UA with Cloudflare error 1010.
      'User-Agent': 'Mozilla/5.0 AIWatch-AdminCLI',
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
  const text = await res.text()
  let json
  try { json = JSON.parse(text) } catch { /* e.g. Cloudflare error 1010 HTML page */ }
  return { status: res.status, ok: res.ok, json, text }
}

// Re-sends the same mutation until the endpoint answers `changed: false`, i.e. the list it read
// already holds the requested state.
export async function confirmMutation({ send, sleep, waitMs = CONFIRM_WAIT_MS, attempts = CONFIRM_ATTEMPTS, log = () => {} }) {
  let resends = 0
  for (let i = 1; i <= attempts; i++) {
    await sleep(waitMs)
    const res = await send()
    if (!res.ok) return { confirmed: false, resends, last: res }
    if (res.json?.changed === false) {
      log(`check ${i}/${attempts}: confirmed`)
      return { confirmed: true, resends, last: res }
    }
    resends++
    log(`check ${i}/${attempts}: the list did not hold this change; sent again`)
  }
  return { confirmed: false, resends, last: null }
}

export function printResponse(res, started, hint400) {
  console.log(`HTTP ${res.status}  (${Date.now() - started}ms)`)
  console.log(res.json ? JSON.stringify(res.json, null, 2) : res.text)
  if (res.status === 400 && hint400) console.error(`\nHint: 400 — ${hint400}`)
  else if (res.status === 401) console.error('\nHint: 401 means the secret is missing or wrong. Re-check ADMIN_API_KEY.')
  else if (res.status === 502) console.error('\nHint: 502 — KV read/write failed. Check Worker logs.')
}

// Parse --flag value pairs (strict, like admin-analyze.mjs).
export function parseFlagPairs(rest) {
  if (rest.length % 2 !== 0) return { error: `Flag args must come in --flag value pairs (got ${rest.length} tokens): ${rest.join(' ')}` }
  const flags = {}
  for (let i = 0; i < rest.length; i += 2) {
    const key = rest[i]?.replace(/^--/, '')
    if (!key) return { error: `Flag parse error near: ${rest.slice(i).join(' ')}` }
    flags[key] = rest[i + 1]
  }
  return { flags }
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return err.code === 'EPERM'
  }
}

// One run per endpoint at a time on this machine: runs serialised this way each confirm before the
// next one reads the list. The lock appears with its pid already in it (link of a complete file), so
// a reader never sees it empty. A lock whose process is gone is reported, never taken over.
export async function acquireLock(lockPath, { sleep, log = () => {}, pollMs = 1_000 }) {
  const mine = String(process.pid)
  const tmp = `${lockPath}.${mine}`
  fs.writeFileSync(tmp, mine)
  let announced = false
  try {
    for (;;) {
      try {
        fs.linkSync(tmp, lockPath)
        return {
          release: () => {
            try {
              if (fs.readFileSync(lockPath, 'utf8') === mine) fs.rmSync(lockPath)
            } catch { /* already gone */ }
          },
        }
      } catch (err) {
        if (err.code !== 'EEXIST') throw err
      }
      let holder
      try {
        holder = fs.readFileSync(lockPath, 'utf8')
      } catch (err) {
        if (err.code === 'ENOENT') continue
        throw err
      }
      if (!pidAlive(Number(holder))) return { staleHolder: holder }
      if (!announced) log(`Waiting for another run of this command to finish (pid ${holder}, lock ${lockPath})...`)
      announced = true
      await sleep(pollMs)
    }
  } finally {
    fs.rmSync(tmp, { force: true })
  }
}

// Runs the POST, then the confirm loop unless `--confirm off`. Returns the process exit code.
export async function runMutation(apiPath, adminKey, body, confirm, hint400) {
  const lockPath = path.join(os.tmpdir(), `aiwatch-admin${apiPath.replace(/\//g, '-')}.lock`)
  const got = await acquireLock(lockPath, {
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    log: (line) => console.log(line),
  })
  if (!got.release) {
    console.error(`${lockPath} names pid ${got.staleHolder}, which is not running. If no other run of this command is in progress, delete that file and run the command again.`)
    return 2
  }
  const onSignal = (sig) => {
    got.release()
    process.exit(sig === 'SIGINT' ? 130 : 143)
  }
  process.once('SIGINT', onSignal)
  process.once('SIGTERM', onSignal)
  try {
    return await runLockedMutation(apiPath, adminKey, body, confirm, hint400)
  } finally {
    process.off('SIGINT', onSignal)
    process.off('SIGTERM', onSignal)
    got.release()
  }
}

async function runLockedMutation(path, adminKey, body, confirm, hint400) {
  const started = Date.now()
  let res
  try {
    res = await adminRequest(path, adminKey, 'POST', body)
  } catch (err) {
    console.error(`Network error: ${err instanceof Error ? err.message : err}`)
    return 1
  }
  printResponse(res, started, hint400)
  if (!res.ok) return 1
  if (confirm === 'off') return 0

  console.log(`\nConfirming: re-sending the same request every ${CONFIRM_WAIT_MS / 1000}s until the list already holds it (up to ${CONFIRM_ATTEMPTS} checks)...`)
  let result
  try {
    result = await confirmMutation({
      send: () => adminRequest(path, adminKey, 'POST', body),
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      log: (line) => console.log(line),
    })
  } catch (err) {
    console.error(`\nNOT CONFIRMED: a confirm request failed (${err instanceof Error ? err.message : err}). Run \`list\` and re-run the same command.`)
    return 1
  }
  if (result.confirmed) return 0
  if (result.last) {
    printResponse(result.last, started, hint400)
    console.error(`\nNOT CONFIRMED: a confirm request failed (HTTP ${result.last.status}). Run \`list\` and re-run the same command.`)
    return 1
  }
  console.error(`\nNOT CONFIRMED: the list still did not hold this change after ${CONFIRM_ATTEMPTS} checks. Run \`list\` and re-run the same command.`)
  return 1
}
