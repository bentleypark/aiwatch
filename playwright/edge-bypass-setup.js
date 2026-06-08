// #570 — Vercel Preview deployments have Deployment Protection on, so unauthenticated
// requests get HTTP 401 and the Edge E2E job can never reach the preview. Vercel's
// "Protection Bypass for Automation" lets us through with a secret.
//
// We deliberately do NOT inject the secret as a Playwright `extraHTTPHeaders` entry:
// those headers are sent with EVERY request the browser makes, including cross-origin
// ones (GA4, font CDNs, the Worker API), which would leak the bypass secret to third
// parties. Instead we make a single request to the preview origin with
// `x-vercel-set-bypass-cookie=true`, which makes Vercel set a bypass cookie scoped to
// the preview domain, and persist that cookie via storageState. Subsequent navigations
// reuse the cookie — no secret ever leaves the preview origin.
//
// No-op (and writes an empty state) when EDGE_BASE_URL or the secret is absent — i.e.
// local `vercel dev` runs and the desktop/mobile CI job are unaffected.
import { request } from '@playwright/test'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
export const EDGE_BYPASS_STATE = path.join(__dirname, '.edge-bypass-state.json')

export default async function globalSetup() {
  const base = process.env.EDGE_BASE_URL
  const secret = process.env.VERCEL_AUTOMATION_BYPASS_SECRET
  // storageState must always exist once referenced by a project, so write an empty
  // state even on the no-op path (a project pointing at a missing file would error).
  const ctx = await request.newContext()
  if (base && secret) {
    const res = await ctx.get(`${base}/`, {
      params: {
        'x-vercel-protection-bypass': secret,
        'x-vercel-set-bypass-cookie': 'true',
      },
    })
    if (!res.ok()) {
      throw new Error(
        `[edge-bypass] failed to obtain Vercel bypass cookie: HTTP ${res.status()} for ${base}/`,
      )
    }
  }
  const state = await ctx.storageState({ path: EDGE_BYPASS_STATE })
  await ctx.dispose()
  // Fail loudly here, not as a confusing per-spec 401: if the bypass request succeeded but
  // set no cookie (e.g. Vercel changed its protection-bypass behavior), the empty state would
  // sail through and every Edge spec would 401. Assert we actually captured a cookie.
  if (base && secret && state.cookies.length === 0) {
    throw new Error(
      '[edge-bypass] bypass request returned OK but set no cookie — Vercel Protection Bypass ' +
        'behavior may have changed; aborting so the Edge suite fails here instead of 401-ing per spec',
    )
  }
}
