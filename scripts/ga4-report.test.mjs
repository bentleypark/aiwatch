import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseArgs, formatTable } from './ga4-report.mjs'

// #998 — only the pure helpers are unit-tested; the network/token-exchange path needs the real
// service-account key and live credentials, so it's exercised manually (docs/reference/ga4-cli-access.md).

test('parseArgs: defaults cover the common "how much local/preview traffic" case', () => {
  const args = parseArgs([])
  assert.deepEqual(args.dimensions, ['hostName'])
  assert.deepEqual(args.metrics, ['sessions'])
  assert.equal(args.startDate, '30daysAgo')
  assert.equal(args.endDate, 'today')
  assert.equal(args.propertyId, '529375750')
  assert.equal(args.json, false)
})

test('parseArgs: --dimensions and --metrics split on comma', () => {
  const args = parseArgs(['--dimensions', 'hostName,testDataFilterName', '--metrics', 'sessions,screenPageViews'])
  assert.deepEqual(args.dimensions, ['hostName', 'testDataFilterName'])
  assert.deepEqual(args.metrics, ['sessions', 'screenPageViews'])
})

test('parseArgs: --start/--end/--limit/--key/--property/--json all override their defaults', () => {
  const args = parseArgs(['--start', '2026-07-14', '--end', 'today', '--limit', '10', '--key', '/tmp/k.json', '--property', '123', '--json'])
  assert.equal(args.startDate, '2026-07-14')
  assert.equal(args.endDate, 'today')
  assert.equal(args.limit, 10)
  assert.equal(args.keyPath, '/tmp/k.json')
  assert.equal(args.propertyId, '123')
  assert.equal(args.json, true)
})

// round 1 review — an unrecognized flag used to be silently dropped, running the DEFAULTS instead of
// what was actually asked for (e.g. a typo'd --metric instead of --metrics), which reads as a valid
// answer to a different question rather than an error.
test('parseArgs: an unknown flag throws rather than silently falling back to defaults', () => {
  assert.throws(() => parseArgs(['--metric', 'sessions']), /unknown flag: --metric/)
  assert.throws(() => parseArgs(['--dimensions', 'hostName', '--limitt', '10']), /unknown flag: --limitt/)
})

test('parseArgs: a flag missing its value throws a clear error, not a raw TypeError', () => {
  assert.throws(() => parseArgs(['--key', '/tmp/k.json', '--dimensions']), /--dimensions needs a value/)
})

test('parseArgs: --limit rejects non-positive-integer values', () => {
  assert.throws(() => parseArgs(['--limit', 'abc']), /--limit must be a positive integer/)
  assert.throws(() => parseArgs(['--limit', '0']), /--limit must be a positive integer/)
  assert.throws(() => parseArgs(['--limit', '-5']), /--limit must be a positive integer/)
})

test('formatTable: header + rows, tab-separated, dimensions before metrics', () => {
  const report = {
    dimensionHeaders: [{ name: 'hostName' }],
    metricHeaders: [{ name: 'sessions' }],
    rowCount: 2,
    rows: [
      { dimensionValues: [{ value: 'example.test' }], metricValues: [{ value: '999' }] },
      { dimensionValues: [{ value: 'localhost' }], metricValues: [{ value: '111' }] },
    ],
  }
  const out = formatTable(report)
  assert.equal(out, 'hostName\tsessions\nexample.test\t999\nlocalhost\t111')
})

test('formatTable: zero rows prints a visible "(no rows)" line instead of an empty table', () => {
  const report = { dimensionHeaders: [{ name: 'hostName' }], metricHeaders: [{ name: 'sessions' }], rowCount: 0, rows: [] }
  assert.equal(formatTable(report), 'hostName\tsessions\n(no rows)')
})

// round 1 review — a truncated report (rowCount > rows.length, from --limit) is otherwise VISUALLY
// IDENTICAL to a complete one, which is exactly backwards for a tool whose output gets written into
// docs as a measurement.
test('formatTable: a truncated report (rowCount > rows.length) prints a visible truncation line', () => {
  const report = {
    dimensionHeaders: [{ name: 'hostName' }],
    metricHeaders: [{ name: 'sessions' }],
    rowCount: 5,
    rows: [{ dimensionValues: [{ value: 'example.test' }], metricValues: [{ value: '999' }] }],
  }
  const out = formatTable(report)
  assert.ok(out.includes('showing 1 of 5 rows'), out)
})

test('formatTable: a COMPLETE report (rowCount === rows.length) prints no truncation line', () => {
  const report = {
    dimensionHeaders: [{ name: 'hostName' }],
    metricHeaders: [{ name: 'sessions' }],
    rowCount: 1,
    rows: [{ dimensionValues: [{ value: 'example.test' }], metricValues: [{ value: '999' }] }],
  }
  const out = formatTable(report)
  assert.ok(!out.includes('showing'), out)
})
