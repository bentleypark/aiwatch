// Local mock of the AIWatch ext-claude endpoints, for verifying the extension's OUTAGE
// state (red badge + incident cards + gated crowd reports + uptime) without waiting for a
// real Claude outage. Node only, no deps.
//
//   node extension/dev/mock-server.mjs            # serves a DOWN scenario on :8799
//   node extension/dev/mock-server.mjs operational # all-green scenario
//
// Then TEMPORARILY point the extension at it (revert before committing):
//   1. extension/config.js   → WORKER_BASE = 'http://localhost:8799'
//   2. extension/manifest.json host_permissions → add 'http://localhost:8799/*'
//   3. chrome://extensions → reload the extension
// The service worker now polls this mock, so the badge + popup show the scenario
// PERSISTENTLY (no offline/storage tricks). Ctrl-C to stop; revert the two files after.
import { createServer } from 'node:http'

const PORT = 8799
const scenario = process.argv[2] === 'operational' ? 'operational' : 'down'
const now = Date.now()

// Shaped like the production `?src=ext-claude` payload (worker/src/ext-claude.ts `ExtClaudePayload`):
// components + reference (#1711), latestReport, and the #1772 analysis lines, recentlyResolved and
// recoveryBaseline. The DOWN scenario lights each section: a live analysed incident, an incident shared
// by two surfaces, a recently resolved one, and a Console incident.
const iso = (msAgo) => new Date(now - msAgo).toISOString()
const MIN = 60_000
const analysis = (summary, lines, analyzedMinAgo) => ({ summary, lines, analyzedAt: iso(analyzedMinAgo * MIN), model: 'Gemma' })
const LATEST_REPORT = {
  month: '2026-09',
  url: 'https://ai-watch.dev/reports/2026-09/',
  services: [
    { id: 'claude', incidents: 9, downtimeMin: 687 },
    { id: 'claudeai', incidents: 9, downtimeMin: 635 },
    { id: 'claudecode', incidents: 7, downtimeMin: 553 },
  ],
}
const BASELINES = {
  claude: { n: 47, medianMin: 63, p80Min: 161, since: '2026-07-22' },
  claudeai: { n: 50, medianMin: 48, p80Min: 98, since: '2026-07-22' },
  claudecode: { n: 50, medianMin: 60, p80Min: 106, since: '2026-07-21' },
}
const SHARED = { id: 'i-shared', title: 'Increased latency for Claude Opus requests', status: 'monitoring', impact: 'minor' }

const liveApi = analysis(
  'Messages API returns elevated 529 overloaded errors. A mitigation is being rolled out.',
  ['⏱ Est. Recovery: 1–2h', '📡 Scope: Claude API, Claude Opus'],
  5,
)
const liveAi = analysis(
  'Messages on claude.ai are slow to send. The cause is identified and a fix is in progress.',
  ['⏱ Est. Recovery: Ongoing ~3h · exceeded ~1–2h est.', '📡 Scope: claude.ai'],
  12,
)

const DOWN = {
  cachedAt: new Date(now).toISOString(),
  services: [
    {
      id: 'claude', name: 'Claude API', status: 'down', uptime30d: 98.42, score: 42, grade: 'unstable',
      fallback: [{ name: 'OpenAI API', score: 91 }, { name: 'Gemini API', score: 84 }],
      incidents: [
        { id: 'i1', title: 'Elevated API errors', status: 'investigating', impact: 'major', aiSummary: liveApi.summary, ai: liveApi },
        SHARED,
      ],
      recentlyResolved: [],
      reports: { count: 3, recent: [
        { cat: 'outage', ts: now - 2 * MIN, desc: "can't send messages, getting 529 overloaded" },
        { cat: 'errors', ts: now - 6 * MIN, desc: '500s on /v1/messages for ~5 min' },
        { cat: 'errors', ts: now - 10 * MIN, desc: '' },
      ] },
      components: [],
      recoveryBaseline: BASELINES.claude,
    },
    {
      id: 'claudeai', name: 'claude.ai', status: 'degraded', uptime30d: 99.71, score: 60, grade: 'fair',
      fallback: [{ name: 'Kimi App', score: 87 }, { name: 'DeepSeek App', score: 82 }],
      incidents: [{ id: 'i2', title: 'Slow message sending', status: 'identified', impact: 'minor', aiSummary: liveAi.summary, ai: liveAi }],
      recentlyResolved: [],
      reports: { count: 0, recent: [] },
      components: [{ name: 'claude.ai', status: 'degraded' }, { name: 'Claude Cowork', status: 'operational' }],
      recoveryBaseline: BASELINES.claudeai,
    },
    {
      id: 'claudecode', name: 'Claude Code', status: 'operational', uptime30d: 99.98, score: 80, grade: 'good',
      fallback: [{ name: 'GitHub Copilot', score: 92 }, { name: 'Codex', score: 71 }],
      incidents: [SHARED],
      recentlyResolved: [{
        id: 'r1', title: 'Claude Code login failures', status: 'resolved', impact: 'minor', resolvedAt: iso(40 * MIN),
        ai: analysis(
          'Some users could not sign in to Claude Code. A fix was deployed.',
          ['🎯 Predicted vs actual: est ~1h · actual 45m (within estimate)', '📡 Scope: Claude Code'],
          70,
        ),
      }],
      reports: { count: 0, recent: [] },
      components: [],
      recoveryBaseline: BASELINES.claudecode,
    },
  ],
  reference: {
    components: [{ name: 'Claude Console (platform.claude.com)', status: 'degraded' }],
    incidents: [{ id: 'c1', title: 'Console usage page fails to load', status: 'investigating', impact: 'minor' }],
  },
  latestReport: LATEST_REPORT,
}

const OPERATIONAL = {
  cachedAt: new Date(now).toISOString(),
  services: DOWN.services.map((s) => ({
    ...s, status: 'operational', incidents: [], recentlyResolved: [], reports: { count: 0, recent: [] },
    components: s.components.map((c) => ({ ...c, status: 'operational' })),
  })),
  reference: { components: [{ name: 'Claude Console (platform.claude.com)', status: 'operational' }], incidents: [] },
  latestReport: LATEST_REPORT,
}

const payload = scenario === 'operational' ? OPERATIONAL : DOWN

const server = createServer((req, res) => {
  const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' }
  const url = new URL(req.url, `http://localhost:${PORT}`)
  // #1773 — like production, the report preflight carries no Access-Control-Allow-Origin, so a
  // Firefox popup with its host permission revoked is blocked here too.
  if (req.method === 'OPTIONS') { res.writeHead(204, url.pathname === '/api/report-issue' ? {} : cors); res.end(); return }
  if (url.pathname === '/api/report-issue' && req.method === 'POST') {
    res.writeHead(200, { 'Content-Type': 'application/json', ...cors })
    res.end(JSON.stringify({ ok: true, message: 'Thanks — we factor this into our monitoring. (mock)' }))
    return
  }
  // Any GET (the SW polls /api/status/cached?src=ext-claude) → the scenario payload.
  res.writeHead(200, { 'Content-Type': 'application/json', ...cors })
  res.end(JSON.stringify({ ...payload, cachedAt: new Date(Date.now()).toISOString() }))
})

server.listen(PORT, () => {
  console.log(`AIWatch ext-claude mock (${scenario}) → http://localhost:${PORT}/api/status/cached?src=ext-claude`)
  console.log('Point extension/config.js WORKER_BASE + manifest host_permissions at http://localhost:8799, reload the extension. Ctrl-C to stop.')
})
