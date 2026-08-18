import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { statusVerdict, isAffectedStatus, isHealthyStatus, isUnreadableStatus, normalizeCachedService } from '../status-verdict'
import { renderStatuslinePreset, renderStatuslineDownList, renderStatuslineBrief, STATUSLINE_PRESETS, type BriefService } from '../statusline'
import { buildDailySummary } from '../daily-summary'
import { buildGroupedFallbackText } from '../fallback'
import { badgeStatusColor } from '../badge'
import { isReadSuspect } from '../services'
import { shouldSurfaceReports, REPORT_DISPLAY_MIN } from '../report'
import { withdrawalHold } from '../withdrawn'
import { buildExtClaudePayload, type ScoredService } from '../ext-claude'
import type { ServiceStatus } from '../types'

// #1233 — ONE invariant, across every surface that renders a service's status:
//
//   a service whose status source AIWatch could not read (`unknown`) is not published as an OUTAGE,
//   and is not published as HEALTHY either.
//
// This file exists because the type checker cannot enforce it: widening a union does not break
// `x === 'degraded'`, only narrowing does, so the comparison sites had to be enumerated by hand. The
// measurement behind that claim lives in `worker/src/status-verdict.ts`'s header. The compile-time half
// of the guard — that module's `never` check — only tells you a member was ADDED, does not route you to
// the consumers, and reaches nothing outside `worker/src/**`.
//
// This file covers the surfaces reachable from a worker unit test; the others are pinned next to their
// own code.

const svc = (over: Partial<ServiceStatus> & { id: string }): ServiceStatus => ({
  name: over.id, provider: 'p', category: 'api', status: 'operational',
  latency: null, uptime30d: null, lastChecked: new Date(0).toISOString(), incidents: [],
  ...over,
})

const UNREADABLE = svc({ id: 'claude', name: 'Claude API', status: 'unknown', sourceUnknown: true })

describe('#1233 the verdict primitive', () => {
  it('answers exactly one of affected / healthy / unreadable for every union member', () => {
    for (const status of ['operational', 'degraded', 'down', 'unknown'] as const) {
      const v = statusVerdict(status)
      expect([v.affected, v.healthy, v.unreadable].filter(Boolean), status).toHaveLength(1)
    }
  })

  it('unknown is NEITHER affected nor healthy — the distinction `!== operational` collapsed', () => {
    expect(isAffectedStatus('unknown')).toBe(false)
    expect(isHealthyStatus('unknown')).toBe(false)
    expect(isUnreadableStatus('unknown')).toBe(true)
    // The control: the two states that ARE claims still read as claims.
    expect(isAffectedStatus('degraded')).toBe(true)
    expect(isAffectedStatus('down')).toBe(true)
    expect(isHealthyStatus('operational')).toBe(true)
  })

  it('an unrecognised value (an older cached payload) answers unreadable, and does not throw', () => {
    // Fails SAFE in both directions: it never invents an outage and never claims health.
    const v = statusVerdict('something-we-shipped-later' as ServiceStatus['status'])
    expect(v).toEqual({ affected: false, healthy: false, unreadable: true })
  })
})

describe('#1233 transitional — a payload cached before the change', () => {
  const st = (svc: Parameters<typeof normalizeCachedService>[0]) => normalizeCachedService(svc).status

  it('normalises the legacy `degraded` + sourceUnknown pair to unknown', () => {
    expect(st({ status: 'degraded', sourceUnknown: true })).toBe('unknown')
  })

  it('leaves a CORROBORATED fetch-failure degraded alone — the probe is independent evidence', () => {
    expect(st({ status: 'degraded', sourceUnknown: true, probeContradicted: true })).toBe('degraded')
  })

  it('is a no-op on a current payload and on a real outage', () => {
    expect(st({ status: 'unknown', sourceUnknown: true })).toBe('unknown')
    expect(st({ status: 'degraded' })).toBe('degraded')
    expect(st({ status: 'down', sourceUnknown: true })).toBe('down')
  })

  it('preserves every OTHER field — it returns the record, not a bare status', () => {
    const legacy = svc({ id: 'claude', name: 'Claude API', status: 'degraded', sourceUnknown: true, uptime30d: 99.1 })
    const out = normalizeCachedService(legacy)
    expect(out).toEqual({ ...legacy, status: 'unknown' })
  })
})

describe('#1233 statusline — the surface the plugin monitor polls', () => {
  const services = [
    { id: 'claude', name: 'Claude API', status: 'unknown' as const },
    { id: 'openai', name: 'OpenAI API', status: 'operational' as const },
  ]

  // #1238 — the #1233 carve-out is gone: this wire now publishes `unknown` like every other surface.
  // The monitor's transitions off it are pinned against the real script in scripts/plugin-monitor.test.mjs.
  it('lists an unreadable source as `unknown`, not as an outage word', () => {
    expect(renderStatuslineDownList(services)).toBe('unknown\tClaude API')
  })

  it('control: a real outage and a healthy board are unchanged', () => {
    expect(renderStatuslineDownList([{ id: 'claude', name: 'Claude API', status: 'down' }]))
      .toBe('down\tClaude API')
    expect(renderStatuslineDownList([{ id: 'openai', name: 'OpenAI API', status: 'operational' }])).toBe('')
  })

  // #1238 — a value OUTSIDE the union reaches this renderer from a payload written by another
  // deploy, and `statusVerdict` answers `unreadable` for it, so the filter admits it. Emitted raw it
  // would become `🔴 Claude API is something-we-shipped-later` in the plugin monitor: a false outage
  // off a source we could not read, which is the whole defect class. The mapping is what makes the
  // wire contract `unknown` ⇔ unreadable TOTAL rather than true of the four known members.
  it('normalises any unreadable status — including one outside the union — to `unknown`', () => {
    const future = [{ id: 'claude', name: 'Claude API', status: 'something-we-shipped-later' as ServiceStatus['status'] }]
    expect(renderStatuslineDownList(future)).toBe('unknown\tClaude API')
  })

  // #1238 — the consumer hand-copies this word across a boundary nothing else crosses: the shell
  // monitor ships in its own bundle, is not type-checked, and imports nothing from here. If the wire
  // word for an unreadable source ever changes, the script's `awk` falls through to its "anything
  // else is an outage" branch and starts announcing 🔴 off a source we could not read — the exact
  // defect this issue fixed, reintroduced silently. So take the word from the renderer, not from a
  // literal, and require the script to be matching THAT.
  it('the shell monitor special-cases exactly the word this endpoint emits for an unreadable source', () => {
    // Its own fixture, not the shared `services`: prepending an affected service to that array — an
    // ordinary edit for the sibling tests — would silently make `word` `'down'` and fail here with a
    // message about a string that was never meant to be in the script.
    const [word] = renderStatuslineDownList([{ id: 'claude', name: 'Claude API', status: 'unknown' }]).split('\t')
    const script = readFileSync(new URL('../../../plugin/aiwatch/bin/aiwatch-monitor.sh', import.meta.url), 'utf8')
    // Comments stripped first — the script's header DISCUSSES `unknown` at length, so a substring
    // search over the whole file would be satisfied by prose after the code stopped matching.
    const code = script.split('\n').map((l) => l.replace(/^\s*#.*$/, '')).join('\n')
    expect(code).toContain(`$1 != "${word}"`)
    expect(code).toContain(`$1 == "${word}"`)
  })

  it('no preset paints an unreadable source as an outage, or as all-clear', () => {
    // Both halves matter and they are different failures. 🔴/🟢 is the false CLAIM; an empty line is the
    // false SILENCE — #1227 settled that one for the no-snapshot case ("silence reads as 'nothing
    // wrong', which is the very claim we cannot make"), and a per-service unreadable source is the same
    // question one level down. Asserted on emptiness rather than on a specific glyph because each preset
    // keeps its own idiom: five use ⚪, `full_list` uses the letter marker `?·` alongside its `X·`/`!·`,
    // and `compact_badge` reports a COUNT rather than names — so neither a glyph nor the service name is
    // common to all six.
    for (const preset of STATUSLINE_PRESETS) {
      const out = renderStatuslinePreset(preset, services)
      expect(out, preset).not.toContain('🔴')
      expect(out, preset).not.toContain('🟢')
      expect(out, preset).not.toBe('')
    }
  })

  it('control: with nothing to report, the silent presets are silent again', () => {
    const healthy = [{ id: 'openai', name: 'OpenAI API', status: 'operational' as const }]
    expect(renderStatuslinePreset('degraded_only', healthy)).toBe('')
    expect(renderStatuslinePreset('compact_badge', healthy)).toBe('')
    expect(renderStatuslinePreset('branded', healthy)).toContain('🟢')
  })

  it('the brief does not assert "all operational" while a source is unreadable', () => {
    const brief = renderStatuslineBrief(services as unknown as BriefService[])
    expect(brief).not.toContain('all monitored AI services operational')
    expect(brief).toContain('Claude API')
    // ...and it does not call it an issue either.
    expect(brief).not.toContain('active AI service issues')
  })

  it('control: with everything readable and healthy, the all-clear still fires', () => {
    const brief = renderStatuslineBrief([{ id: 'openai', name: 'OpenAI API', status: 'operational' }] as unknown as BriefService[])
    expect(brief).toBe('AIWatch: all monitored AI services operational ✅')
  })
})

describe('#1233 fallback — never tell users to abandon a service we could not read', () => {
  // The gate is on the ANCHOR, not on `getFallbacks`. `getFallbacks(sourceId, …)` is a pure "who else in
  // this tier is healthy" query and is called by surfaces that decide separately whether to show it (the
  // is-down page renders an alternatives section on every view as SEO content, outage or not). What must
  // never happen is an unreadable source ANCHORING a recommendation — the Discord alert path.
  const pool = (claudeStatus: string) => [
    { id: 'claude', name: 'Claude API', category: 'api', status: claudeStatus, aiwatchScore: 95 },
    { id: 'openai', name: 'OpenAI API', category: 'api', status: 'operational', aiwatchScore: 91 },
    { id: 'gemini', name: 'Gemini API', category: 'api', status: 'operational', aiwatchScore: 90 },
  ]

  it('an unreadable source anchors no grouped recommendation', () => {
    // The reported production behaviour: `status.claude.com` unreadable → "switch to ChatGPT / Grok".
    expect(buildGroupedFallbackText(['claude'], pool('unknown'))).toBe('')
  })

  it('control: a CONFIRMED outage still anchors one', () => {
    expect(buildGroupedFallbackText(['claude'], pool('down'))).not.toBe('')
  })
})

describe('#1233 extension projection — the gate must be server-side', () => {
  // The extension's own `shouldShowFallback` also excludes `unknown` now, but that fix only reaches a
  // copy Chrome has updated. An already-installed extension keeps its old code (the same reason
  // `IS_DOWN_SLUG` carries a stale-copy note), so the version that produced the reported behaviour
  // would keep rendering "switch to X" until its user happened to update. An empty array renders
  // nothing in EVERY version, so withholding it here is what actually reaches them.
  const scored = (over: Partial<ServiceStatus> & { id: string }, score: number): ScoredService =>
    ({ ...svc(over), aiwatchScore: score, scoreGrade: null })
  const pool = (claudeStatus: ServiceStatus['status']): ScoredService[] => [
    scored({ id: 'claude', name: 'Claude API', status: claudeStatus }, 95),
    scored({ id: 'openai', name: 'OpenAI API' }, 91),
    scored({ id: 'gemini', name: 'Gemini API' }, 90),
  ]

  const claudeIn = (status: ServiceStatus['status']) =>
    buildExtClaudePayload(pool(status), null).services.find((s) => s.id === 'claude')

  it('carries the unknown VALUE (so the client can render the neutral state at all)', () => {
    expect(claudeIn('unknown')?.status).toBe('unknown')
  })

  it('but ships no fallback recommendation for it', () => {
    expect(claudeIn('unknown')?.fallback).toEqual([])
  })

  it('control: a CONFIRMED outage still ships its recommendation', () => {
    expect(claudeIn('down')?.fallback?.length).toBeGreaterThan(0)
  })
})

describe('#1233 daily summary — counted, but not as an issue', () => {
  const summary = buildDailySummary({
    services: [UNREADABLE, svc({ id: 'openai', name: 'OpenAI API' })],
    aiUsage: null, latencySnapshots: [], incidentCountToday: { newCount: 0, resolvedCount: 0 },
    redditCount: 0,
  } as Parameters<typeof buildDailySummary>[0])

  it('discloses the unreadable source in the overview line', () => {
    expect(summary).toContain('1 source unreadable')
  })

  it('does not list it under Active Issues', () => {
    expect(summary).not.toContain('Active Issues')
  })
})

describe('#1233 the invariant that keeps `unknown` out of every incident-scoped surface', () => {
  // Load-bearing, and the reason several modules carry NO `unknown` branch: an unreadable source never
  // carries an incident. `base.incidents = []` in `services.ts` and every path that publishes `unknown`
  // either spreads `base` or sets `incidents: []` itself.
  //
  // Everything incident-scoped depends on this: the X tweet drafts, the reply draft, `fallbackLine`'s
  // feed item, the region and calendar fallbacks. A review pass once added defensive `unknown` arms to
  // the drafts, justified by a reachability claim that was FALSE — and the group version of that
  // defence was itself wrong (it read one member's status while speaking for the whole family). The
  // arms were removed and replaced by this test, which is the honest form of the same protection: if a
  // future leg ever preserves incidents on an unreadable read, THIS fails, and handling the
  // incident-scoped surfaces becomes that change's explicit problem instead of a silent one.
  it('an unreadable source publishes NO incidents, through the real fetchAllServices', async () => {
    const { fetchAllServices } = await import('../services')
    const { stubFetchFailingClaudePage, mockKV, seededTracking } = await import('./helpers/unreadable-source')
    stubFetchFailingClaudePage()
    const { raw } = await fetchAllServices(mockKV(seededTracking(['claude'])) as unknown as KVNamespace)
    const claude = raw.find((s) => s.id === 'claude')
    expect(claude?.status).toBe('unknown')
    expect(claude?.incidents).toEqual([])
  }, 30_000)

  it('...and no service in the roster is ever `unknown` WITH incidents', async () => {
    const { fetchAllServices } = await import('../services')
    const { stubFetchFailingClaudePage, mockKV, seededTracking } = await import('./helpers/unreadable-source')
    stubFetchFailingClaudePage()
    const { raw } = await fetchAllServices(mockKV(seededTracking(['claude'])) as unknown as KVNamespace)
    const violations = raw.filter((s) => s.status === 'unknown' && (s.incidents ?? []).length > 0)
    expect(violations.map((s) => s.id)).toEqual([])
  }, 30_000)
})

describe('#1233 crowd reports — an unreadable source is the ABSENCE of a signal, not one', () => {
  it('does not treat it as an official problem: it must earn display with independent corroboration', () => {
    // Before, `!== 'operational'` waved it straight through, so one report with no probe evidence
    // surfaced a public "users are reporting issues" claim built on a page we had failed to read.
    expect(shouldSurfaceReports({ status: 'unknown', reportCount: 1 })).toBe(false)
    expect(shouldSurfaceReports({ status: 'unknown', probeSpike: true, reportCount: REPORT_DISPLAY_MIN })).toBe(true)
  })

  it('control: a confirmed outage still surfaces on the official-signal path alone', () => {
    expect(shouldSurfaceReports({ status: 'degraded', reportCount: 1 })).toBe(true)
    expect(shouldSurfaceReports({ status: 'operational', reportCount: 1 })).toBe(false)
  })
})

describe('#1233 withdrawal hold — reads the status, not only the flag', () => {
  const base = (over: Partial<ServiceStatus>) => svc({ id: 'mistral', ...over })

  it('holds on an unreadable source identified by STATUS alone', () => {
    // The arm exists to survive the flag being dropped; with the flag present it is a no-op, which is
    // why removing it was green. Asserted without `sourceUnknown` so only the status can satisfy it.
    expect(withdrawalHold('aud-1', base({ status: 'unknown' }), new Set())).toBe('source-unreadable')
  })

  it('control: a clean operational read with no incidents does not hold', () => {
    expect(withdrawalHold('aud-1', base({ status: 'operational' }), new Set())).toBeNull()
  })
})

describe('#1233 statusline — the MIXED state, which is what a real event looks like', () => {
  const mixed = [
    { id: 'openai', name: 'OpenAI API', status: 'down' as const },
    { id: 'claude', name: 'Claude API', status: 'unknown' as const },
    { id: 'gemini', name: 'Gemini API', status: 'operational' as const },
  ]

  it('lists confirmed outages BEFORE unreadable sources — the 3-item cap belongs to real outages', () => {
    expect(renderStatuslinePreset('degraded_only', mixed)).toBe('🔴 OpenAI API ⚪ Claude API')
  })

  it('full_list marks them apart: X down, ! degraded, ? unreadable', () => {
    expect(renderStatuslinePreset('full_list', mixed)).toBe('X·OpenAI API | ?·Claude API')
  })

  it('compact_badge keeps the two counts separate — they are different claims', () => {
    expect(renderStatuslinePreset('compact_badge', mixed)).toBe('🔴 1 AI services · ⚪ 1 unknown')
  })

  it('the brief lists the outage AND still discloses the unreadable source', () => {
    const brief = renderStatuslineBrief(mixed as unknown as BriefService[])
    expect(brief).toContain('active AI service issues')
    expect(brief).toContain('OpenAI API')
    expect(brief).toContain('Status source unreadable for Claude API')
  })
})

describe('#1233 badge — the most durable thing AIWatch publishes', () => {
  it('paints an unreadable source neutral grey, not the red the else-branch used to give it', () => {
    expect(badgeStatusColor('unknown')).toBe('#8b949e')
    // Controls: the real verdicts keep their colors.
    expect(badgeStatusColor('down')).toBe('#f85149')
    expect(badgeStatusColor('degraded')).toBe('#d29922')
    expect(badgeStatusColor('operational')).toBe('#3fb950')
  })
})

describe('#1233 isReadSuspect — the cross-validation + platform-quorum input', () => {
  it('catches the unreadable source, which is what the fetch-failure paths now publish', () => {
    expect(isReadSuspect({ status: 'unknown', incidents: [] })).toBe(true)
  })

  it('still catches a degraded page that names no incident — the pre-#1233 meaning', () => {
    // Without this arm `detectPlatformOutage`'s quorum would count zero forever, silently: its comment
    // said "degraded with no incidents = likely fetch failure" while no fetch failure produced
    // `degraded` any more. Nothing would have failed.
    expect(isReadSuspect({ status: 'degraded', incidents: [] })).toBe(true)
  })

  it('excludes a status backed by a named incident, and excludes operational', () => {
    const inc = [{ id: 'i1', title: 't', status: 'investigating' as const, impact: null, startedAt: '', duration: null, timeline: [] }]
    expect(isReadSuspect({ status: 'degraded', incidents: inc })).toBe(false)
    expect(isReadSuspect({ status: 'operational', incidents: [] })).toBe(false)
  })
})
