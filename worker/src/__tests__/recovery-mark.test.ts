import { describe, it, expect, vi } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { markIncidentResolved, recoveryMarkerKey, RESOLVED_TTL_S } from '../recovery-mark'
import { analysisKey, firstEstimateKey, parseAnalysis } from '../ai-analysis'
import type { KVLike } from '../utils'

function mockKV(store: Record<string, string> = {}, ttls: Record<string, number | undefined> = {}) {
  const kv: KVLike = {
    get: vi.fn(async (k: string) => store[k] ?? null),
    put: vi.fn(async (k: string, v: string, o?: { expirationTtl?: number }) => {
      store[k] = v
      ttls[k] = o?.expirationTtl
    }),
    delete: vi.fn(async (k: string) => { delete store[k] }),
  }
  return { kv, store, ttls }
}

const NOW = '2026-07-13T08:32:00.000Z'
const INC = {
  id: 'pc-1',
  title: '[Serverless][AWS][us-east-1] Increase in freshness lag for some namespaces',
  startedAt: '2026-07-13T03:37:00.000Z',
  resolvedAt: NOW, // 4h 55m
}

/** The analysis as KV holds it mid-incident: re-analysis has ratcheted the estimate up to 15h, but the
 *  first (hindsight-free) estimate of 4h is pinned. No `resolvedAt` yet — that is what this writes. */
const analysisValue = (over: Record<string, unknown> = {}) => JSON.stringify({
  summary: 'Freshness lag in some serverless namespaces.',
  estimatedRecovery: '8–15h',
  estimatedRecoveryHours: 15,
  firstEstimatedRecoveryHours: 4,
  affectedScope: ['Pinecone Serverless'],
  needsFallback: false,
  analyzedAt: '2026-07-13T03:47:00.000Z',
  incidentId: 'pc-1',
  ...over,
})

describe('markIncidentResolved (#1003 — the read surfaces every resolution path must light up)', () => {
  it('writes the recovery marker that the "Recently Resolved" banner is gated on', async () => {
    const { kv, store, ttls } = mockKV()

    await markIncidentResolved(kv, 'pinecone', INC, NOW)

    const marker = JSON.parse(store[recoveryMarkerKey('pinecone', 'pc-1')])
    expect(marker).toMatchObject({ resolvedAt: NOW, incidentTitle: INC.title, duration: '4h 55m' })
    expect(ttls[recoveryMarkerKey('pinecone', 'pc-1')]).toBe(RESOLVED_TTL_S)
  })

  it('writes the marker even with NO analysis (the outcome is worth showing without a prediction)', async () => {
    const { kv, store } = mockKV()

    const analysis = await markIncidentResolved(kv, 'pinecone', INC, NOW)

    expect(analysis).toBeNull()
    expect(store[recoveryMarkerKey('pinecone', 'pc-1')]).toBeDefined()
  })

  it('stamps resolvedAt on the analysis — what the modal + is-down verdict are gated on', async () => {
    const { kv, store, ttls } = mockKV({ [analysisKey('pinecone', 'pc-1')]: analysisValue() })

    const analysis = await markIncidentResolved(kv, 'pinecone', INC, NOW)

    expect(analysis?.resolvedAt).toBe(NOW)
    expect(parseAnalysis(store[analysisKey('pinecone', 'pc-1')])?.resolvedAt).toBe(NOW)
    expect(ttls[analysisKey('pinecone', 'pc-1')]).toBe(RESOLVED_TTL_S)
  })

  it('preserves the #1003 scoring baseline through the stamp (and returns it for the corpus)', async () => {
    const { kv, store } = mockKV({ [analysisKey('pinecone', 'pc-1')]: analysisValue() })

    const analysis = await markIncidentResolved(kv, 'pinecone', INC, NOW)

    // The value the history record is built from must still grade on the FIRST estimate, not the
    // re-analysis-inflated current one.
    expect(analysis?.firstEstimatedRecoveryHours).toBe(4)
    expect(analysis?.estimatedRecoveryHours).toBe(15)
    expect(parseAnalysis(store[analysisKey('pinecone', 'pc-1')])?.firstEstimatedRecoveryHours).toBe(4)
    // …and it self-heals into the durable key on the way through putAnalysis.
    expect(store[firstEstimateKey('pinecone', 'pc-1')]).toBe('4')
  })

  it('is idempotent — an already-stamped analysis is not rewritten (both cron paths may fire)', async () => {
    const stamped = analysisValue({ resolvedAt: '2026-07-13T08:00:00.000Z' })
    const { kv, store } = mockKV({ [analysisKey('pinecone', 'pc-1')]: stamped })

    const analysis = await markIncidentResolved(kv, 'pinecone', INC, NOW)

    expect(analysis?.resolvedAt).toBe('2026-07-13T08:00:00.000Z') // the ORIGINAL resolution time
    expect(store[analysisKey('pinecone', 'pc-1')]).toBe(stamped)
  })

  it('drops a corrupt analysis rather than serving it to every reader', async () => {
    const { kv, store } = mockKV({ [analysisKey('pinecone', 'pc-1')]: '{ broken' })

    const analysis = await markIncidentResolved(kv, 'pinecone', INC, NOW)

    expect(analysis).toBeNull()
    expect(store[analysisKey('pinecone', 'pc-1')]).toBeUndefined()
    expect(store[recoveryMarkerKey('pinecone', 'pc-1')]).toBeDefined() // marker still written
  })

  it('measures duration to the incident\'s own resolvedAt, not the cron cycle', async () => {
    const { kv, store } = mockKV()
    // Cron runs 20 min after the source actually resolved it — the marker must not inflate by 20m.
    await markIncidentResolved(kv, 'pinecone', INC, '2026-07-13T08:52:00.000Z')
    expect(JSON.parse(store[recoveryMarkerKey('pinecone', 'pc-1')]).duration).toBe('4h 55m')
  })
})

describe('#1003 — BOTH cron resolution paths mark the incident resolved', () => {
  // The bug: the marker + resolvedAt stamp were written ONLY inside the `alerted:recovered:`
  // (status-edge) block, whose own comment calls it "rarely-firing". The path that actually fires for
  // a normal incident — `alerted:res:` — wrote the durable corpus (#847) but not these, so the three
  // read surfaces never appeared. There is no test harness that drives the cron `scheduled` handler,
  // so pin the call sites at the source level (same idiom as first-estimate-write-paths.test.ts).
  const src = readFileSync(join(__dirname, '..', 'index.ts'), 'utf8')

  it('the status-edge path and the incident-resolved path both call markIncidentResolved', () => {
    expect((src.match(/await markIncidentResolved\(/g) ?? []).length).toBe(2)
  })

  it('the alerted:res: block — the one that fires for normal incidents — is one of them', () => {
    // Bounded by the block's real end (the #882 comment that follows it), not an arbitrary char
    // window — a window drifts out from under the assertion the moment a comment above it grows.
    const start = src.indexOf("if (alert.key.startsWith('alerted:res:'))")
    const end = src.indexOf('// #882 —', start)
    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)
    expect(src.slice(start, end)).toMatch(/await markIncidentResolved\(/)
  })

  it('no module writes the recovery marker directly (it would skip the resolvedAt stamp)', () => {
    // Sweep every worker module, not just index.ts: a marker written without the paired analysis stamp
    // lights the banner while the modal's verdict stays blank — half a surface, which is how this bug
    // looked in the first place. recovery-mark.ts owns the only write.
    const dir = join(__dirname, '..')
    for (const file of readdirSync(dir).filter(f => f.endsWith('.ts') && f !== 'recovery-mark.ts')) {
      const body = readFileSync(join(dir, file), 'utf8').replace(/\s*\n\s*/g, ' ')
      expect(body, `${file} writes a recovered: marker outside markIncidentResolved`)
        .not.toMatch(/(?:kvPut\([^,]+,|\.put\()\s*(?:`recovered:|recoveryMarkerKey\()/)
    }
  })

  it('the status-edge path marks only TERMINAL incidents (never stamps a live one)', () => {
    // An operational service can still carry an ACTIVE incident (incidentExclude'd, maintenance, a
    // component mapping to nothing monitored). Stamping `resolvedAt` on its analysis would make the
    // modal + is-down render a predicted-vs-actual verdict for an incident that is still running.
    expect(src).toMatch(/const terminal = incidents\.filter\(i => i\.status === 'resolved' \|\| i\.status === 'monitoring'\)/)
    expect(src).toMatch(/await Promise\.all\(terminal\.map\(/)
  })

  it('a MERGED resolved alert marks every incident it collapsed, not just the first', () => {
    // xAI regional / Together model alerts collapse N incidents into one embed. `_mergedKeys` is the
    // REPLACEMENT list (it already contains `alert.key` at [0] — alerts.ts `mergeXaiRegionalAlerts`),
    // so `?? [alert.key]` is the correct idiom: spreading both would process the primary twice.
    // Marking `alert.key` alone left the other merged incidents with no marker, no resolvedAt stamp
    // and no corpus record.
    expect(src).toMatch(/\(alert\._mergedKeys \?\? \[alert\.key\]\)/)
    expect(src).not.toMatch(/\[alert\.key, \.\.\.\(alert\._mergedKeys/)
  })
})
