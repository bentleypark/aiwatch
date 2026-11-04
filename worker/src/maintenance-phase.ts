/** #1405 — one rule for every surface that splits maintenance by phase: a window is ongoing from its start
 *  until its published end, and shown nowhere after it. */
export function maintenanceIsOngoing(window: { scheduledFor: string }, now = Date.now()): boolean {
  return Date.parse(window.scheduledFor) <= now
}

export function maintenanceHasEnded(window: { scheduledUntil: string | null }, now = Date.now()): boolean {
  const end = window.scheduledUntil ? Date.parse(window.scheduledUntil) : NaN
  return Number.isFinite(end) && end < now
}
