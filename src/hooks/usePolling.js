// usePolling — returns live service status data
// Placeholder: simulates 800ms load, returns static data, and re-triggers every 60s
// to keep lastUpdated live for UI demonstration — no real fetch occurs.
// Issue #15 replaces this with real Cloudflare Worker polling.
// The return shape { services, loading, error, lastUpdated } and the ServiceStatus
// object structure are the public contract — preserve them in Issue #15.

import { useState, useEffect } from 'react'

const POLL_INTERVAL = 60_000 // 60s

// Reference date for deterministic placeholder timestamps.
// WARNING: incident timestamps are relative to REF — if changed to Date.now(),
// verify ago() values still fall within the 7-day window used in Overview.jsx.
const REF = new Date('2026-03-19T10:00:00Z')
const ago = (ms) => new Date(REF - ms).toISOString()
const M = 60_000
const H = 3_600_000
const D = 86_400_000

// 30-day operational history helper: 0=oldest (left), 29=today (right).
// MiniHistory renders this order directly with no reversal.
function hist(degraded = [], down = []) {
  return Array.from({ length: 30 }, (_, i) => {
    if (down.includes(i)) return 'down'
    if (degraded.includes(i)) return 'degraded'
    return 'operational'
  })
}

// history3m: last 3 calendar months, oldest first. Used by Uptime Report matrix.
// Shape: [{ month: 'YYYY-MM', uptime: number }] — 3 entries, index 0 = oldest.
const SERVICES = [
  {
    id: 'claude', category: 'api', name: 'Claude API', provider: 'Anthropic', status: 'operational',
    latency: 145, uptime30d: 99.97,
    history30d: hist([27]),
    history3m: [{ month: '2026-01', uptime: 99.99 }, { month: '2026-02', uptime: 99.98 }, { month: '2026-03', uptime: 99.97 }],
    incidents: [],
  },
  {
    id: 'openai', category: 'api', name: 'OpenAI API', provider: 'OpenAI', status: 'degraded',
    latency: 312, uptime30d: 99.21,
    history30d: hist([22, 23, 28]),
    history3m: [{ month: '2026-01', uptime: 99.80 }, { month: '2026-02', uptime: 99.65 }, { month: '2026-03', uptime: 99.21 }],
    incidents: [
      {
        id: 'oi-1', title: 'Elevated API Error Rates', startedAt: ago(2 * D), duration: '2h 14m', status: 'resolved',
        timeline: [
          { stage: 'investigating', at: ago(2 * D) },
          { stage: 'identified',    at: ago(2 * D - 30 * M) },
          { stage: 'monitoring',    at: ago(2 * D - 75 * M) },
          { stage: 'resolved',      at: ago(2 * D - 134 * M) },
        ],
      },
      {
        id: 'oi-2', title: 'Increased Latency on Chat Endpoint', startedAt: ago(4 * H), duration: null, status: 'monitoring',
        timeline: [
          { stage: 'investigating', at: ago(4 * H) },
          { stage: 'identified',    at: ago(3 * H) },
          { stage: 'monitoring',    at: ago(2 * H) },
        ],
      },
    ],
  },
  {
    id: 'gemini', category: 'api', name: 'Gemini API', provider: 'Google', status: 'operational',
    latency: 198, uptime30d: 99.85,
    history30d: hist([14]),
    history3m: [{ month: '2026-01', uptime: 99.95 }, { month: '2026-02', uptime: 99.90 }, { month: '2026-03', uptime: 99.85 }],
    incidents: [],
  },
  {
    id: 'mistral', category: 'api', name: 'Mistral API', provider: 'Mistral AI', status: 'operational',
    latency: 89, uptime30d: 99.92,
    history30d: hist(),
    history3m: [{ month: '2026-01', uptime: 99.97 }, { month: '2026-02', uptime: 99.95 }, { month: '2026-03', uptime: 99.92 }],
    incidents: [],
  },
  {
    id: 'cohere', category: 'api', name: 'Cohere API', provider: 'Cohere', status: 'operational',
    latency: 234, uptime30d: 99.50,
    history30d: hist([8]),
    history3m: [{ month: '2026-01', uptime: 99.72 }, { month: '2026-02', uptime: 99.60 }, { month: '2026-03', uptime: 99.50 }],
    incidents: [],
  },
  {
    id: 'groq', category: 'api', name: 'Groq Cloud', provider: 'Groq', status: 'operational',
    latency: 52, uptime30d: 99.95,
    history30d: hist(),
    history3m: [{ month: '2026-01', uptime: 99.98 }, { month: '2026-02', uptime: 99.97 }, { month: '2026-03', uptime: 99.95 }],
    incidents: [],
  },
  {
    id: 'together', category: 'api', name: 'Together AI', provider: 'Together', status: 'operational',
    latency: 178, uptime30d: 99.72,
    history30d: hist([19]),
    history3m: [{ month: '2026-01', uptime: 99.85 }, { month: '2026-02', uptime: 99.78 }, { month: '2026-03', uptime: 99.72 }],
    incidents: [],
  },
  {
    id: 'perplexity', category: 'api', name: 'Perplexity', provider: 'Perplexity AI', status: 'operational',
    latency: 420, uptime30d: 99.33,
    history30d: hist([5, 6]),
    history3m: [{ month: '2026-01', uptime: 99.60 }, { month: '2026-02', uptime: 99.45 }, { month: '2026-03', uptime: 99.33 }],
    incidents: [],
  },
  {
    id: 'huggingface', category: 'api', name: 'Hugging Face', provider: 'Hugging Face', status: 'degraded',
    latency: 890, uptime30d: 98.52,
    history30d: hist([10, 20, 25], [15, 16, 17]),
    history3m: [{ month: '2026-01', uptime: 99.20 }, { month: '2026-02', uptime: 98.80 }, { month: '2026-03', uptime: 98.52 }],
    incidents: [
      {
        id: 'hf-1', title: 'Model Inference Slowdown', startedAt: ago(1 * D), duration: null, status: 'monitoring',
        timeline: [
          { stage: 'investigating', at: ago(1 * D) },
          { stage: 'identified',    at: ago(1 * D - 2 * H) },
          { stage: 'monitoring',    at: ago(1 * D - 4 * H) },
        ],
      },
      {
        id: 'hf-2', title: 'Inference API Outage', startedAt: ago(15 * D), duration: '8h 32m', status: 'resolved',
        timeline: [
          { stage: 'investigating', at: ago(15 * D) },
          { stage: 'identified',    at: ago(15 * D - 1 * H) },
          { stage: 'monitoring',    at: ago(15 * D - 3 * H) },
          { stage: 'resolved',      at: ago(15 * D - 512 * M) },
        ],
      },
    ],
  },
  {
    id: 'replicate', category: 'api', name: 'Replicate', provider: 'Replicate', status: 'operational',
    latency: 267, uptime30d: 99.61,
    history30d: hist([3]),
    history3m: [{ month: '2026-01', uptime: 99.80 }, { month: '2026-02', uptime: 99.70 }, { month: '2026-03', uptime: 99.61 }],
    incidents: [],
  },
  {
    id: 'elevenlabs', category: 'api', name: 'ElevenLabs', provider: 'ElevenLabs', status: 'operational',
    latency: 156, uptime30d: 99.80,
    history30d: hist(),
    history3m: [{ month: '2026-01', uptime: 99.90 }, { month: '2026-02', uptime: 99.85 }, { month: '2026-03', uptime: 99.80 }],
    incidents: [],
  },
  {
    id: 'xai', category: 'api', name: 'xAI (Grok)', provider: 'xAI', status: 'operational',
    latency: 203, uptime30d: 99.75,
    history30d: hist([24]),
    history3m: [{ month: '2026-01', uptime: 99.82 }, { month: '2026-02', uptime: 99.79 }, { month: '2026-03', uptime: 99.75 }],
    incidents: [],
  },
  {
    id: 'deepseek', category: 'api', name: 'DeepSeek API', provider: 'DeepSeek', status: 'operational',
    latency: 321, uptime30d: 99.40,
    history30d: hist([11]),
    history3m: [{ month: '2026-01', uptime: 99.55 }, { month: '2026-02', uptime: 99.48 }, { month: '2026-03', uptime: 99.40 }],
    incidents: [],
  },
  // ── AI Web Services (no latency — web apps, not APIs) ──
  {
    id: 'claudeai', name: 'claude.ai', provider: 'Anthropic', status: 'operational',
    category: 'webapp',
    latency: null, uptime30d: 99.00,
    history30d: hist([3, 9, 13, 19, 27]),
    history3m: [{ month: '2026-01', uptime: 99.40 }, { month: '2026-02', uptime: 99.10 }, { month: '2026-03', uptime: 99.00 }],
    incidents: [],
  },
  {
    id: 'chatgpt', name: 'ChatGPT', provider: 'OpenAI', status: 'operational',
    category: 'webapp',
    latency: null, uptime30d: 98.20,
    history30d: hist([1, 4, 8, 12, 18, 22, 28]),
    history3m: [{ month: '2026-01', uptime: 98.90 }, { month: '2026-02', uptime: 97.50 }, { month: '2026-03', uptime: 98.20 }],
    incidents: [],
  },
  // ── Coding Agents ──
  {
    id: 'claudecode', name: 'Claude Code', provider: 'Anthropic', status: 'operational',
    category: 'agent',
    latency: null, uptime30d: 99.00,
    history30d: hist([5, 13, 21, 29]),
    history3m: [{ month: '2026-01', uptime: 99.50 }, { month: '2026-02', uptime: 99.20 }, { month: '2026-03', uptime: 99.00 }],
    incidents: [],
  },
  {
    id: 'copilot', name: 'GitHub Copilot', provider: 'Microsoft', status: 'operational',
    category: 'agent',
    latency: null, uptime30d: 99.40,
    history30d: hist([9, 24]),
    history3m: [{ month: '2026-01', uptime: 99.60 }, { month: '2026-02', uptime: 99.50 }, { month: '2026-03', uptime: 99.40 }],
    incidents: [],
  },
  {
    id: 'cursor', name: 'Cursor', provider: 'Anysphere', status: 'operational',
    category: 'agent',
    latency: null, uptime30d: 99.20,
    history30d: hist(),
    history3m: [{ month: '2026-01', uptime: 99.40 }, { month: '2026-02', uptime: 99.30 }, { month: '2026-03', uptime: 99.20 }],
    incidents: [],
  },
  {
    id: 'windsurf', name: 'Windsurf', provider: 'Codeium', status: 'operational',
    category: 'agent',
    latency: null, uptime30d: 98.80,
    history30d: hist([10, 27]),
    history3m: [{ month: '2026-01', uptime: 99.20 }, { month: '2026-02', uptime: 99.00 }, { month: '2026-03', uptime: 98.80 }],
    incidents: [],
  },
]

export function usePolling() {
  const [state, setState] = useState({
    services: [],
    loading: true,
    error: null,
    lastUpdated: null,
  })

  useEffect(() => {
    let cancelled = false

    async function poll() {
      try {
        // Placeholder: simulate network latency for skeleton UI demonstration
        await new Promise((r) => setTimeout(r, 800))
        if (!cancelled) {
          setState({ services: SERVICES, loading: false, error: null, lastUpdated: new Date() })
        }
      } catch (err) {
        // Note: unreachable in placeholder mode — real fetch errors surface here after Issue #15
        if (!cancelled) {
          setState((s) => ({ ...s, loading: false, error: err }))
        }
      }
    }

    poll()
    const interval = setInterval(poll, POLL_INTERVAL)
    return () => {
      cancelled = true
      clearInterval(interval)
    }
  }, [])

  return state
}
