import { describe, it, expect } from 'vitest'
import { findReissuedDuplicates, ulidMintedMs } from '../reissued-duplicates'
import { archiveReadyEmbedFromRaw, buildArchiveReadyEmbed, type MonthlyIncidentEntry } from '../monthly-archive'

const row = (id: string, title: string, startedAt: string, resolvedAt: string | null): MonthlyIncidentEntry => ({
  id, title, startedAt, resolvedAt, durationMin: 11, finalStatus: 'resolved', impact: 'minor',
})

// Rows as archived in archive:monthly:2026-10 (elevenlabs) and archive:monthly:2026-07 (langsmith, junie).
const ELEVEN_OLD = row('01M4RYERPK4YKY04WE4A2AZ8KW', 'TTS failures and increased latency', '2026-10-12T16:19:00Z', '2026-10-12T16:30:00Z')
const ELEVEN_NEW = row('01M5FR70G87Z8BM05K0G18DTT7', 'TTS failures and increased latency', '2026-10-12T16:19:00Z', '2026-10-12T16:30:00Z')
const LANGSMITH_OLD = row('01KXC3QFPZEJAFQ4TJGC94RNRD', 'Ingestion is delayed', '2026-07-12T21:28:58Z', '2026-07-12T21:59:18Z')
const LANGSMITH_NEW = row('01KXKGA8JHKV6AH3FAA9SYBWDT', 'Ingestion is delayed', '2026-07-12T21:28:58.335Z', '2026-07-12T21:59:18.65Z')
const PERPLEXITY_OLD = row('cmtlzck6l02ny0wo50uicmt68', 'Issue with usage based billing', '2026-09-03T20:30:59.824Z', '2026-09-03T21:10:35.884Z')
const PERPLEXITY_NEW = row('01M1Z156F1RJBNJ6JWZ8KHRS43', 'Issue with usage based billing', '2026-09-03T20:30:59.824Z', '2026-09-03T21:10:35.884Z')
const JUNIE_BACKFILL = row('01KXNJVZRAKNZ0TG4EX4WRRWMX', 'Auth & licensing service issues', '2026-07-16T13:46:44Z', '2026-06-08T17:43:29Z')

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
// A ULID minted at `ms`, the way a provider mints one when it opens the incident.
const ulidAt = (ms: number, tail = '0123456789ABCDEF') => {
  let head = ''
  for (let n = ms, i = 0; i < 10; i++, n = Math.floor(n / 32)) head = CROCKFORD[n % 32] + head
  return head + tail
}

const archiveOf = (services: Record<string, MonthlyIncidentEntry[]>) =>
  Object.fromEntries(Object.entries(services).map(([id, incidentList]) => [id, { incidentList }]))

describe('#1938 — ulidMintedMs', () => {
  it('decodes the mint time of a ULID', () => {
    expect(new Date(ulidMintedMs(ELEVEN_NEW.id)!).toISOString().slice(0, 13)).toBe('2026-10-21T17')
  })

  it.each(['cmtlzck6l02ny0wo50uicmt68', '#ca246731098dd2b0053fe949c055780bbe8c72f0968786c98492a18eb5f6a156', 'a0f7135c-4b1e-451c-a6bd-14b4ec72b3c1', '01M5FR70G87Z8BM05K0G18DTT', '01M5FR70G87Z8BM05K0G18DTTI'])(
    'is null for a non-ULID id: %s', (id) => {
      expect(ulidMintedMs(id)).toBeNull()
    },
  )
})

describe('#1938 — findReissuedDuplicates', () => {
  it('pairs an id minted after the incident resolved with the earlier-banked id (ElevenLabs 2026-10)', () => {
    expect(findReissuedDuplicates(archiveOf({ elevenlabs: [ELEVEN_OLD, ELEVEN_NEW] }))).toEqual([
      { svcId: 'elevenlabs', title: ELEVEN_NEW.title, reissuedId: ELEVEN_NEW.id, olderIds: [ELEVEN_OLD.id] },
    ])
  })

  it('pairs the re-issue even when the provider revised the times (LangSmith 2026-07, start differs by a fraction of a second)', () => {
    const [pair] = findReissuedDuplicates(archiveOf({ langsmith: [LANGSMITH_OLD, LANGSMITH_NEW] }))
    expect(pair).toMatchObject({ reissuedId: LANGSMITH_NEW.id, olderIds: [LANGSMITH_OLD.id] })
  })

  it('counts a non-ULID older id as earlier (Perplexity 2026-09, cuid then ULID)', () => {
    const [pair] = findReissuedDuplicates(archiveOf({ perplexity: [PERPLEXITY_OLD, PERPLEXITY_NEW] }))
    expect(pair).toMatchObject({ reissuedId: PERPLEXITY_NEW.id, olderIds: [PERPLEXITY_OLD.id] })
  })

  it('says nothing about a ULID minted long after the incident when no earlier row names the same event (Junie backfill)', () => {
    expect(findReissuedDuplicates(archiveOf({ junie: [JUNIE_BACKFILL] }))).toEqual([])
  })

  it('says nothing about two same-title incidents whose ids were each minted when they started', () => {
    const first = row(ulidAt(Date.parse('2026-10-12T16:19:00Z')), 'TTS failures and increased latency', '2026-10-12T16:19:00Z', '2026-10-12T16:30:00Z')
    const second = row(ulidAt(Date.parse('2026-10-12T18:00:00Z')), 'TTS failures and increased latency', '2026-10-12T18:00:00Z', '2026-10-12T18:10:00Z')
    expect(findReissuedDuplicates(archiveOf({ elevenlabs: [first, second] }))).toEqual([])
  })

  it('does not pair a re-issue whose title was reworded (Perplexity 2026-09, second pair)', () => {
    const old = row('cmtnypntq056g13qw1u9uixby', 'We have identified few connectors that are currently impacting users.', '2026-09-05T05:48:43.668Z', '2026-09-05T07:09:00.672Z')
    const reissued = row('01M1Z156VYPETMR4QRNMQMF3AM', 'We have identified few connectors that are impacting users.', '2026-09-05T04:50:00Z', '2026-09-05T07:09:00.672Z')
    expect(findReissuedDuplicates(archiveOf({ perplexity: [old, reissued] }))).toEqual([])
  })

  it('matches titles ignoring case, surrounding spaces and the trailing "· component" the Instatus parser appends', () => {
    const old = { ...PERPLEXITY_OLD, title: 'Issue with usage based billing · Billing ' }
    const reissued = { ...PERPLEXITY_NEW, title: ' issue with USAGE based billing ' }
    expect(findReissuedDuplicates(archiveOf({ perplexity: [old, reissued] }))).toHaveLength(1)
  })

  it('draws the mint-lag line at an hour after resolution', () => {
    const title = 'TTS failures and increased latency'
    const startedAt = '2026-10-12T16:19:00Z'
    const resolvedAt = '2026-10-12T16:30:00Z'
    const opened = row(ulidAt(Date.parse(startedAt)), title, startedAt, resolvedAt)
    const minted = (afterResolvedMs: number) => row(ulidAt(Date.parse(resolvedAt) + afterResolvedMs), title, startedAt, resolvedAt)
    expect(findReissuedDuplicates(archiveOf({ elevenlabs: [opened, minted(59 * 60_000)] }))).toEqual([])
    expect(findReissuedDuplicates(archiveOf({ elevenlabs: [opened, minted(61 * 60_000)] }))).toHaveLength(1)
  })

  it('draws the start window at 24 hours, in either direction', () => {
    const shifted = (ms: number) => ({ ...ELEVEN_OLD, startedAt: new Date(Date.parse(ELEVEN_OLD.startedAt) + ms).toISOString() })
    const day = 24 * 3_600_000
    expect(findReissuedDuplicates(archiveOf({ elevenlabs: [shifted(day - 1), ELEVEN_NEW] }))).toHaveLength(1)
    expect(findReissuedDuplicates(archiveOf({ elevenlabs: [shifted(day), ELEVEN_NEW] }))).toEqual([])
    expect(findReissuedDuplicates(archiveOf({ elevenlabs: [shifted(-day), ELEVEN_NEW] }))).toEqual([])
  })

  it('says nothing when the earlier same-title row started a day or more before', () => {
    const farOld = { ...ELEVEN_OLD, startedAt: '2026-10-10T16:19:00Z', resolvedAt: '2026-10-10T16:30:00Z' }
    expect(findReissuedDuplicates(archiveOf({ elevenlabs: [farOld, ELEVEN_NEW] }))).toEqual([])
  })

  it('ignores an unresolved row and a service with no incident list', () => {
    expect(findReissuedDuplicates({ x: undefined, y: {}, elevenlabs: { incidentList: [ELEVEN_OLD, { ...ELEVEN_NEW, resolvedAt: null }] } })).toEqual([])
  })

  it('keeps the services apart', () => {
    expect(findReissuedDuplicates(archiveOf({ elevenlabs: [ELEVEN_OLD], langsmith: [{ ...ELEVEN_NEW }] }))).toEqual([])
  })
})

describe('#1938 — the archive-ready notice', () => {
  const clean = JSON.stringify({ daysCollected: 30, services: archiveOf({ elevenlabs: [ELEVEN_OLD], langsmith: [LANGSMITH_NEW] }) })
  const flagged = JSON.stringify({ daysCollected: 31, services: archiveOf({ elevenlabs: [ELEVEN_OLD, ELEVEN_NEW] }) })

  it('is the plain notice, unchanged, when no pair is found', () => {
    expect(archiveReadyEmbedFromRaw(clean, '2026-09')).toEqual(buildArchiveReadyEmbed('2026-09', 2, 30, 30))
  })

  it('stays purple for a complete month with no pair, and amber for a complete month with one', () => {
    const complete = JSON.stringify({ daysCollected: 31, services: archiveOf({ elevenlabs: [ELEVEN_OLD] }) })
    expect(archiveReadyEmbedFromRaw(complete, '2026-10')!.color).toBe(0x9B59B6)
    expect(archiveReadyEmbedFromRaw(flagged, '2026-10')!.color).toBe(0xd29922)
  })

  it('names the pair and turns amber when one is found', () => {
    const embed = archiveReadyEmbedFromRaw(flagged, '2026-10')!
    expect(embed.description).toContain(ELEVEN_NEW.id)
    expect(embed.description).toContain(ELEVEN_OLD.id)
    expect(embed.description).toContain('--period 2026-10')
    expect(embed.color).toBe(0xd29922)
  })

  it('cuts a long provider title at 80 characters', () => {
    const long = 'x'.repeat(200)
    const description = archiveReadyEmbedFromRaw(JSON.stringify({ daysCollected: 30, services: archiveOf({ elevenlabs: [{ ...ELEVEN_OLD, title: long }, { ...ELEVEN_NEW, title: long }] }) }), '2026-10')!.description
    expect(description).toContain('x'.repeat(80))
    expect(description).not.toContain('x'.repeat(81))
  })

  it('lists five and counts the rest', () => {
    const many = Array.from({ length: 7 }, (_, i) => [
      row(`01M4RYERPK4YKY04WE4A2AZ8K${i}`, `Incident ${i}`, '2026-10-12T16:19:00Z', '2026-10-12T16:30:00Z'),
      row(`01M5FR70G87Z8BM05K0G18DTT${i}`, `Incident ${i}`, '2026-10-12T16:19:00Z', '2026-10-12T16:30:00Z'),
    ]).flat()
    const description = archiveReadyEmbedFromRaw(JSON.stringify({ daysCollected: 30, services: archiveOf({ elevenlabs: many }) }), '2026-10')!.description
    expect(description).toContain('7 incident(s) banked under two ids')
    expect(description).toContain('… and 2 more')
  })

  it('is null for an archive that does not parse, or parses to null', () => {
    expect(archiveReadyEmbedFromRaw('{not json', '2026-10')).toBeNull()
    expect(archiveReadyEmbedFromRaw('null', '2026-10')).toBeNull()
  })

  it('still sends the plain notice when a stored row has no title', () => {
    const untitled = { ...ELEVEN_OLD, title: undefined } as unknown as MonthlyIncidentEntry
    const raw = JSON.stringify({ daysCollected: 31, services: archiveOf({ elevenlabs: [untitled, ELEVEN_NEW] }) })
    expect(archiveReadyEmbedFromRaw(raw, '2026-10')).toEqual(buildArchiveReadyEmbed('2026-10', 1, 31, 31))
  })
})
