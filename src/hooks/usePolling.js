// usePolling — fetches live service status from Cloudflare Worker proxy.
// Falls back to mock data when Worker is unavailable (local dev without worker).
// Return shape: { services, loading, error, lastUpdated, refresh }

import { useState, useEffect, useCallback, useRef, createContext, useContext, createElement } from 'react'

const POLL_INTERVAL = 60_000 // 60s

// Worker API URL — defaults to local dev, override via env
const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:8787/api/status'

// ── Mock data fallback (used when Worker is unavailable) ──

const REF = new Date('2026-03-19T10:00:00Z')
const ago = (ms) => new Date(REF - ms).toISOString()
const M = 60_000
const H = 3_600_000
const D = 86_400_000

function hist(degraded = [], down = []) {
  return Array.from({ length: 30 }, (_, i) => {
    if (down.includes(i)) return 'down'
    if (degraded.includes(i)) return 'degraded'
    return 'operational'
  })
}

const MOCK_SERVICES = [
  {
    id: 'claudeai', category: 'webapp', name: 'claude.ai', provider: 'Anthropic', status: 'operational',
    latency: null, uptime30d: 99.00,
    history30d: hist([3, 9, 13, 19, 27]),
    history3m: [{ month: '2026-01', uptime: 99.40 }, { month: '2026-02', uptime: 99.10 }, { month: '2026-03', uptime: 99.00 }],
    incidents: [],
  },
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
    id: 'chatgpt', category: 'webapp', name: 'ChatGPT', provider: 'OpenAI', status: 'operational',
    latency: null, uptime30d: 98.20,
    history30d: hist([1, 4, 8, 12, 18, 22, 28]),
    history3m: [{ month: '2026-01', uptime: 98.90 }, { month: '2026-02', uptime: 97.50 }, { month: '2026-03', uptime: 98.20 }],
    incidents: [],
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
  {
    id: 'claudecode', category: 'agent', name: 'Claude Code', provider: 'Anthropic', status: 'operational',
    latency: null, uptime30d: 99.00,
    history30d: hist([5, 13, 21, 29]),
    history3m: [{ month: '2026-01', uptime: 99.50 }, { month: '2026-02', uptime: 99.20 }, { month: '2026-03', uptime: 99.00 }],
    incidents: [],
  },
  {
    id: 'copilot', category: 'agent', name: 'GitHub Copilot', provider: 'Microsoft', status: 'operational',
    latency: null, uptime30d: 99.40,
    history30d: hist([9, 24]),
    history3m: [{ month: '2026-01', uptime: 99.60 }, { month: '2026-02', uptime: 99.50 }, { month: '2026-03', uptime: 99.40 }],
    incidents: [],
  },
  {
    id: 'cursor', category: 'agent', name: 'Cursor', provider: 'Anysphere', status: 'operational',
    latency: null, uptime30d: 99.20,
    history30d: hist(),
    history3m: [{ month: '2026-01', uptime: 99.40 }, { month: '2026-02', uptime: 99.30 }, { month: '2026-03', uptime: 99.20 }],
    incidents: [],
  },
  {
    id: 'windsurf', category: 'agent', name: 'Windsurf', provider: 'Codeium', status: 'operational',
    latency: null, uptime30d: 98.80,
    history30d: hist([10, 27]),
    history3m: [{ month: '2026-01', uptime: 99.20 }, { month: '2026-02', uptime: 99.00 }, { month: '2026-03', uptime: 98.80 }],
    incidents: [],
  },
]

// ── Merge live Worker data with mock fallback ──
// Worker provides: id, name, provider, category, status, latency, incidents
// Mock provides: uptime30d, history30d, history3m (not available from Worker yet)
// Merge: start from mock list (preserves order + all services), overlay live data
function mergeWithMock(liveServices) {
  const liveMap = Object.fromEntries(liveServices.map((s) => [s.id, s]))
  return MOCK_SERVICES.map((mock) => {
    const live = liveMap[mock.id]
    if (!live) return mock // Worker didn't return this service — use mock
    return {
      ...mock,            // fallback fields (uptime30d, history30d, history3m)
      ...live,            // override with live data (status, latency, incidents)
      uptime30d: mock.uptime30d,       // Worker doesn't provide this yet
      history30d: mock.history30d,     // Worker doesn't provide this yet
      history3m: mock.history3m,       // Worker doesn't provide this yet
    }
  })
}

// ── Context (single instance shared across all components) ──

const PollingContext = createContext(null)

export function PollingProvider({ children }) {
  const value = usePollingInternal()
  return createElement(PollingContext.Provider, { value }, children)
}

export function usePolling() {
  const ctx = useContext(PollingContext)
  if (!ctx) throw new Error('usePolling must be used within a PollingProvider')
  return ctx
}

function usePollingInternal() {
  const [state, setState] = useState({
    services: [],
    loading: true,
    error: null,
    lastUpdated: null,
  })
  const cancelledRef = useRef(false)
  const controllerRef = useRef(null)
  const poll = useCallback(async () => {
    controllerRef.current?.abort()
    const controller = new AbortController()
    controllerRef.current = controller
    const timer = setTimeout(() => controller.abort(), 15000)

    // Show skeleton UI
    if (!cancelledRef.current) {
      setState((prev) => ({ ...prev, loading: true }))
    }
    // Yield to browser so skeleton renders before fetch begins
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
    const loadStart = Date.now()

    try {
      const res = await fetch(API_URL, { signal: controller.signal })
      clearTimeout(timer)
      if (!res.ok) throw new Error(`Worker responded ${res.status}`)
      const data = await res.json()
      const merged = mergeWithMock(data.services)

      const elapsed = Date.now() - loadStart
      if (elapsed < 2000) await new Promise((r) => setTimeout(r, 2000 - elapsed))

      if (!cancelledRef.current) {
        setState({
          services: merged,
          loading: false,
          error: null,
          lastUpdated: new Date(data.lastUpdated),
        })
      }
    } catch (err) {
      clearTimeout(timer)

      // Skip delay if intentionally aborted (new poll superseded this one)
      if (err?.name !== 'AbortError') {
        const elapsed = Date.now() - loadStart
        if (elapsed < 2000) await new Promise((r) => setTimeout(r, 2000 - elapsed))
      } else {
        // Don't change state — the new poll will handle it
        return
      }

      if (!cancelledRef.current) {
        // Network errors (Worker not running) → silent mock fallback
        const isSilent = err instanceof TypeError
        setState({
          services: MOCK_SERVICES,
          loading: false,
          error: isSilent ? null : err,
          lastUpdated: new Date(),
        })
      }
    }
  }, [])

  useEffect(() => {
    cancelledRef.current = false
    poll()
    const interval = setInterval(poll, POLL_INTERVAL)
    return () => {
      cancelledRef.current = true
      controllerRef.current?.abort()
      clearInterval(interval)
    }
  }, [poll])

  return { ...state, refresh: poll }
}
