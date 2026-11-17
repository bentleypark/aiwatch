// #2009 — consent-free count of completed "Check connection" checks on the is-down pages. One Analytics
// Engine point per check (POST /api/device-check), on the SAME dataset as the is-down page views, so the
// daily read takes checks and the views they divide by in one query (history-click.ts).
//   index1 = 'isdown-device-check'
//   blob1  = service id of the provider that was checked (an unrecognised id → AUDIENCE_UNKNOWN_SCREEN)
//   blob2  = 'active' | 'clear' — the page's SSR-time outage status (same position as `isdown-view`)
//   blob3  = agent ('bot' | 'unflagged')
//   blob4  = surface ('service' | 'group' | 'unknown')
//   blob5  = outcome, one of DEVICE_CHECK_OUTCOMES

import {
  AUDIENCE_SURFACES, AUDIENCE_SURFACE_UNKNOWN, AUDIENCE_UNKNOWN_SCREEN,
  type AudienceAgent, type AudienceSurface, type AudienceSurfaceKey,
} from './outage-audience'
import { queryClickRate, type ClickRateCounts } from './history-click'
import { DEVICE_CHECK_READABLE } from './device-check-readable'

export const DEVICE_CHECK_INDEX = 'isdown-device-check'

/** What `deviceCheckClass` in api/_shared/device-check.ts can send; pinned against it by a test. */
export const DEVICE_CHECK_OUTCOMES = ['ok', 'server_error', 'timeout', 'error'] as const
export type DeviceCheckOutcome = (typeof DEVICE_CHECK_OUTCOMES)[number]

export function parseDeviceCheckBody(
  body: unknown,
  validIds: Set<string>,
): { svc: string; active: boolean; surface: AudienceSurfaceKey; outcome: DeviceCheckOutcome } | null {
  if (!body || typeof body !== 'object') return null
  const b = body as Record<string, unknown>
  const rawSvc = typeof b.svc === 'string' ? b.svc : ''
  if (!rawSvc) return null
  const outcome = DEVICE_CHECK_OUTCOMES.find((o) => o === b.outcome)
  if (!outcome) return null
  const surface: AudienceSurfaceKey = AUDIENCE_SURFACES.includes(b.surface as AudienceSurface)
    ? (b.surface as AudienceSurface)
    : AUDIENCE_SURFACE_UNKNOWN
  return { svc: validIds.has(rawSvc) ? rawSvc : AUDIENCE_UNKNOWN_SCREEN, active: b.active === true, surface, outcome }
}

export function recordDeviceCheck(
  analytics: AnalyticsEngineDataset | undefined,
  svcId: string,
  active: boolean,
  surface: AudienceSurfaceKey,
  agent: AudienceAgent,
  outcome: DeviceCheckOutcome,
): void {
  if (!analytics) return
  try {
    analytics.writeDataPoint({
      blobs: [svcId, active ? 'active' : 'clear', agent, surface, outcome],
      doubles: [1],
      indexes: [DEVICE_CHECK_INDEX],
    })
  } catch (err) {
    console.warn('[wae] device-check writeDataPoint failed:', err instanceof Error ? err.message : err)
  }
}

// Every family page carries one block; a service page carries one only when its provider is readable.
const DEVICE_CHECK_VIEWS_WHERE =
  ` AND (blob4 = 'group' OR blob3 IN (${Object.keys(DEVICE_CHECK_READABLE).map((id) => `'${id}'`).join(', ')}))`

export const queryDeviceChecks = (
  accountId: string | undefined,
  token: string | undefined,
  fetchImpl: typeof fetch = fetch,
): Promise<ClickRateCounts | null> => queryClickRate(DEVICE_CHECK_INDEX, accountId, token, fetchImpl, DEVICE_CHECK_VIEWS_WHERE)
