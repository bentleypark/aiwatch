// #1698 — the inline is-down mirror of the worker's capabilityTagsOf: a routed TTS-only or STT-only outage
// gets that half of the Voice tier, a tagged voice service keeps its own tag, and an untagged routed
// audio outage keeps the whole tier.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import handler from '../is-down'
import { spyFetchWithEmptyReportFeed } from './fetch-stub'

const req = (slug: string) => new Request(`https://ai-watch.dev/api/is-down?slug=${slug}`, { method: 'GET' })
const now = () => new Date().toISOString()
const svc = (id: string, name: string, status: string, score: number, extra: Record<string, unknown> = {}) => ({
  id, name, category: 'api', status, latency: 200, uptime30d: 99.9, lastChecked: now(), aiwatchScore: score, scoreGrade: 'good', scoreConfidence: 'high',
  incidents: status === 'operational' ? [] : [{ id: `${id}-i`, title: 'Degraded', status: 'investigating', impact: 'minor', startedAt: now(), duration: null, timeline: [] }],
  ...extra,
})
const voice = [
  svc('elevenlabs', 'ElevenLabs', 'operational', 99),
  svc('assemblyai', 'AssemblyAI', 'operational', 98),
  svc('fishaudio', 'Fish Audio', 'operational', 97),
]
const payload = (target: ReturnType<typeof svc>) => new Response(JSON.stringify({
  services: [target, ...voice.filter((v) => v.id !== target.id)],
  aiAnalysis: { [target.id]: [{ summary: 'S.', estimatedRecovery: '1h', affectedScope: ['API'], needsFallback: true, analyzedAt: now(), incidentId: `${target.id}-i` }] },
}), { status: 200, headers: { 'Content-Type': 'application/json' } })
const alternatives = (html: string) => {
  const start = html.indexOf('🔄 Alternatives')
  expect(start).toBeGreaterThan(-1)
  return html.slice(start, html.indexOf('class="faq', start))
}

describe('is-down.ts — Voice-tier capability gate (#1698)', () => {
  let fetchMock: ReturnType<typeof vi.spyOn>
  beforeEach(() => { fetchMock = spyFetchWithEmptyReportFeed() })
  afterEach(() => { fetchMock.mockRestore() })

  const comps = (down: string) => ['Chat (/api/v1/chat/completions)', 'TTS (/api/v1/audio/speech)', 'STT (/api/v1/audio/transcriptions)']
    .map((name) => ({ name, status: name.startsWith(down) ? 'degraded' : 'operational' }))

  it('an OpenRouter TTS-only outage recommends no speech-to-text service', async () => {
    fetchMock.mockResolvedValueOnce(payload(svc('openrouter', 'OpenRouter', 'degraded', 83, { components: comps('TTS') })))
    const alt = alternatives(await (await handler(req('openrouter'))).text())
    expect(alt).toContain('ElevenLabs')
    expect(alt).not.toContain('AssemblyAI')
  })

  it('a tagged voice service keeps its own tag (ElevenLabs down → Fish Audio)', async () => {
    fetchMock.mockResolvedValueOnce(payload(svc('elevenlabs', 'ElevenLabs', 'down', 80)))
    const alt = alternatives(await (await handler(req('elevenlabs'))).text())
    expect(alt).toContain('Fish Audio')
    expect(alt).not.toContain('AssemblyAI')
  })

  it('a tagged voice service uses its own tag, not its component names (Deepgram)', async () => {
    const deepgram = svc('deepgram', 'Deepgram', 'degraded', 85, { components: [{ name: 'Batch API', status: 'operational' }, { name: 'Streaming Transcription', status: 'degraded' }] })
    fetchMock.mockResolvedValueOnce(payload(deepgram))
    const alt = alternatives(await (await handler(req('deepgram'))).text())
    expect(alt).toContain('ElevenLabs')
    expect(alt).toContain('AssemblyAI')
  })

  it('an untagged routed audio outage keeps the whole Voice tier', async () => {
    const openai = svc('openai', 'OpenAI API', 'degraded', 90, { components: [{ name: 'Chat Completions', status: 'operational' }, { name: 'Audio', status: 'degraded' }] })
    fetchMock.mockResolvedValueOnce(payload(openai))
    const alt = alternatives(await (await handler(req('openai-api'))).text())
    expect(alt).toContain('ElevenLabs')
    expect(alt).toContain('AssemblyAI')
  })
})
