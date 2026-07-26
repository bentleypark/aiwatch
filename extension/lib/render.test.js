import { describe, it, expect } from 'vitest'
import {
  worstStatus,
  badgeFor,
  statusLabel,
  categoryLabel,
  formatScore,
  formatUptime,
  formatRelTime,
  reportCountLabel,
  fallbackText,
  shouldShowFallback,
  isDownPath,
} from './render.js'

describe('worstStatus (#837)', () => {
  it('returns the worst across surfaces (down > degraded > operational)', () => {
    expect(worstStatus([{ status: 'operational' }, { status: 'degraded' }, { status: 'operational' }])).toBe('degraded')
    expect(worstStatus([{ status: 'operational' }, { status: 'down' }, { status: 'degraded' }])).toBe('down')
    expect(worstStatus([{ status: 'operational' }, { status: 'operational' }])).toBe('operational')
  })
  it('empty / non-array → unknown (distinguishes "no data" from all-operational)', () => {
    expect(worstStatus([])).toBe('unknown')
    expect(worstStatus(undefined)).toBe('unknown')
    expect(worstStatus(null)).toBe('unknown')
  })
  it('ignores entries with an unrecognized status but keeps the real worst', () => {
    expect(worstStatus([{ status: 'operational' }, { status: 'weird' }])).toBe('operational')
    expect(worstStatus([{ status: 'down' }, { status: 'weird' }])).toBe('down')
  })
})

describe('badgeFor (#837)', () => {
  it('maps each status to its color, always a "●" chip', () => {
    expect(badgeFor('operational')).toEqual({ color: '#16a34a', text: '●' })
    expect(badgeFor('degraded')).toEqual({ color: '#f59e0b', text: '●' })
    expect(badgeFor('down')).toEqual({ color: '#dc2626', text: '●' })
  })
  it('unknown / undefined status → grey chip', () => {
    expect(badgeFor('unknown').color).toBe('#6b7280')
    expect(badgeFor(undefined).color).toBe('#6b7280')
  })
})

describe('labels', () => {
  it('statusLabel', () => {
    expect(statusLabel('down')).toBe('Down')
    expect(statusLabel('unknown')).toBe('Unknown')
    expect(statusLabel('bogus')).toBe('Unknown')
  })
  it('categoryLabel', () => {
    expect(categoryLabel('outage')).toBe('Outage')
    expect(categoryLabel('login')).toBe('Login')
    expect(categoryLabel('bogus')).toBe('Other')
  })
})

describe('formatScore (#713 withheld semantics)', () => {
  it('null score → "—" (withheld, not 0)', () => {
    expect(formatScore(null)).toBe('—')
    expect(formatScore(null, 'good')).toBe('—')
  })
  it('score with grade → "66 · fair"; without grade → just the number', () => {
    expect(formatScore(66, 'fair')).toBe('66 · fair')
    expect(formatScore(80)).toBe('80')
    expect(formatScore(0, 'unstable')).toBe('0 · unstable') // 0 is a real score, not withheld
  })
})

describe('formatUptime', () => {
  it('formats to 2 decimals with %', () => {
    expect(formatUptime(99.87)).toBe('99.87%')
    expect(formatUptime(100)).toBe('100.00%')
    expect(formatUptime(0)).toBe('0.00%')
  })
  it('null / non-finite → "—" (no official uptime)', () => {
    expect(formatUptime(null)).toBe('—')
    expect(formatUptime(undefined)).toBe('—')
    expect(formatUptime(NaN)).toBe('—')
  })
})

describe('formatRelTime', () => {
  const now = 10_000_000
  it('buckets into just now / m / h / d', () => {
    expect(formatRelTime(now, now)).toBe('just now')
    expect(formatRelTime(now - 30_000, now)).toBe('just now')
    expect(formatRelTime(now - 3 * 60_000, now)).toBe('3m ago')
    expect(formatRelTime(now - 2 * 3_600_000, now)).toBe('2h ago')
    expect(formatRelTime(now - 25 * 3_600_000, now)).toBe('1d ago')
  })
  it('future ts clamps to "just now" (no negative)', () => {
    expect(formatRelTime(now + 5000, now)).toBe('just now')
  })
  it('non-finite ts → "" (no "NaNd ago")', () => {
    expect(formatRelTime(undefined, now)).toBe('')
    expect(formatRelTime(NaN, now)).toBe('')
  })
})

describe('reportCountLabel (pluralization)', () => {
  it('singular for 1, plural otherwise', () => {
    expect(reportCountLabel(1)).toBe('1 community report · last 24h')
    expect(reportCountLabel(3)).toBe('3 community reports · last 24h')
    expect(reportCountLabel(0)).toBe('0 community reports · last 24h')
  })
})

describe('fallbackText', () => {
  it('joins name (score), withheld score (null) → name only', () => {
    expect(fallbackText([{ name: 'OpenAI API', score: 91 }, { name: 'Gemini API', score: null }])).toBe('OpenAI API (91) · Gemini API')
  })
  it('empty / non-array → "" (caller omits the row)', () => {
    expect(fallbackText([])).toBe('')
    expect(fallbackText(undefined)).toBe('')
  })
})

describe('shouldShowFallback (status-gated, mirrors dashboard)', () => {
  it('true only for degraded/down', () => {
    expect(shouldShowFallback('down')).toBe(true)
    expect(shouldShowFallback('degraded')).toBe(true)
    expect(shouldShowFallback('operational')).toBe(false)
    expect(shouldShowFallback(null)).toBe(false)
    expect(shouldShowFallback(undefined)).toBe(false)
  })
})

describe('isDownPath (per-surface deep link)', () => {
  it('maps each Anthropic surface to its OWN is-down page', () => {
    expect(isDownPath('claude')).toBe('/is-claude-api-down')
    expect(isDownPath('claudeai')).toBe('/is-claude-ai-down')
    expect(isDownPath('claudecode')).toBe('/is-claude-code-down')
  })
  it('unknown id → null (caller renders a plain name, no link)', () => {
    expect(isDownPath('openai')).toBeNull()
    expect(isDownPath(undefined)).toBeNull()
  })
})
