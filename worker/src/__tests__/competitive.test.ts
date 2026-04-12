import { describe, it, expect } from 'vitest'
import { matchesCompetitiveKeywords } from '../reddit'
import { formatGitHubAlert } from '../competitive'

describe('matchesCompetitiveKeywords', () => {
  it('matches strong competitive keywords', () => {
    expect(matchesCompetitiveKeywords('Best AI status monitor tools')).toBe(true)
    expect(matchesCompetitiveKeywords('New status page aggregator')).toBe(true)
    expect(matchesCompetitiveKeywords('Uptime dashboard for LLMs')).toBe(true)
    expect(matchesCompetitiveKeywords('API status tracking service')).toBe(true)
    expect(matchesCompetitiveKeywords('LLM status monitoring')).toBe(true)
  })

  it('matches weak competitive keywords (tool names)', () => {
    expect(matchesCompetitiveKeywords('down detector alternative for AI')).toBe(true)
    expect(matchesCompetitiveKeywords('statusgator vs isdown for monitoring')).toBe(true)
    expect(matchesCompetitiveKeywords('Anyone use statuspage for API status?')).toBe(true)
  })

  it('matches context + AI keywords', () => {
    expect(matchesCompetitiveKeywords('AI monitoring dashboard with real-time alerts')).toBe(true)
    expect(matchesCompetitiveKeywords('Track OpenAI API alerts and notifications')).toBe(true)
  })

  it('rejects unrelated posts', () => {
    expect(matchesCompetitiveKeywords('How to fine-tune GPT-4')).toBe(false)
    expect(matchesCompetitiveKeywords('Best GPU for local LLM inference')).toBe(false)
    expect(matchesCompetitiveKeywords('Python tutorial for beginners')).toBe(false)
    expect(matchesCompetitiveKeywords('DevOps salary survey 2026')).toBe(false)
  })

  it('rejects generic monitoring without AI context', () => {
    expect(matchesCompetitiveKeywords('Server monitoring with Grafana')).toBe(false)
    expect(matchesCompetitiveKeywords('Kubernetes pod health checks')).toBe(false)
  })
})

describe('formatGitHubAlert', () => {
  it('formats repo alert for Discord', () => {
    const alert = {
      key: 'github:seen:user/ai-status-tool',
      repo: {
        fullName: 'user/ai-status-tool',
        description: 'Real-time AI API status monitor',
        stars: 42,
        url: 'https://github.com/user/ai-status-tool',
        createdAt: '2026-04-08T10:00:00Z',
      },
    }
    const result = formatGitHubAlert(alert)
    expect(result.title).toBe('🔍 New Competitor Repo')
    expect(result.description).toContain('user/ai-status-tool')
    expect(result.description).toContain('42')
    expect(result.description).toContain('2026-04-08')
    expect(result.color).toBe(0x8b949e)
    expect(result.url).toBe('https://github.com/user/ai-status-tool')
  })
})
