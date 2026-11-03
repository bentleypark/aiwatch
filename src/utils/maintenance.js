// #1405 — scheduled maintenance windows on the dashboard: shown beside the status, never part of it.

import { maintenanceHasEnded, maintenanceIsOngoing } from '../../worker/src/maintenance-phase'

const LOCALE_MAP = { ko: 'ko-KR', en: 'en-US' }

const valid = (iso) => typeof iso === 'string' && !Number.isNaN(new Date(iso).getTime())

export function maintenanceWindowsOf(service, now = Date.now()) {
  return (service?.scheduledMaintenances ?? [])
    .filter((w) => valid(w?.scheduledFor) && !maintenanceHasEnded(w, now))
    .sort((a, b) => Date.parse(a.scheduledFor) - Date.parse(b.scheduledFor))
}

export function maintenancePhaseKey(window, now = Date.now()) {
  return maintenanceIsOngoing(window, now) ? 'overview.maintenance.ongoing' : 'overview.maintenance.upcoming'
}

export function formatMaintenanceRange(window, lang, timeZone) {
  if (!valid(window?.scheduledFor)) return ''
  const locale = LOCALE_MAP[lang] ?? 'en-US'
  const base = { hour12: false, ...(timeZone ? { timeZone } : {}) }
  const fmt = (iso, opts) => new Intl.DateTimeFormat(locale, { ...base, ...opts }).format(new Date(iso))
  const dateTime = { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }
  const start = fmt(window.scheduledFor, dateTime)
  if (!valid(window.scheduledUntil)) return fmt(window.scheduledFor, { ...dateTime, timeZoneName: 'short' })
  const day = (iso) => fmt(iso, { year: 'numeric', month: 'numeric', day: 'numeric' })
  const end = day(window.scheduledUntil) === day(window.scheduledFor)
    ? fmt(window.scheduledUntil, { hour: '2-digit', minute: '2-digit', timeZoneName: 'short' })
    : fmt(window.scheduledUntil, { ...dateTime, timeZoneName: 'short' })
  return `${start}–${end}`
}
