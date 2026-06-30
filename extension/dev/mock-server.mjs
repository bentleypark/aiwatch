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

const DOWN = {
  cachedAt: new Date(now).toISOString(),
  services: [
    {
      id: 'claude', name: 'Claude API', status: 'down', uptime30d: 98.42, score: 42, grade: 'unstable',
      fallback: [{ name: 'OpenAI API', score: 91 }, { name: 'Gemini API', score: 84 }],
      incidents: [{ id: 'i1', title: 'Elevated API errors', status: 'investigating', impact: 'major', aiSummary: 'API returning 529s on completions; mitigation underway, ~30–60m.' }],
      reports: { count: 3, recent: [
        { cat: 'outage', ts: now - 120000, desc: "can't send messages, getting 529 overloaded" },
        { cat: 'errors', ts: now - 360000, desc: '500s on /v1/messages for ~5 min' },
        { cat: 'errors', ts: now - 600000, desc: '' },
      ] },
    },
    {
      id: 'claudeai', name: 'claude.ai', status: 'degraded', uptime30d: 99.71, score: 60, grade: 'fair',
      fallback: [{ name: 'ChatGPT', score: 81 }],
      incidents: [{ id: 'i2', title: 'Slow message sending', status: 'identified', impact: 'minor' }],
      reports: { count: 0, recent: [] },
    },
    {
      id: 'claudecode', name: 'Claude Code', status: 'operational', uptime30d: 99.98, score: 80, grade: 'good',
      fallback: [], incidents: [], reports: { count: 0, recent: [] },
    },
  ],
}

const OPERATIONAL = {
  cachedAt: new Date(now).toISOString(),
  services: DOWN.services.map((s) => ({ ...s, status: 'operational', incidents: [], reports: { count: 0, recent: [] } })),
}

const payload = scenario === 'operational' ? OPERATIONAL : DOWN

const server = createServer((req, res) => {
  const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' }
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); res.end(); return }
  const url = new URL(req.url, `http://localhost:${PORT}`)
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
