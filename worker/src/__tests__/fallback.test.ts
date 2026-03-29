import { describe, it, expect } from 'vitest'
import { getFallbacks, buildFallbackText, buildGroupedFallbackText, EXCLUDE_FALLBACK } from '../fallback'

const mockServices = [
  { id: 'claude', category: 'api', name: 'Claude API', status: 'operational', aiwatchScore: 85 },
  { id: 'openai', category: 'api', name: 'OpenAI API', status: 'degraded', aiwatchScore: 72 },
  { id: 'groq', category: 'api', name: 'Groq Cloud', status: 'operational', aiwatchScore: 93 },
  { id: 'together', category: 'api', name: 'Together AI', status: 'operational', aiwatchScore: 89 },
  { id: 'gemini', category: 'api', name: 'Gemini API', status: 'operational', aiwatchScore: 78 },
  { id: 'mistral', category: 'api', name: 'Mistral API', status: 'operational', aiwatchScore: 76 },
  { id: 'elevenlabs', category: 'api', name: 'ElevenLabs', status: 'operational', aiwatchScore: 80 },
  { id: 'claudeai', category: 'app', name: 'claude.ai', status: 'operational', aiwatchScore: 60 },
  { id: 'chatgpt', category: 'app', name: 'ChatGPT', status: 'down', aiwatchScore: 55 },
  { id: 'cursor', category: 'agent', name: 'Cursor', status: 'operational', aiwatchScore: 70 },
]

describe('getFallbacks', () => {
  it('returns top 2 by tier proximity then score (openai T1 → claude/gemini T1)', () => {
    const result = getFallbacks('openai', 'api', mockServices)
    expect(result).toEqual([
      { name: 'Claude API', score: 85 },
      { name: 'Gemini API', score: 78 },
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

  it('excludes EXCLUDE_FALLBACK services from candidates', () => {
    const services = [
      { id: 'openai', category: 'api', name: 'OpenAI API', status: 'down', aiwatchScore: 86 },
      { id: 'huggingface', category: 'api', name: 'Hugging Face', status: 'operational', aiwatchScore: 100 },
      { id: 'cohere', category: 'api', name: 'Cohere API', status: 'operational', aiwatchScore: 100 },
      { id: 'deepseek', category: 'api', name: 'DeepSeek API', status: 'operational', aiwatchScore: 100 },
    ]
    const result = getFallbacks('openai', 'api', services)
    expect(result).toHaveLength(2)
    expect(result.every(f => f.name !== 'Hugging Face')).toBe(true)
    expect(result[0].name).toBe('Cohere API')
    expect(result[1].name).toBe('DeepSeek API')
  })

  it('T2 service recommends T2 peers first', () => {
    const result = getFallbacks('mistral', 'api', mockServices)
    // mistral is T2, should prefer T2 peers (groq, together) over T1 (claude, gemini)
    expect(result[0].name).toBe('Groq Cloud')
    expect(result[1].name).toBe('Together AI')
  })

  it('only returns services from the same category', () => {
    const result = getFallbacks('chatgpt', 'app', mockServices)
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
      { id: 'a', category: 'app', name: 'A', status: 'down', aiwatchScore: 50 },
      { id: 'b', category: 'app', name: 'B', status: 'degraded', aiwatchScore: 40 },
    ]
    expect(getFallbacks('a', 'app', services)).toEqual([])
  })
})

describe('buildFallbackText', () => {
  it('formats fallback list with scores', () => {
    const text = buildFallbackText([
      { name: 'Groq Cloud', score: 93 },
      { name: 'Together AI', score: 89 },
    ])
    expect(text).toBe('👉 Suggested fallback: Groq Cloud (Score 93) · Together AI (Score 89)')
  })

  it('formats fallback without score', () => {
    const text = buildFallbackText([{ name: 'Claude API', score: null }])
    expect(text).toBe('👉 Suggested fallback: Claude API')
  })

  it('returns no-fallback message when empty', () => {
    const text = buildFallbackText([])
    expect(text).toBe('⚠️ No operational fallback available. Consider retry logic or caching.')
  })
})

describe('buildGroupedFallbackText', () => {
  const services = [
    { id: 'claude', category: 'api', name: 'Claude API', status: 'down', aiwatchScore: 85 },
    { id: 'claudeai', category: 'app', name: 'claude.ai', status: 'down', aiwatchScore: 60 },
    { id: 'claude-code', category: 'agent', name: 'Claude Code', status: 'down', aiwatchScore: 70 },
    { id: 'openai', category: 'api', name: 'OpenAI API', status: 'operational', aiwatchScore: 86 },
    { id: 'gemini', category: 'api', name: 'Gemini API', status: 'operational', aiwatchScore: 76 },
    { id: 'chatgpt', category: 'app', name: 'ChatGPT', status: 'operational', aiwatchScore: 67 },
    { id: 'characterai', category: 'app', name: 'Character.AI', status: 'operational', aiwatchScore: 79 },
    { id: 'cursor', category: 'agent', name: 'Cursor', status: 'operational', aiwatchScore: 75 },
    { id: 'github-copilot', category: 'agent', name: 'GitHub Copilot', status: 'operational', aiwatchScore: 80 },
  ]

  it('returns multi-category fallback for grouped incident', () => {
    const text = buildGroupedFallbackText(['claude', 'claudeai', 'claude-code'], services)
    expect(text).toContain('API:')
    expect(text).toContain('OpenAI API (Score 86)')
    expect(text).toContain('AI Apps:')
    expect(text).toContain('ChatGPT')
    expect(text).toContain('Coding Agent:')
    expect(text).toContain('GitHub Copilot')
  })

  it('deduplicates categories', () => {
    const text = buildGroupedFallbackText(['claude', 'claudeai'], services)
    const apiMatches = text.match(/API:/g)
    expect(apiMatches).toHaveLength(1)
  })

  it('skips excluded services', () => {
    const text = buildGroupedFallbackText(['characterai', 'claudeai'], services)
    // characterai is in EXCLUDE_FALLBACK, only app from claudeai
    expect(text).toContain('AI Apps:')
    expect(text).not.toContain('Character.AI:')
  })

  it('returns no-fallback message when all excluded', () => {
    const text = buildGroupedFallbackText(['elevenlabs', 'replicate'], services)
    expect(text).toContain('No operational fallback')
  })

  it('returns single category when only one affected', () => {
    const text = buildGroupedFallbackText(['claude'], services)
    expect(text).toContain('API:')
    expect(text).not.toContain('AI Apps:')
    expect(text).not.toContain('Coding Agent:')
  })
})

describe('EXCLUDE_FALLBACK', () => {
  it('contains voice and inference services', () => {
    expect(EXCLUDE_FALLBACK).toContain('elevenlabs')
    expect(EXCLUDE_FALLBACK).toContain('replicate')
    expect(EXCLUDE_FALLBACK).toContain('huggingface')
  })
})
