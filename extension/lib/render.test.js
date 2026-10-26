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
  monthLabel,
  monthlyRowText,
  splitSharedIncidents,
  sharedNoteText,
  baselineLines,
  analysisLines,
  reportFailureText,
} from './render.js'

describe('reportFailureText (#1773)', () => {
  it('names a revoked host permission instead of a network error', () => {
    expect(reportFailureText({ status: null, permitted: false })).toMatch(/Allow access/)
  })
  it('keeps the network-error text when the permission is held or could not be checked', () => {
    expect(reportFailureText({ status: null, permitted: true })).toBe('Network error — could not send report.')
    expect(reportFailureText({ status: null, permitted: null })).toBe('Network error — could not send report.')
  })
  it('maps a 429, a server error message, and a bare non-2xx', () => {
    expect(reportFailureText({ status: 429 })).toBe('Too many reports — please try again later.')
    expect(reportFailureText({ status: 400, error: 'Invalid category' })).toBe('Invalid category')
    expect(reportFailureText({ status: 500 })).toBe('Could not send report.')
  })
})

describe('monthly summary helpers (#1711)', () => {
  it('names the report month and rejects anything else', () => {
    expect(monthLabel('2026-09')).toBe('September 2026')
    expect(monthLabel('2026-13')).toBe('')
    expect(monthLabel(undefined)).toBe('')
  })
  it('renders a row in the report\'s units and drops missing figures', () => {
    expect(monthlyRowText({ incidents: 9, downtimeMin: 687 })).toBe('9 incidents · 11h 27m down')
    expect(monthlyRowText({ incidents: 1, downtimeMin: 60 })).toBe('1 incident · 1h down')
    expect(monthlyRowText({ incidents: 7, downtimeMin: null })).toBe('7 incidents')
    expect(monthlyRowText({ incidents: 0, downtimeMin: 0 })).toBe('0 incidents')
    expect(monthlyRowText({ incidents: null, downtimeMin: null })).toBe('')
  })
})

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

  // #1233 — `unknown` had no STATUS_RANK entry, so `worstStatus` skipped those services outright and an
  // all-unreadable board painted a GREEN toolbar badge. Ordering mirrors is-down-group.ts (#1164).
  it('ranks unknown above operational but below a CONFIRMED problem', () => {
    expect(worstStatus([{ status: 'operational' }, { status: 'unknown' }])).toBe('unknown')
    expect(worstStatus([{ status: 'unknown' }, { status: 'unknown' }])).toBe('unknown')
    expect(worstStatus([{ status: 'unknown' }, { status: 'degraded' }])).toBe('degraded')
    expect(worstStatus([{ status: 'unknown' }, { status: 'down' }])).toBe('down')
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

  // #1233 — the reported defect, in the surface users actually hit. With status.claude.com unreadable
  // on 2026-08-14 the extension recommended switching off Claude to ChatGPT / Grok / Junie / Codex.
  it('false for unknown — an unreadable source is not grounds to recommend abandoning the service', () => {
    expect(shouldShowFallback('unknown')).toBe(false)
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

describe('splitSharedIncidents (#1772)', () => {
  const inc = (id, status = 'investigating', extra = {}) => ({ id, title: `T ${id}`, status, impact: 'major', ...extra })
  const svc = (id, name, incidents) => ({ id, name, incidents })

  it('lists an incident on every card once, with the surfaces it affects in card order', () => {
    const out = splitSharedIncidents([
      svc('claude', 'Claude API', [inc('a')]),
      svc('claudeai', 'claude.ai', [inc('a')]),
      svc('claudecode', 'Claude Code', [inc('a')]),
    ])
    expect(out.shared).toEqual([{ incident: inc('a'), affects: ['Claude API', 'claude.ai', 'Claude Code'], ids: ['claude', 'claudeai', 'claudecode'] }])
    expect(out.ownBy).toEqual({ claude: [], claudeai: [], claudecode: [] })
    expect(out.sharedCountBy).toEqual({ claude: 1, claudeai: 1, claudecode: 1 })
  })

  it('keeps a one-card incident on its card and shares only what two or more cards list', () => {
    const out = splitSharedIncidents([
      svc('claude', 'Claude API', [inc('a')]),
      svc('claudeai', 'claude.ai', [inc('a'), inc('login')]),
      svc('claudecode', 'Claude Code', []),
    ])
    expect(out.shared.map((s) => [s.incident.id, s.affects])).toEqual([['a', ['Claude API', 'claude.ai']]])
    expect(out.ownBy.claudeai.map((i) => i.id)).toEqual(['login'])
    expect(out.ownBy.claude).toEqual([])
    expect(out.sharedCountBy).toEqual({ claude: 1, claudeai: 1, claudecode: 0 })
  })

  it('does not treat an id repeated on ONE card as shared', () => {
    const out = splitSharedIncidents([svc('claude', 'Claude API', [inc('a'), inc('a')]), svc('claudeai', 'claude.ai', [])])
    expect(out.shared).toEqual([])
    expect(out.ownBy.claude).toHaveLength(2)
  })

  it('orders shared incidents ongoing before monitoring, keeping first-seen order within each', () => {
    const cards = [inc('m1', 'monitoring'), inc('o1'), inc('m2', 'monitoring'), inc('o2', 'identified')]
    const out = splitSharedIncidents([svc('claude', 'Claude API', cards), svc('claudeai', 'claude.ai', cards)])
    expect(out.shared.map((s) => s.incident.id)).toEqual(['o1', 'o2', 'm1', 'm2'])
  })

  it('takes the AI summary from a later card when the first has none', () => {
    const out = splitSharedIncidents([
      svc('claude', 'Claude API', [inc('a')]),
      svc('claudeai', 'claude.ai', [inc('a', 'investigating', { aiSummary: 'S' })]),
    ])
    expect(out.shared[0].incident.aiSummary).toBe('S')
  })

  it('tolerates missing input', () => {
    expect(splitSharedIncidents(undefined)).toEqual({ shared: [], ownBy: {}, sharedCountBy: {} })
    expect(splitSharedIncidents([svc('claude', 'Claude API', undefined)]).ownBy).toEqual({ claude: [] })
  })

  it('pluralizes the card note', () => {
    expect(sharedNoteText(1)).toBe('1 shared incident ↑')
    expect(sharedNoteText(2)).toBe('2 shared incidents ↑')
  })
})

describe('baselineLines (#1772)', () => {
  const b = (n) => ({ n, medianMin: 64, p80Min: 161, since: '2026-07-22' })
  const analysed = { id: 'a', status: 'investigating', aiSummary: 'S' }

  it('shows nothing without an AI analysis', () => {
    expect(baselineLines({ id: 'a', status: 'monitoring' }, [{ name: 'Claude API', recoveryBaseline: b(48) }])).toEqual([])
  })

  it('one unnamed line for a single surface', () => {
    expect(baselineLines(analysed, [{ name: 'Claude API', recoveryBaseline: b(48) }])).toEqual([
      '📊 Past incidents on this service: median 1h 4m, 80% resolved within 2h 41m (based on 48 recorded incidents since 2026-07-22)',
    ])
  })

  it('names each surface of a shared incident and skips one without a baseline', () => {
    const lines = baselineLines(analysed, [
      { name: 'Claude API', recoveryBaseline: b(48) },
      { name: 'claude.ai', recoveryBaseline: null },
      { name: 'Claude Code', recoveryBaseline: b(50) },
    ])
    expect(lines).toHaveLength(2)
    expect(lines[0].startsWith('📊 Claude API — Past incidents')).toBe(true)
    expect(lines[1].startsWith('📊 Claude Code — Past incidents')).toBe(true)
  })

  it('names the surface on a shared incident even when only one of its surfaces has a baseline', () => {
    const lines = baselineLines(analysed, [{ name: 'Claude API', recoveryBaseline: b(48) }, { name: 'claude.ai', recoveryBaseline: null }])
    expect(lines).toHaveLength(1)
    expect(lines[0].startsWith('📊 Claude API — Past incidents')).toBe(true)
  })

  it('gives each surface its line once across the popup, on the first box that can carry it', () => {
    const api = { id: 'claude', name: 'Claude API', recoveryBaseline: b(48) }
    const app = { id: 'claudeai', name: 'claude.ai', recoveryBaseline: b(40) }
    const shown = new Set()
    expect(baselineLines({ id: 'x' }, [api, app], shown)).toEqual([])
    expect(baselineLines(analysed, [api, app], shown)).toHaveLength(2)
    expect(baselineLines(analysed, [app], shown)).toEqual([])
    expect([...shown]).toEqual(['claude', 'claudeai'])
  })
})

describe('recently resolved incidents (#1772)', () => {
  const inc = (id, status = 'investigating', extra = {}) => ({ id, title: `T ${id}`, status, impact: 'major', ...extra })

  it('are listed after the unresolved ones, shared across cards like the rest', () => {
    const out = splitSharedIncidents([
      { id: 'claude', name: 'Claude API', incidents: [inc('m', 'monitoring')], recentlyResolved: [inc('r', 'resolved')] },
      { id: 'claudeai', name: 'claude.ai', incidents: [inc('m', 'monitoring'), inc('a')], recentlyResolved: [inc('r', 'resolved')] },
      { id: 'claudecode', name: 'Claude Code', incidents: [inc('a')] },
    ])
    expect(out.shared.map((e) => e.incident.id)).toEqual(['a', 'm', 'r'])
  })

  it('a shared incident takes the analysis from whichever card carries it', () => {
    const ai = { summary: 'S', lines: [], analyzedAt: '', model: null }
    const out = splitSharedIncidents([
      { id: 'claude', name: 'Claude API', incidents: [inc('a')] },
      { id: 'claudeai', name: 'claude.ai', incidents: [inc('a', 'investigating', { ai })] },
    ])
    expect(out.shared[0].incident.ai).toBe(ai)
  })

  it('a card keeps its own resolved incident', () => {
    const out = splitSharedIncidents([{ id: 'claude', name: 'Claude API', incidents: [], recentlyResolved: [inc('r', 'resolved')] }])
    expect(out.ownBy.claude.map((i) => i.id)).toEqual(['r'])
  })
})

describe('analysisLines (#1772)', () => {
  const now = Date.parse('2026-06-30T02:00:00Z')
  const ai = { summary: 'S', lines: ['🎯 Predicted vs actual: est ~40m · actual 19m (faster than est.)', '📡 Scope: Claude API'], analyzedAt: '2026-06-30T01:50:00Z', model: 'Gemma' }

  it('renders the modal lines in its order, with recovered + updated times', () => {
    expect(analysisLines({ id: 'r', status: 'resolved', resolvedAt: '2026-06-30T01:55:00Z', ai }, now).map((l) => l.text)).toEqual([
      '🤖 S',
      '🎯 Predicted vs actual: est ~40m · actual 19m (faster than est.)',
      '📡 Scope: Claude API',
      '✅ Recovered: 5m ago',
      '🕐 Analysis updated 10m ago · Gemma',
    ])
  })

  it('falls back to aiSummary from a worker that sends no `ai`', () => {
    expect(analysisLines({ id: 'a', aiSummary: 'Old' }, now)).toEqual([{ kind: 'summary', text: '🤖 Old' }])
    expect(analysisLines({ id: 'a' }, now)).toEqual([])
  })
})
