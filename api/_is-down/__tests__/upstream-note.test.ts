import { describe, it, expect, vi } from 'vitest'
import { buildUpstreamNote, type UpstreamLinkLike } from '../upstream-note'
import { renderUpstreamNote } from '../html-template'

// The real 2026-07-17 payload, read off /api/status/cached: claude opened 'Elevated errors on Sonnet 5
// and Haiku 4.5' at 06:47:54.909Z and cursor filed 'Investigating Anthropic degradation' at
// 07:17:15.075Z — a 29m20s lead. (An earlier revision of this file carried 07:20:54.909Z, which was
// back-computed to make the lead a round 33m and then labelled "verified live". It shared claude's
// .909 milliseconds, which is the tell. Fixtures are read off the wire or they are not real.)
const CURSOR_LINK: UpstreamLinkLike = {
  id: 'cursor',
  incidentTitle: 'Investigating Anthropic degradation',
  startedAt: '2026-07-17T07:17:15.075Z',
  upstream: [{
    id: 'claude',
    name: 'Claude API',
    status: 'degraded',
    incidentTitle: 'Elevated errors on Sonnet 5 and Haiku 4.5',
    startedAt: '2026-07-17T06:47:54.909Z',
  }],
}

describe('buildUpstreamNote (#1053)', () => {
  it('builds the note, carrying the dependent claim + upstream detail + lead time', () => {
    expect(buildUpstreamNote([CURSOR_LINK], 'cursor')).toEqual({
      fromId: 'cursor',
      incidentTitle: 'Investigating Anthropic degradation',
      upstream: [{
        id: 'claude',
        name: 'Claude API',
        status: 'degraded',
        incidentTitle: 'Elevated errors on Sonnet 5 and Haiku 4.5',
        startedAt: '2026-07-17T06:47:54.909Z',
        href: '/is-claude-down',
        leadMinutes: 29,
      }],
    })
  })

  it('returns null for a service the worker made no claim about', () => {
    expect(buildUpstreamNote([CURSOR_LINK], 'windsurf')).toBeNull()
  })

  it('DEPLOY SKEW: a worker predating #1053 sends no upstreamLinks key → null, no section', () => {
    // Vercel ships this Edge function on merge; the worker deploy is manual and batched, so this
    // window is hours-to-days wide. It must render nothing rather than throw.
    expect(buildUpstreamNote(undefined, 'cursor')).toBeNull()
  })

  it('defensively returns null for a link that names no upstream', () => {
    // The worker filters `upstream.length === 0` out, but this crosses a network boundary — the
    // invariant is not ours to assume.
    expect(buildUpstreamNote([{ ...CURSOR_LINK, upstream: [] }], 'cursor')).toBeNull()
  })

  it('has no href for an upstream with no is-down page (bedrock/azureopenai, #263)', () => {
    const viaBedrock = { ...CURSOR_LINK, upstream: [{ ...CURSOR_LINK.upstream[0], id: 'bedrock', name: 'Amazon Bedrock' }] }
    expect(buildUpstreamNote([viaBedrock], 'cursor')!.upstream[0].href).toBeNull()
  })

  it.each([
    ['unparseable upstream stamp', { startedAt: 'nonsense' }],
    ['upstream that started AFTER the claim (contradicts gate 5 → withhold, never print "-33m")',
      { startedAt: '2026-07-17T09:00:00Z' }],
  ])('leadMinutes is null for an %s', (_label, patch) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const link = { ...CURSOR_LINK, upstream: [{ ...CURSOR_LINK.upstream[0], ...patch }] }
      expect(buildUpstreamNote([link], 'cursor')!.upstream[0].leadMinutes).toBeNull()
    } finally {
      warn.mockRestore()
    }
  })

  it('a NEGATIVE lead warns — the two null causes render alike, so only the log separates them', () => {
    // Unparseable = missing provider data (benign, stay quiet). Negative = the worker's gate 5 says
    // this is impossible, so it is a proven bug. The docstring says folding a bug into the benign path
    // makes it permanently invisible; without this assertion, deleting the warn does exactly that and
    // stays green.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const after = { ...CURSOR_LINK, upstream: [{ ...CURSOR_LINK.upstream[0], startedAt: '2026-07-17T09:00:00Z' }] }
      buildUpstreamNote([after], 'cursor')
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('gate 5 contract violated'), expect.anything(), expect.anything())
    } finally {
      warn.mockRestore()
    }
  })

  it('an UNPARSEABLE stamp does NOT warn (it is expected provider data, not a bug)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      buildUpstreamNote([{ ...CURSOR_LINK, upstream: [{ ...CURSOR_LINK.upstream[0], startedAt: 'nonsense' }] }], 'cursor')
      expect(warn).not.toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
  })

  it('keeps every named upstream when several are declared', () => {
    const multi = {
      ...CURSOR_LINK,
      upstream: [
        CURSOR_LINK.upstream[0],
        { id: 'openai', name: 'OpenAI API', status: 'down', incidentTitle: 'Elevated error rates', startedAt: '2026-07-17T07:00:00Z' },
      ],
    }
    const note = buildUpstreamNote([multi], 'cursor')!
    expect(note.upstream.map((u) => u.id)).toEqual(['claude', 'openai'])
    expect(note.upstream[1].leadMinutes).toBe(17) // each row carries its OWN lead, not a shared one
  })
})

describe('renderUpstreamNote (#1053) — a card, reporting the dependent\'s claim', () => {
  const note = buildUpstreamNote([CURSOR_LINK], 'cursor')!

  it('renders a card section, NOT the one-line meta paragraph the supply-chain note uses', () => {
    // #574's `<p class="meta">` was the nearest precedent but has never been VERIFIED to render in
    // production (verify-blocked on a real AWS regional outage — nobody watched), and a lone sentence
    // above the component breakdown was too easy to miss. Matches renderComponents' card convention.
    const html = renderUpstreamNote(note, 'Cursor')
    expect(html).toContain('<div class="card"')
    expect(html).toContain('Related Upstream Incident')
    expect(html).not.toContain('<p class="meta"')
  })

  it('scopes the claim to the dependent\'s OWN incident, and never asserts a cause', () => {
    const html = renderUpstreamNote(note, 'Cursor')
    expect(html).toContain('Cursor&rsquo;s status page attributes')
    expect(html).toContain('Investigating Anthropic degradation') // the claim's scope, named
    // the ethic: we never upgrade the dependent's claim into our own causal assertion
    expect(html.toLowerCase()).not.toContain('because')
    expect(html.toLowerCase()).not.toContain('caused by')
  })

  it('shows the upstream service, its status, its incident and the lead time', () => {
    const html = renderUpstreamNote(note, 'Cursor')
    expect(html).toContain('Claude API')
    expect(html).toContain('Degraded')
    expect(html).toContain('Elevated errors on Sonnet 5 and Haiku 4.5')
    expect(html).toContain('29m before Cursor&rsquo;s report')
  })

  it('omits the lead-time clause entirely when it could not be computed', () => {
    const noLead = buildUpstreamNote([{ ...CURSOR_LINK, upstream: [{ ...CURSOR_LINK.upstream[0], startedAt: 'nonsense' }] }], 'cursor')!
    expect(renderUpstreamNote(noLead, 'Cursor')).not.toContain('before Cursor')
  })

  it('tags the link with the EXISTING from/to GA params (no new listener branch needed)', () => {
    const html = renderUpstreamNote(note, 'Cursor')
    expect(html).toContain('data-ga="upstream_link"')
    expect(html).toContain('data-ga-loc="is_down_page"')
    expect(html).toContain('data-ga-from="cursor"')
    expect(html).toContain('data-ga-to="claude"')
    // must NOT reuse the #842 referral beacon's event name — that beacon counts traffic LEAVING
    // AIWatch for a sponsor-evidence figure; this link stays on AIWatch and would inflate it.
    expect(html).not.toContain('outbound_fallback_click')
  })

  it('renders nothing when there is no note', () => {
    expect(renderUpstreamNote(null, 'Cursor')).toBe('')
    expect(renderUpstreamNote(undefined, 'Cursor')).toBe('')
  })

  it('escapes the upstream incident title (it is provider-authored text)', () => {
    const evil = buildUpstreamNote([{
      ...CURSOR_LINK,
      upstream: [{ ...CURSOR_LINK.upstream[0], incidentTitle: '<img src=x onerror=alert(1)>' }],
    }], 'cursor')!
    const html = renderUpstreamNote(evil, 'Cursor')
    expect(html).not.toContain('<img')
    expect(html).toContain('&lt;img')
  })

  it('escapes the DEPENDENT incident title too (also provider-authored)', () => {
    const evil = buildUpstreamNote([{ ...CURSOR_LINK, incidentTitle: '<script>alert(1)</script>' }], 'cursor')!
    const html = renderUpstreamNote(evil, 'Cursor')
    expect(html).not.toContain('<script>alert(1)</script>')
    expect(html).toContain('&lt;script&gt;')
  })

  it('renders EVERY named upstream, each with its own title, status and lead', () => {
    // No arity withholding: each title sits beside its own upstream's name, so nothing is
    // misattributed. Also the only place the `down` branch of statusColor/statusLabel renders.
    const multi = buildUpstreamNote([{
      ...CURSOR_LINK,
      upstream: [
        CURSOR_LINK.upstream[0],
        { id: 'openai', name: 'OpenAI API', status: 'down', incidentTitle: 'Elevated error rates', startedAt: '2026-07-17T07:00:00Z' },
      ],
    }], 'cursor')!
    const html = renderUpstreamNote(multi, 'Cursor')
    expect(html).toContain('Claude API')
    expect(html).toContain('OpenAI API')
    expect(html).toContain('Elevated errors on Sonnet 5 and Haiku 4.5')
    expect(html).toContain('Elevated error rates')
    expect(html).toContain('Degraded Performance') // claude
    expect(html).toContain('Down')                 // openai. NOTE 'Down' is statusLabel's DEFAULT, so
                                                   // this pins "down renders as Down", not a branch
    expect(html).toContain('29m before Cursor&rsquo;s report') // each row carries its OWN lead
    expect(html).toContain('17m before Cursor&rsquo;s report')
  })

  it.each([
    [0, 'less than a minute'],
    [36, '36m'],
    [60, '1h'],
    [90, '1h 30m'],
    [1439, '23h 59m'],
    [1440, '24h'],     // gate 5's CAUSE_WINDOW_MS caps the lead here — the largest emittable value
  ])('formats a %s-minute lead as "%s"', (mins, label) => {
    const started = new Date(Date.parse(CURSOR_LINK.startedAt) - mins * 60_000).toISOString()
    const n = buildUpstreamNote([{ ...CURSOR_LINK, upstream: [{ ...CURSOR_LINK.upstream[0], startedAt: started }] }], 'cursor')!
    expect(renderUpstreamNote(n, 'Cursor')).toContain(`${label} before Cursor`)
  })

  it('renders the row but no link when the upstream has no is-down page', () => {
    const noPage = buildUpstreamNote([{
      ...CURSOR_LINK,
      upstream: [{ ...CURSOR_LINK.upstream[0], id: 'bedrock', name: 'Amazon Bedrock' }],
    }], 'cursor')!
    const html = renderUpstreamNote(noPage, 'Cursor')
    expect(html).toContain('Amazon Bedrock')
    expect(html).not.toContain('<a class="mono"')
  })
})
