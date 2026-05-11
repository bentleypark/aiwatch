// KV key prefix + TTL for the Edge SSR fallback alert (#378).
//
// Extracted out of index.ts because `wrangler dev`'s local Workers runtime
// rejects non-handler *value* exports from the entry module ("Incorrect type
// for map entry '<name>': the provided value is not of type 'function or
// ExportedHandler'"). `wrangler deploy` tolerates them, but `dev` does not — so
// the documented local-test command (`npx wrangler dev --config worker/wrangler.toml`)
// was failing to start. Function exports from index.ts are fine; only `export
// const <literal>` breaks it. Keep these two here; index.ts imports them, and
// the test (`worker/src/__tests__/edge-fallback-alert.test.ts`) imports them
// from here too. If you add another shared constant for index.ts, put it in a
// module like this rather than exporting it from index.ts.
export const EDGE_FALLBACK_ALERT_TTL_S = 5 * 60 // 5min cooldown matches the worst-case Vercel Edge cache TTL
export const EDGE_FALLBACK_ALERT_KEY_PREFIX = 'alerted:edge-fallback:'
