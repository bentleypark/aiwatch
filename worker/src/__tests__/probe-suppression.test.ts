import { describe, it, expect, vi } from 'vitest'
import { recordProbeSuppression } from '../services'

// Regression guard for #501: the probe cross-validation suppression counter shipped with
// `kvPut` un-imported in services.ts, so the inline write threw `ReferenceError: kvPut is not
// defined`. That throw is uncaught inside fetchAllServices(), so the WHOLE 34-service fetch
// rejected → "fetchAllServices() 전체 실패 / kvPut is not defined" Worker Error alert.
// These tests exercise the exact write path; if the import regresses, they throw at runtime
// (esbuild/wrangler dry-run does NOT type-check, so only a runtime test catches this).

function makeKV() {
  const store = new Map<string, string>()
  return {
    get: async (k: string) => store.get(k) ?? null,
    put: vi.fn(async (k: string, v: string) => { store.set(k, v) }),
    delete: async (k: string) => { store.delete(k) },
    _store: store,
  } as unknown as KVNamespace & { _store: Map<string, string>; put: ReturnType<typeof vi.fn> }
}

describe('recordProbeSuppression (#501)', () => {
  it('does not throw and writes the counter at 1 on first suppression', async () => {
    const kv = makeKV()
    await expect(recordProbeSuppression(kv, 'claude', '2026-06-02')).resolves.toBeUndefined()
    expect(kv._store.get('cross-valid:suppressed:claude:2026-06-02')).toBe('1')
    expect(kv.put).toHaveBeenCalledWith(
      'cross-valid:suppressed:claude:2026-06-02',
      '1',
      { expirationTtl: 172800 },
    )
  })

  it('increments an existing same-day counter', async () => {
    const kv = makeKV()
    kv._store.set('cross-valid:suppressed:openai:2026-06-02', '4')
    await recordProbeSuppression(kv, 'openai', '2026-06-02')
    expect(kv._store.get('cross-valid:suppressed:openai:2026-06-02')).toBe('5')
  })

  it('keys per service and per day (no cross-contamination)', async () => {
    const kv = makeKV()
    await recordProbeSuppression(kv, 'gemini', '2026-06-02')
    await recordProbeSuppression(kv, 'gemini', '2026-06-03')
    expect(kv._store.get('cross-valid:suppressed:gemini:2026-06-02')).toBe('1')
    expect(kv._store.get('cross-valid:suppressed:gemini:2026-06-03')).toBe('1')
  })

  it('treats a corrupt/non-numeric stored value as 0', async () => {
    const kv = makeKV()
    kv._store.set('cross-valid:suppressed:groq:2026-06-02', 'not-a-number')
    await recordProbeSuppression(kv, 'groq', '2026-06-02')
    expect(kv._store.get('cross-valid:suppressed:groq:2026-06-02')).toBe('1')
  })

  it('does not throw when kv.get rejects (the .catch fallback)', async () => {
    const kv = makeKV()
    kv.get = async () => { throw new Error('KV read failed') }
    await expect(recordProbeSuppression(kv, 'mistral', '2026-06-02')).resolves.toBeUndefined()
    expect(kv._store.get('cross-valid:suppressed:mistral:2026-06-02')).toBe('1')
  })

  it('does not throw when kv.put rejects (kvPut swallows it — the "never throws" write-side contract)', async () => {
    // The helper's docstring promises it never throws; the write-side guarantee lives in kvPut's
    // try/catch (utils.ts). Pin it: if someone swaps kvPut for a raw kv.put, this test fails.
    const kv = makeKV()
    kv.put = vi.fn(async () => { throw new Error('KV write failed') })
    await expect(recordProbeSuppression(kv, 'cohere', '2026-06-02')).resolves.toBeUndefined()
  })
})
