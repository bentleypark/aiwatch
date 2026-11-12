#!/usr/bin/env node
// #1974 — the Step-0 audit of docs/reference/adding-a-service.md as a measurement and a check, so that
// it is done before a new service is designed rather than remembered. `measure` prints the audit block
// with every number labelled by its scope; `check` refuses a block with an unmeasured row. Neither says a
// number is the right one for the decision: the product boundary and the category gap stay with a person.
//
// Usage: node scripts/service-step0.mjs measure --source cloudflare-v3|atlassian --ids a,b \
//          [--base <url>] [--probe <url,url>] [--control <url,url>] [--max-pages N]
//        node scripts/service-step0.mjs check <file|-> [--previous <file>]

import { readFileSync, realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export const ROWS = ['uptime', 'history', 'probe', 'gap', 'boundary']
export const HEADING = '## Step-0 audit'
const PROBE_RESULTS = ['representative', 'gateway-level', 'catch-all', 'unreachable', 'none']
const LATENCY_RATIO = [0.5, 2]
const ATLASSIAN_CAP = 50
const GARBAGE_SEGMENT = 'zzz-step0-nothing-here'
const FIELD_RE = /^([a-z][a-z-]*)=(.*)$/

// ---- the typed block -------------------------------------------------------------------------------

/** A row is `- name: result | key=value | …`; a leading `key=value` part means the row has no free result. */
function parseRow(rest) {
  const parts = rest.trim().split(/\s*\|\s*/)
  const fields = {}
  let result = ''
  for (const part of parts) {
    const m = FIELD_RE.exec(part)
    if (m) fields[m[1]] = m[2].trim()
    else if (!result) result = part
  }
  return { result, fields }
}

export function parseStep0(text) {
  const start = text.search(/^##\s+Step-0 audit\s*$/m)
  if (start < 0) return { found: false }
  const after = text.slice(start).split('\n').slice(1)
  const next = after.findIndex((l) => /^##\s/.test(l))
  const lines = next < 0 ? after : after.slice(0, next)
  const out = { found: true, rows: {}, verdict: null, thinAck: null, verdictChange: [], source: null, generated: null }
  for (const line of lines) {
    const row = /^-\s*(uptime|history|probe|gap|boundary):\s*(.*)$/.exec(line)
    if (row) { out.rows[row[1]] = parseRow(row[2]); continue }
    const kv = /^(verdict|thin-card-ack|verdict-change|source|generated):\s*(.*)$/.exec(line)
    if (!kv) continue
    const v = kv[2].trim()
    if (kv[1] === 'verdict') out.verdict = v
    else if (kv[1] === 'thin-card-ack') out.thinAck = v
    else if (kv[1] === 'verdict-change') out.verdictChange = v.split(',').map((s) => s.trim()).filter(Boolean)
    else out[kv[1] === 'source' ? 'source' : 'generated'] = v
  }
  return out
}

// What counts as a row moving: the decision-relevant fields only. Latency, window and page-wide count
// differ on every re-measurement, so they are not part of it.
const SIGNATURE = { uptime: ['scope'], history: ['n', 'scope', 'exhausted'], probe: ['control'], gap: [], boundary: [] }
const signature = (name, row) => (row ? `${row.result}|${SIGNATURE[name].map((k) => `${k}=${row.fields[k] ?? ''}`).join('|')}` : '')

const MESSAGES = {
  'no-block': `no "${HEADING}" block`,
  'row-missing': 'the row is missing',
  'row-unmeasured': 'the row is unmeasured — measure it before designing',
  'row-empty': 'the row has no content: write what was found, not the word unmeasured',
  'uptime-evidence': 'uptime needs evidence=… (the fields it was read from)',
  'uptime-scope': 'uptime present needs scope=card(…): a field or placeholder elsewhere on the page does not make the card a publisher',
  'block-source': 'the block needs a source: line',
  'block-generated': 'the block needs a generated: line',
  'uptime-result': 'uptime must be none or present',
  'history-n': 'history needs n=<count>',
  'history-scope': 'history needs scope=<what the count covers>',
  'history-window': 'history needs window=<from>..<to>',
  'history-exhausted': 'history needs exhausted=yes|no|unknown',
  'probe-unresolved': 'probe is still "distinct": a person must restate it as representative or gateway-level, with evidence',
  'probe-result': `probe must be one of ${PROBE_RESULTS.join(', ')}`,
  'probe-control': 'probe needs control=yes (a garbage path and a sibling path were tried)',
  'probe-evidence': 'probe needs evidence=… for this result',
  'verdict-missing': 'verdict must be add or hold',
  'thin-card-ack': 'no uptime and no representative probe: adding it needs a thin-card-ack: line giving the reason',
  'previous-unreadable': 'the --previous file has no Step-0 block with a verdict: a verdict change cannot be compared against it',
  'verdict-change-missing': 'the verdict changed: list the rows that moved in a verdict-change: line',
  'verdict-change-unlisted': 'the row moved but is not listed in verdict-change:',
  'verdict-change-unmoved': 'the row is listed in verdict-change: but did not move',
}

export function checkStep0(text, { previous } = {}) {
  const errors = []
  const err = (code, row) => errors.push({ code, ...(row ? { row } : {}), message: `${row ? `${row}: ` : ''}${MESSAGES[code]}` })
  const p = parseStep0(text)
  if (!p.found) { err('no-block'); return { ok: false, errors } }
  if (!p.source) err('block-source')
  if (!p.generated) err('block-generated')

  for (const name of ROWS) {
    const r = p.rows[name]
    if (!r) { err('row-missing', name); continue }
    if (r.fields.status !== 'measured') { err('row-unmeasured', name); continue }
    if ((name === 'gap' || name === 'boundary') && (!r.result || r.result.toLowerCase() === 'unmeasured')) err('row-empty', name)
    if (name === 'uptime' && !['none', 'present'].includes(r.result)) err('uptime-result', 'uptime')
    if (name === 'uptime' && !r.fields.evidence) err('uptime-evidence', 'uptime')
    if (name === 'uptime' && r.result === 'present' && !/^card/.test(r.fields.scope ?? '')) err('uptime-scope', 'uptime')
    if (name === 'history') {
      if (!/^\d+$/.test(r.fields.n ?? '')) err('history-n', 'history')
      if (!r.fields.scope) err('history-scope', 'history')
      if (!r.fields.window) err('history-window', 'history')
      if (!['yes', 'no', 'unknown'].includes(r.fields.exhausted)) err('history-exhausted', 'history')
    }
    if (name === 'probe') {
      if (r.result === 'distinct') err('probe-unresolved', 'probe')
      else if (!PROBE_RESULTS.includes(r.result)) err('probe-result', 'probe')
      else {
        if (r.result !== 'none' && r.fields.control !== 'yes') err('probe-control', 'probe')
        if (['representative', 'none'].includes(r.result) && !r.fields.evidence) err('probe-evidence', 'probe')
      }
    }
  }

  if (!['add', 'hold'].includes(p.verdict)) err('verdict-missing')
  const thin = p.rows.uptime?.result === 'none' && p.rows.probe?.result !== 'representative'
  if (p.verdict === 'add' && thin && !p.thinAck) err('thin-card-ack')

  if (previous !== undefined) {
    const prev = parseStep0(previous)
    if (!['add', 'hold'].includes(prev.verdict)) err('previous-unreadable')
    else if (['add', 'hold'].includes(p.verdict) && prev.verdict !== p.verdict) {
      const moved = ROWS.filter((name) => signature(name, prev.rows[name]) !== signature(name, p.rows[name]))
      if (p.verdictChange.length === 0) err('verdict-change-missing')
      else {
        for (const name of moved) if (!p.verdictChange.includes(name)) err('verdict-change-unlisted', name)
        for (const name of p.verdictChange) if (!moved.includes(name)) err('verdict-change-unmoved', name)
      }
    }
  }
  return { ok: errors.length === 0, errors }
}

const clean = (v) => String(v).replace(/\|/g, '/').replace(/\n/g, ' ')

export function renderStep0({ generated, source, uptime, history, probe }) {
  const lines = [HEADING, `generated: ${generated} by scripts/service-step0.mjs`, `source: ${source}`]
  lines.push(uptime
    ? `- uptime: ${uptime.result} | scope=${clean(uptime.scope)} | evidence=${clean(uptime.evidence)} | status=measured`
    : '- uptime: unmeasured | status=unmeasured')
  if (history) {
    const impacts = Object.entries(history.byImpact).sort(([a, x], [b, y]) => y - x || a.localeCompare(b)).map(([k, v]) => `${k}:${v}`).join(',')
    lines.push(`- history: n=${history.n} | scope=${clean(history.scope)} | window=${history.windowFrom}..${history.windowTo} | exhausted=${history.exhausted} | by-impact=${impacts || 'none'} | page-wide=${history.pageWide} | status=measured`)
  } else lines.push('- history: unmeasured | status=unmeasured')
  lines.push(probe
    ? `- probe: ${probe.result} | control=${probe.control ? 'yes' : 'no'} | evidence=${clean(probe.evidence)} | status=measured`
    : '- probe: unmeasured | status=unmeasured')
  lines.push('- gap: unmeasured | status=unmeasured', '- boundary: unmeasured | status=unmeasured')
  return `${lines.join('\n')}\n`
}

// ---- pure measurements -----------------------------------------------------------------------------

const day = (iso) => (typeof iso === 'string' ? iso.slice(0, 10) : null)

/** rows: `{ id, type, impact, startsAt, componentIds }`. The count covers `ids` only; `pageWide` is every incident row. */
export function summarizeHistory(rows, ids) {
  const wanted = new Set(ids)
  const incidents = rows.filter((r) => (r.type ?? 'incident') === 'incident')
  const mine = incidents.filter((r) => (r.componentIds ?? []).some((id) => wanted.has(id)))
  const byImpact = {}
  for (const r of mine) { const k = r.impact ?? 'unknown'; byImpact[k] = (byImpact[k] ?? 0) + 1 }
  const days = rows.map((r) => day(r.startsAt)).filter(Boolean).sort()
  return { n: mine.length, byImpact, pageWide: incidents.length, windowFrom: days[0] ?? 'unknown', windowTo: days[days.length - 1] ?? 'unknown' }
}

/** Looks at field NAMES only: prose that mentions availability is not a published uptime. */
export function detectUptime(keys) {
  const hit = keys.find((k) => /uptime|percent/i.test(k))
  return hit
    ? { result: 'present', evidence: `field ${hit}` }
    : { result: 'none', evidence: `looked at fields ${keys.join(', ')}` }
}

const modal = (xs) => {
  const counts = new Map()
  for (const x of xs) counts.set(x, (counts.get(x) ?? 0) + 1)
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0]
}
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : 0 }

/**
 * A candidate that answers like a control is measuring that control. Only the negative verdicts are
 * mechanical: `distinct` means "no control looks like it", which a person must still turn into
 * representative or gateway-level.
 */
export function compareProbe(candidate, controls) {
  const status = modal(candidate.statuses)
  const ms = median(candidate.timesMs)
  if (!status || status >= 500) return { verdict: 'unreachable', status, medianMs: ms, matched: null }
  const same = (c) => {
    if (modal(c.statuses) !== status) return false
    const ratio = ms / (median(c.timesMs) || 1)
    return ratio >= LATENCY_RATIO[0] && ratio <= LATENCY_RATIO[1]
  }
  const garbage = controls.find((c) => c.kind === 'garbage' && same(c))
  if (garbage) return { verdict: 'catch-all', status, medianMs: ms, matched: garbage.label }
  const sibling = controls.find((c) => c.kind === 'sibling' && same(c))
  if (sibling) return { verdict: 'gateway-level', status, medianMs: ms, matched: sibling.label }
  return { verdict: 'distinct', status, medianMs: ms, matched: null }
}

/** Candidates that agree on a negative verdict keep it; any disagreement or `distinct` is left to a person. */
export function summarizeProbe(verdicts) {
  const first = verdicts[0]?.verdict
  const negative = ['gateway-level', 'catch-all', 'unreachable']
  return verdicts.length > 0 && negative.includes(first) && verdicts.every((v) => v.verdict === first) ? first : 'distinct'
}

// ---- network measurements (fetchImpl is injected) --------------------------------------------------

const getJson = async (fetchImpl, url) => {
  try {
    const res = await fetchImpl(url)
    return res.ok ? await res.json() : null
  } catch { return null }
}

const normalizeCloudflare = (r) => ({
  id: r.id,
  type: r.type,
  impact: r.impact,
  startsAt: r.starts_at ?? r.created_at,
  componentIds: (r.components ?? []).map((c) => c.id),
})

export async function measureCloudflareV3({ fetchImpl, ids, maxPages = 60, base = 'https://www.cloudflarestatus.com' }) {
  const empty = { uptime: null, history: null, rows: [], exhausted: 'unknown' }
  const summary = await getJson(fetchImpl, `${base}/api/v3/summary`)
  const components = summary?.result?.components
  if (!Array.isArray(components)) return empty
  const mine = components.filter((c) => ids.includes(c.id))
  if (mine.length !== new Set(ids).size) return empty

  const raw = []
  let cursor = null
  let exhausted = 'no'
  for (let page = 0; page < maxPages; page++) {
    const url = `${base}/api/v3/history${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`
    const body = await getJson(fetchImpl, url)
    if (!body || !Array.isArray(body.result)) { if (page === 0) return empty; break }
    raw.push(...body.result)
    cursor = body.result_info?.next_cursor ?? null
    if (!cursor) { exhausted = 'yes'; break }
  }
  const keys = [...new Set(mine.flatMap((c) => Object.keys(c)))]
  const rows = raw.map(normalizeCloudflare)
  return {
    uptime: { ...detectUptime(keys), scope: `card(${ids.length} ids)` },
    history: { ...summarizeHistory(rows, ids), exhausted, scope: `card(${ids.length} ids)` },
    rows,
    exhausted,
  }
}

export async function measureAtlassian({ fetchImpl, baseUrl, ids }) {
  const base = baseUrl.replace(/\/$/, '')
  const unmeasured = { uptime: null, history: null, rows: [], exhausted: 'unknown', unresolved: [] }
  // The page's own component list decides what a card id is. A group id is a container no incident names,
  // so a lookup that accepted one would print a measured zero.
  const listed = await getJson(fetchImpl, `${base}/api/v2/components.json`)
  if (!Array.isArray(listed?.components)) {
    return { ...unmeasured, unresolved: ids.map((id) => ({ id, reason: 'components.json did not answer' })) }
  }
  const byId = new Map(listed.components.map((c) => [c.id, c]))
  const unresolved = ids.flatMap((id) => {
    const c = byId.get(id)
    if (!c) return [{ id, reason: 'not a component on this page' }]
    if (c.group) return [{ id, reason: 'a group, not a component: incidents never name it' }]
    return []
  })
  if (unresolved.length) return { ...unmeasured, unresolved }

  const scope = `card(${ids.length} ids)`
  let html = ''
  try {
    const res = await fetchImpl(base)
    if (res.ok !== false) html = await res.text()
  } catch { /* an unreadable page leaves uptime unmeasured */ }
  const keyed = [...html.matchAll(/data-uptime-lazy="([^"]+)"/g)].map((m) => m[1])
  const hit = keyed.find((code) => ids.includes(code))
  const uptime = !html
    ? null
    : hit
      ? { result: 'present', evidence: `placeholder keyed ${hit}`, scope }
      : { result: 'none', evidence: `${keyed.length} placeholders on the page, none keyed by a card id (a placeholder may be keyed by a code other than the component id)`, scope }

  const body = await getJson(fetchImpl, `${base}/api/v2/incidents.json`)
  if (!body || !Array.isArray(body.incidents)) return { ...unmeasured, uptime }
  const rows = body.incidents.map((i) => ({
    id: i.id, type: 'incident', impact: i.impact, startsAt: i.created_at, componentIds: (i.components ?? []).map((c) => c.id),
  }))
  const exhausted = rows.length >= ATLASSIAN_CAP ? 'unknown' : 'yes'
  return { uptime, history: { ...summarizeHistory(rows, ids), exhausted, scope }, rows, exhausted, unresolved: [] }
}

export async function runProbe({ fetchImpl, urls, samples = 5, timeoutMs = 10000 }) {
  const out = []
  for (const url of urls) {
    const statuses = []
    const timesMs = []
    for (let i = 0; i < samples; i++) {
      const started = performance.now()
      const ctl = new AbortController()
      const timer = setTimeout(() => ctl.abort(), timeoutMs)
      try {
        const res = await fetchImpl(url, { method: 'GET', signal: ctl.signal, redirect: 'manual' })
        statuses.push(res.status)
      } catch { statuses.push(0) } finally { clearTimeout(timer) }
      timesMs.push(Math.round(performance.now() - started))
    }
    out.push({ url, statuses, timesMs })
  }
  return out
}

// ---- command line ----------------------------------------------------------------------------------

const UA = 'Mozilla/5.0 (compatible; aiwatch-step0)'
const defaultFetch = (url, init = {}) => fetch(url, { ...init, headers: { 'user-agent': UA, ...(init.headers ?? {}) } })

const garbageOf = (url) => {
  const u = new URL(url)
  const dir = u.pathname.replace(/\/[^/]*$/, '')
  return `${u.origin}${dir}/${GARBAGE_SEGMENT}`
}

const label = (url) => { const u = new URL(url); return u.pathname || u.origin }

async function probeRow({ fetchImpl, probeUrls, controlUrls }) {
  const candidates = await runProbe({ fetchImpl, urls: probeUrls })
  const controlKinds = [
    ...controlUrls.map((url) => ({ url, kind: 'sibling' })),
    { url: garbageOf(probeUrls[0]), kind: 'garbage' },
  ]
  const measured = await runProbe({ fetchImpl, urls: controlKinds.map((c) => c.url) })
  const controls = measured.map((m, i) => ({ kind: controlKinds[i].kind, label: label(m.url), statuses: m.statuses, timesMs: m.timesMs }))
  const verdicts = candidates.map((c) => ({ url: c.url, ...compareProbe(c, controls) }))
  const result = summarizeProbe(verdicts)
  const evidence = verdicts.map((v) => `${label(v.url)} ${v.status}/${v.medianMs}ms ${v.verdict}${v.matched ? ` (like ${v.matched})` : ''}`).join('; ')
  return { result, control: true, evidence: `${evidence}; controls ${controls.map((c) => `${c.label} ${modal(c.statuses)}/${median(c.timesMs)}ms`).join(', ')}` }
}

async function measure(argv) {
  const arg = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined }
  const source = arg('--source')
  const ids = (arg('--ids') ?? '').split(',').map((s) => s.trim()).filter(Boolean)
  if (!source || ids.length === 0) { process.stderr.write('measure needs --source and --ids\n'); return 2 }
  const maxPages = arg('--max-pages') === undefined ? 60 : Number(arg('--max-pages'))
  if (!Number.isInteger(maxPages) || maxPages < 1) { process.stderr.write('--max-pages must be a positive integer\n'); return 2 }
  const probeUrls = (arg('--probe') ?? '').split(',').filter(Boolean)
  const controlUrls = (arg('--control') ?? '').split(',').filter(Boolean)
  if (probeUrls.length && controlUrls.length === 0) { process.stderr.write('--probe needs at least one --control (an unrelated sibling path)\n'); return 2 }

  let m = { uptime: null, history: null }
  if (source === 'cloudflare-v3') m = await measureCloudflareV3({ fetchImpl: defaultFetch, ids, maxPages, ...(arg('--base') ? { base: arg('--base') } : {}) })
  else if (source === 'atlassian') {
    if (!arg('--base')) { process.stderr.write('--source atlassian needs --base <status page url>\n'); return 2 }
    m = await measureAtlassian({ fetchImpl: defaultFetch, baseUrl: arg('--base'), ids })
    for (const u of m.unresolved ?? []) process.stderr.write(`unresolved id ${u.id}: ${u.reason}\n`)
  } else process.stderr.write(`source "${source}" is not measured by this script: its rows are printed unmeasured\n`)

  const probe = probeUrls.length ? await probeRow({ fetchImpl: defaultFetch, probeUrls, controlUrls }) : null
  process.stdout.write(renderStep0({ generated: new Date().toISOString().slice(0, 10), source, uptime: m.uptime, history: m.history, probe }))
  return 0
}

function check(argv) {
  const file = argv[0]
  if (!file) { process.stderr.write('check needs a file or -\n'); return 2 }
  const prevAt = argv.indexOf('--previous')
  let text
  let previous
  try {
    text = readFileSync(file === '-' ? 0 : file, 'utf8')
    if (prevAt >= 0) previous = readFileSync(argv[prevAt + 1], 'utf8')
  } catch (e) { process.stderr.write(`cannot read: ${e.message}\n`); return 2 }
  const r = checkStep0(text, previous === undefined ? {} : { previous })
  if (r.ok) { process.stdout.write('ok\n'); return 0 }
  for (const e of r.errors) process.stdout.write(`${e.code}${e.row ? `:${e.row}` : ''} — ${e.message}\n`)
  return 1
}

async function main(argv) {
  const [cmd, ...rest] = argv
  if (cmd === 'measure') return measure(rest)
  if (cmd === 'check') return check(rest)
  process.stderr.write('usage: service-step0.mjs measure|check …\n')
  return 2
}

const isMain = (() => {
  try { return fileURLToPath(import.meta.url) === realpathSync(process.argv[1] ?? '') } catch { return false }
})()
if (isMain) process.exit(await main(process.argv.slice(2)))
