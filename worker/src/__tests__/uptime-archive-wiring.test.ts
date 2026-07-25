import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { restoreArchivedCalendars } from '../index'
import type { ServiceStatus } from '../services'

// #1017 — mocks the ONE collaborator restoreArchivedCalendars calls (uptime-archive.ts's
// restoreArchivedCalendar), so one service's failure can be forced deterministically. A real KV
// failure can't reach this far in practice — every internal layer (readArchivedWeightedOutageSec's
// per-date try/catch) already swallows KV/parse errors — so this is the only realistic way to exercise
// the isolation boundary AT RUNTIME rather than only proving via source-scan that the try/catch exists.
vi.mock('../uptime-archive', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../uptime-archive')>()
  return {
    ...actual,
    restoreArchivedCalendar: vi.fn(async (_kv: unknown, args: { serviceId: string; liveDailyImpact: unknown }) => {
      if (args.serviceId === 'broken') throw new Error('simulated restore failure')
      return { ...(args.liveDailyImpact as Record<string, string>), '2026-07-19': 'critical' }
    }),
  }
})

// #1017 — source-scan wiring guard, in the repo's sync-test idiom (badge-wiring.test.ts /
// badge-repo-discovery-wiring.test.ts / ai-usage-wiring.test.ts).
//
// Two sibling PRs in the same session (#1157, #1158) each shipped a real bug where a computed value
// was silently never threaded into its actual production call site — invisible to every test because
// each test called the pure function directly with a hand-built literal rather than exercising the
// real call site in index.ts. A review agent proved BOTH gaps here too via mutation testing: DELETING
// `counters[s.id].weightedOutageSec = s.todayWeightedOutageSec ?? null` (index.ts:228) and
// `if (restored !== s.dailyImpact) s.dailyImpact = restored` (index.ts:242) each independently left the
// full 3724-test suite green. These two tests close that gap. Verified by hand via DELETION, not
// commenting-out — these are source-scan regex tests, so a commented-out line still matches the regex
// and would NOT go red; only removing the line proves the guard works.
const SRC = join(__dirname, '..')
const index = readFileSync(join(SRC, 'index.ts'), 'utf8')
const services = readFileSync(join(SRC, 'services.ts'), 'utf8')

// #1017 — a review agent independently mutated all 8 threading points across services.ts (the
// ServiceStatus-assembly sites for Flashduty / the shared Statuspage+incident.io branch / OnlineOrNot
// / Instatus×2) and confirmed the full 3724-test suite stayed green with `todayWeightedOutageSec`
// silently dropped from every one of them. This guards the 5 FINAL write sites (where the field
// actually lands on the returned ServiceStatus, as opposed to the intermediate local-variable
// assignments feeding them).
describe('#1017 — services.ts threading of todayWeightedOutageSec onto ServiceStatus', () => {
  it('Flashduty', () => {
    expect(services).toMatch(/todayWeightedOutageSec: parsed\.flashdutyUptime\.todayWeightedOutageSec/)
  })

  it('the shared Statuspage-API + incident.io branch', () => {
    expect(services).toMatch(/\.\.\.\(todayWeightedOutageSec != null \? \{ todayWeightedOutageSec \} : \{\}\)/)
  })

  it('OnlineOrNot', () => {
    expect(services).toMatch(/base\.todayWeightedOutageSec = page\.todayWeightedOutageSec/)
  })

  it('Instatus — both return sites (the parse-failure carryover AND the success path)', () => {
    const matches = services.match(/\.\.\.\(instatusTodayWeightedOutageSec != null \? \{ todayWeightedOutageSec: instatusTodayWeightedOutageSec \} : \{\}\)/g)
    expect(matches?.length).toBe(2)
  })
})

describe('#1017 — cacheWrite wiring for the durable per-day archive', () => {
  it('folds todayWeightedOutageSec into the daily:{date} counter (rides the existing write, +0 new KV writes)', () => {
    expect(index).toMatch(/counters\[s\.id\]\.weightedOutageSec\s*=\s*s\.todayWeightedOutageSec\s*\?\?\s*null/)
  })

  it('assigns the restored dailyImpact back onto the service before CACHE_KEY is serialized', () => {
    expect(index).toMatch(/if \(restored !== s\.dailyImpact\) s\.dailyImpact = restored/)
  })

  it('the restore step is wrapped in a per-service try/catch (one service\'s failure must not abort the whole cache-write cycle)', () => {
    // Pins the fix for a review-found Critical: an earlier version had this Promise.all unguarded,
    // so a single service's uncaught exception would reject the whole Promise.all and skip the
    // CACHE_KEY/daily-counter/history writes below it for EVERY service, not just the failing one.
    expect(index).toMatch(/services\.map\(async \(s\) => \{\s*try \{[\s\S]*?restoreArchivedCalendar/)
    expect(index).toMatch(/\[uptime-archive\] restore failed for \$\{s\.id\}/)
  })
})

describe('#1017 — restoreArchivedCalendars isolation, exercised at runtime (not just source-scan)', () => {
  it('one service throwing does not block another service\'s dailyImpact from being restored', async () => {
    const services = [
      { id: 'broken', dailyImpact: { '2026-07-24': 'minor' } },
      { id: 'ok-service', dailyImpact: {} },
    ] as unknown as ServiceStatus[]
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    await restoreArchivedCalendars({} as KVNamespace, services, '2026-07-25')

    // The failing service's dailyImpact is untouched (not corrupted, not left half-written) —
    // the whole batch did not abort because of it.
    expect(services[0].dailyImpact).toEqual({ '2026-07-24': 'minor' })
    // The healthy service still got restored despite its sibling throwing.
    expect(services[1].dailyImpact).toEqual({ '2026-07-19': 'critical' })
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('[uptime-archive] restore failed for broken'),
      expect.anything(),
    )
    errorSpy.mockRestore()
  })
})
