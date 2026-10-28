import { describe, it, expect } from 'vitest'
import { updateDailyCounters } from '../index'
import { computeMonthlyOfficialUptime } from '../monthly-archive'
import type { ServiceStatus } from '../services'

describe('#1835 — updateDailyCounters records the uptime snapshot with its window', () => {
  const svc = (over: Partial<ServiceStatus>) =>
    ({ id: 'helicone', status: 'operational', incidents: [], ...over }) as unknown as ServiceStatus

  it('stores the window of a short-window uptime, and the month-end reader skips it', () => {
    const counters: Parameters<typeof updateDailyCounters>[0] = {}
    updateDailyCounters(counters, [svc({ uptime30d: 100, uptimeWindowDays: 1 })])
    expect(counters.helicone).toMatchObject({ ok: 1, total: 1, officialUptime: 100, officialUptimeWindowDays: 1 })
    expect(computeMonthlyOfficialUptime({ '2026-10-31': counters }).helicone).toBeUndefined()
  })

  it('a full-window uptime stores no window and stays the month-end value', () => {
    const counters: Parameters<typeof updateDailyCounters>[0] = {}
    updateDailyCounters(counters, [svc({ uptime30d: 99.5 })])
    expect(counters.helicone.officialUptimeWindowDays).toBeNull()
    expect(computeMonthlyOfficialUptime({ '2026-10-31': counters }).helicone).toBe(99.5)
  })
})
