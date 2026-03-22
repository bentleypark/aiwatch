import { describe, it, expect } from 'vitest'
import { getFallbacks, buildFallbackText, EXCLUDE_FALLBACK } from '../fallback'

const mockServices = [
  { id: 'claude', category: 'api', name: 'Claude API', status: 'operational', aiwatchScore: 85 },
  { id: 'openai', category: 'api', name: 'OpenAI API', status: 'degraded', aiwatchScore: 72 },
  { id: 'groq', category: 'api', name: 'Groq Cloud', status: 'operational', aiwatchScore: 93 },
  { id: 'together', category: 'api', name: 'Together AI', status: 'operational', aiwatchScore: 89 },
  { id: 'gemini', category: 'api', name: 'Gemini API', status: 'operational', aiwatchScore: 78 },
  { id: 'elevenlabs', category: 'api', name: 'ElevenLabs', status: 'operational', aiwatchScore: 80 },
  { id: 'claudeai', category: 'webapp', name: 'claude.ai', status: 'operational', aiwatchScore: 60 },
  { id: 'chatgpt', category: 'webapp', name: 'ChatGPT', status: 'down', aiwatchScore: 55 },
  { id: 'cursor', category: 'agent', name: 'Cursor', status: 'operational', aiwatchScore: 70 },
]

describe('getFallbacks', () => {
  it('returns top 2 operational services in same category sorted by score', () => {
    const result = getFallbacks('openai', 'api', mockServices)
    expect(result).toEqual([
      { name: 'Groq Cloud', score: 93 },
      { name: 'Together AI', score: 89 },
    ])
  })

  it('excludes the affected service itself', () => {
    const result = getFallbacks('claude', 'api', mockServices)
    expect(result.find(f => f.name === 'Claude API')).toBeUndefined()
  })

  it('excludes non-operational services', () => {
    const result = getFallbacks('claude', 'api', mockServices)
    expect(result.find(f => f.name === 'OpenAI API')).toBeUndefined()
  })

  it('returns empty for EXCLUDE_FALLBACK services', () => {
    expect(getFallbacks('elevenlabs', 'api', mockServices)).toEqual([])
    expect(getFallbacks('replicate', 'api', mockServices)).toEqual([])
    expect(getFallbacks('huggingface', 'api', mockServices)).toEqual([])
  })

  it('only returns services from the same category', () => {
    const result = getFallbacks('chatgpt', 'webapp', mockServices)
    expect(result).toEqual([{ name: 'claude.ai', score: 60 }])
  })

  it('handles null aiwatchScore', () => {
    const services = [
      { id: 'a', category: 'api', name: 'A', status: 'operational', aiwatchScore: null },
      { id: 'b', category: 'api', name: 'B', status: 'degraded', aiwatchScore: 50 },
    ]
    const result = getFallbacks('b', 'api', services)
    expect(result).toEqual([{ name: 'A', score: null }])
  })

  it('returns empty when all same-category services are down', () => {
    const services = [
      { id: 'a', category: 'webapp', name: 'A', status: 'down', aiwatchScore: 50 },
      { id: 'b', category: 'webapp', name: 'B', status: 'degraded', aiwatchScore: 40 },
    ]
    expect(getFallbacks('a', 'webapp', services)).toEqual([])
  })
})

describe('buildFallbackText', () => {
  it('formats fallback list with scores', () => {
    const text = buildFallbackText([
      { name: 'Groq Cloud', score: 93 },
      { name: 'Together AI', score: 89 },
    ])
    expect(text).toBe('👉 Suggested fallback: ★ Groq Cloud (Score 93) · Together AI (Score 89)')
  })

  it('formats fallback without score', () => {
    const text = buildFallbackText([{ name: 'Claude API', score: null }])
    expect(text).toBe('👉 Suggested fallback: ★ Claude API')
  })

  it('returns no-fallback message when empty', () => {
    const text = buildFallbackText([])
    expect(text).toBe('⚠️ No operational fallback available. Consider retry logic or caching.')
  })
})

describe('EXCLUDE_FALLBACK', () => {
  it('contains voice and inference services', () => {
    expect(EXCLUDE_FALLBACK).toContain('elevenlabs')
    expect(EXCLUDE_FALLBACK).toContain('replicate')
    expect(EXCLUDE_FALLBACK).toContain('huggingface')
  })
})
