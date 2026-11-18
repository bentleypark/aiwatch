/** Optional-chained rather than `process.env.X`, matching `_shared/edge-fallback-alert.ts`'s
 *  `readEnv` and for the reason stated there: a runtime without the global yields `undefined`
 *  instead of a throw. At MODULE scope that distinction is the whole page — a throw here happens
 *  before any handler runs and takes out every route that imports it, and nothing would catch it
 *  first (`api/` has no tsc gate, and vitest runs under Node where `process` exists). */
function readEnv(name: string): string | undefined {
  return (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.[name]
}

/** Lets a local SSR check read a locally running Worker (`AIWATCH_WORKER_API`) without editing the
 *  caller. Ignored when `VERCEL_ENV` says production: the override silently repoints a surface's data
 *  source, so a stray value on the production project would be invisible — the pages would render
 *  normally, off the wrong Worker. A local-verification affordance should not be reachable in
 *  production at all. */
export function resolveWorkerApi(prodApi: string, env: (name: string) => string | undefined = readEnv): string {
  return env('VERCEL_ENV') === 'production' ? prodApi : env('AIWATCH_WORKER_API') || prodApi
}

export const PROD_WORKER_API = 'https://aiwatch-worker.p2c2kbf.workers.dev'
export const LOCAL_WORKER_API = 'http://localhost:8788'

/** The worker chosen by the host of the incoming request: a `vercel dev` request (localhost) targets
 *  the local `wrangler dev` worker, everything else the deployed one. */
export function workerApiFor(reqUrl: string): string {
  try {
    const { hostname } = new URL(reqUrl)
    if (hostname === 'localhost' || hostname === '127.0.0.1') return LOCAL_WORKER_API
  } catch { /* fall through to prod */ }
  return PROD_WORKER_API
}
