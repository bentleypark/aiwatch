// #1389 — shared harness for an Atlassian status page in its POST-`LAZY_UPTIME_SHOWCASE` shape.
//
// Extracted at its second consumer (the repo convention — see `unreadable-source.ts`'s own note):
// `lazy-uptime-showcase.test.ts` proves uptime is recovered from the new endpoint, and
// `uptime-liveness.test.ts` needs the identical premise to prove that the same run arms the
// stopped-publishing alert. The page shape is the load-bearing part of both, and two copies of it drift.
//
// NOT a `*.test.ts` file on purpose: `worker/vitest.config.ts` collects `src/**/*.test.ts`.
import { vi } from 'vitest'
import { HEALTHY_SUMMARY } from './unreadable-source'

export const CLAUDE_API = 'k8w3r06qmzrp'      // services.ts: claude.statusComponentId
export const CLAUDE_AI = 'rwppv331jlwc'       // services.ts: claudeai.statusComponentId
export const CLAUDE_CODE = 'yyzkbfz2thpt'     // services.ts: claudecode.statusComponentId
export const PAGE = 'https://status.claude.com'
export const CLAUDE_SUMMARY_URL = `${PAGE}/api/v2/summary.json`

/**
 * The real payload's shape: **90** published days ending on `endDate`, chronological oldest→newest.
 * Measured against the live endpoint 2026-09-11 — every one of the 13 lazy pages returns 90.
 *
 * A 30-day fixture (the first draft here) cannot discriminate anything the trailing-window slice does:
 * `scored.length > trailing.length` is false, so `uptimeReported` / `uptimeReportedDays` — the
 * provider's own ~90-day figure that #1006 deliberately shows beside ours — stay null and the whole
 * disclosure path goes unexercised. Widening `windowDays` from 30 to 90 was green under that fixture.
 *
 * Two outages, placed to separate the two windows:
 *   - INSIDE the trailing 30: 0.3 × 8640 = 2592s over 30 × 86400 → exactly **99.9%**.
 *   - OUTSIDE it (day 5 of 90): both outages land in the 90-day sum → 2 × 2592s over 90 × 86400 →
 *     **99.93%**, so the two numbers differ and `services.ts` actually populates `uptimeReported`
 *     rather than suppressing it as identical to ours.
 */
export const FIXTURE_UPTIME_30D = 99.9
export const FIXTURE_UPTIME_90D = 99.93
export const FIXTURE_DAYS = 90

export function ninetyDays(endDate: string) {
  const end = Date.parse(`${endDate}T00:00:00Z`)
  return Array.from({ length: FIXTURE_DAYS }, (_, i) => {
    const withinTrailing30 = i === FIXTURE_DAYS - 20 // 20 days before the end → inside the 30-day tail
    const outsideTrailing30 = i === 5               // 85 days before the end → 90-day window only
    return {
      date: new Date(end - (FIXTURE_DAYS - 1 - i) * 86_400_000).toISOString().split('T')[0],
      outages: withinTrailing30 || outsideTrailing30 ? { p: 8640, m: 0 } : {},
    }
  })
}

/** The page as it looked BEFORE the rollout: the blob inline, plus the alias line from #868. */
export function legacyPage(timelines: unknown): string {
  return `<script>\n  window.uptimeData = ${JSON.stringify(timelines)};\n  var uptimeData = window.uptimeData;\n</script>`
}

/** The page as it looks AFTER the rollout, reproducing the two things that made the break silent: the
 *  only `window.uptimeData` left is the loader's `|| {}` seed (RHS is not `{`, so there is nothing to
 *  extract), and the loader's own ES5 source — inlined in the same document — carries two
 *  `data-uptime-lazy=` string literals that are NOT placeholders. */
export function lazyPage(codes: string[]): string {
  return [
    '<div class="components-section">',
    ...codes.map((c) => `  <div class="component-inner-container" data-uptime-lazy="${c}"></div>`),
    '</div>',
    '<script>',
    '  window.uptimeData = window.uptimeData || {};',
    '  var uptimeData = window.uptimeData;',
    '  var ENDPOINT = "/uptime_showcase";',
    '  var placeholder = document.querySelector(\'[data-uptime-lazy="<code>"]\');',
    '  var el = document.querySelector(\'[data-uptime-lazy="\' + code + \'"]\');',
    '</script>',
  ].join('\n')
}

/** Serves the Anthropic page in its post-rollout shape; every other host answers a benign summary so no
 *  unrelated service can drag the run into a platform-quorum or fetch-failure branch. The caller owns
 *  the `/uptime_showcase` response, which is the axis every test here varies. */
export function stubLazyClaudePage(showcase: (url: string) => Response) {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url
    if (url.includes('/uptime_showcase')) return showcase(url)
    if (url.startsWith(CLAUDE_SUMMARY_URL)) {
      return new Response(JSON.stringify({
        status: { indicator: 'none', description: 'All Systems Operational' },
        components: [
          { id: CLAUDE_API, name: 'Claude API', status: 'operational' },
          { id: CLAUDE_AI, name: 'claude.ai', status: 'operational' },
          { id: CLAUDE_CODE, name: 'Claude Code', status: 'operational' },
        ],
        incidents: [], scheduled_maintenances: [],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }
    if (url.startsWith(`${PAGE}/api/v2/incidents.json`)) {
      return new Response(JSON.stringify({ incidents: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }
    if (url === PAGE || url === `${PAGE}/`) {
      return new Response(lazyPage([CLAUDE_API, CLAUDE_AI, CLAUDE_CODE]), { status: 200, headers: { 'Content-Type': 'text/html' } })
    }
    return new Response(JSON.stringify(HEALTHY_SUMMARY), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }))
}

/** A `/uptime_showcase` response carrying all three Anthropic components, current as of `endDate`. */
export function showcaseResponse(endDate: string): Response {
  const days = ninetyDays(endDate)
  return new Response(JSON.stringify({
    timelines: {
      [CLAUDE_API]: { component: { code: CLAUDE_API }, days },
      [CLAUDE_AI]: { component: { code: CLAUDE_AI }, days },
      [CLAUDE_CODE]: { component: { code: CLAUDE_CODE }, days },
    },
  }), { status: 200 })
}
