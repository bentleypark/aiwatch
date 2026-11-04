import { describe, it, expect } from 'vitest'
import { formatMaintenanceRange, maintenancePhaseKey, maintenanceWindowsOf } from '../maintenance'

// status.bfl.ml as read 2026-11-03: one window, 2026-11-04 04:00–10:00Z.
const BFL = {
  id: 'd6t9c8tqbz25', title: 'EU cluster storage maintenance',
  scheduledFor: '2026-11-04T04:00:00.000Z', scheduledUntil: '2026-11-04T10:00:00.000Z',
  componentNames: ['API (api.bfl.ai)', 'API EU (api.eu.bfl.ai)'],
}

describe('#1405 maintenanceWindowsOf', () => {
  it('is empty when the service carries no windows', () => {
    expect(maintenanceWindowsOf({})).toEqual([])
    expect(maintenanceWindowsOf(undefined)).toEqual([])
  })

  it('drops a window with no readable start and orders the rest by start', () => {
    const later = { ...BFL, id: 'later', scheduledFor: '2026-11-10T00:00:00.000Z', scheduledUntil: null }
    const broken = { ...BFL, id: 'broken', scheduledFor: 'not a date' }
    const duringBfl = Date.parse('2026-11-04T05:00:00Z')
    expect(maintenanceWindowsOf({ scheduledMaintenances: [later, broken, BFL] }, duringBfl).map((w) => w.id)).toEqual(['d6t9c8tqbz25', 'later'])
  })
})

describe('#1405 formatMaintenanceRange', () => {
  it('same-day window: the end carries only the time, in the viewer zone', () => {
    expect(formatMaintenanceRange(BFL, 'en', 'UTC')).toBe('Nov 4, 04:00–10:00 UTC')
    expect(formatMaintenanceRange(BFL, 'en', 'Asia/Seoul')).toBe('Nov 4, 13:00–19:00 GMT+9')
  })

  it('a window that crosses midnight in the viewer zone repeats the date', () => {
    expect(formatMaintenanceRange(BFL, 'en', 'America/Los_Angeles')).toBe('Nov 3, 20:00–Nov 4, 02:00 PST')
  })

  it('start-only window', () => {
    expect(formatMaintenanceRange({ ...BFL, scheduledUntil: null }, 'en', 'UTC')).toBe('Nov 4, 04:00 UTC')
  })

  it('unreadable start renders nothing; unreadable end falls back to start-only', () => {
    expect(formatMaintenanceRange({ ...BFL, scheduledFor: 'x' }, 'en', 'UTC')).toBe('')
    expect(formatMaintenanceRange({ ...BFL, scheduledUntil: 'x' }, 'en', 'UTC')).toBe('Nov 4, 04:00 UTC')
  })

  it('Korean', () => {
    expect(formatMaintenanceRange(BFL, 'ko', 'Asia/Seoul')).toMatch(/^11월 4일 13:00–19:00 (GMT\+9|KST)$/)
  })
})

describe('#1405 maintenancePhaseKey', () => {
  it('names the ongoing label from the start on, the upcoming label before it', () => {
    expect(maintenancePhaseKey(BFL, Date.parse('2026-11-04T03:59:59Z'))).toBe('overview.maintenance.upcoming')
    expect(maintenancePhaseKey(BFL, Date.parse('2026-11-04T04:00:00Z'))).toBe('overview.maintenance.ongoing')
  })
})

describe('#1405 ended windows', () => {
  it('a window past its end is dropped, so no surface can call it ongoing', () => {
    const service = { scheduledMaintenances: [BFL] }
    expect(maintenanceWindowsOf(service, Date.parse('2026-11-04T09:59:00Z'))).toHaveLength(1)
    expect(maintenanceWindowsOf(service, Date.parse('2026-11-04T10:01:00Z'))).toEqual([])
    expect(maintenanceWindowsOf({ scheduledMaintenances: [{ ...BFL, scheduledUntil: null }] }, Date.parse('2027-01-01T00:00:00Z'))).toHaveLength(1)
  })
})
