import { useState, useEffect } from 'react'
import {
  SETTINGS_STORAGE_KEY,
  VALID_PERIODS,
  VALID_ALERT_CONDITIONS,
  ALL_SERVICE_IDS,
  DEFAULT_SETTINGS,
} from '../utils/constants'

const canUseStorage = (() => {
  try {
    localStorage.setItem('__test__', '1')
    localStorage.removeItem('__test__')
    return true
  } catch {
    return false
  }
})()

const SETTINGS_EVENT = 'aiwatch-settings-change'

// Normalize a stored/incoming alertCondition. #470 removed 'degraded' (it behaved identically to
// 'all'); migrate it so a user who picked it keeps the same "alert on every change" behavior
// instead of silently snapping to the default. Unknown values fall back to `fallback`.
export function normalizeAlertCondition(v, fallback) {
  if (v === 'degraded') return 'all'
  return VALID_ALERT_CONDITIONS.includes(v) ? v : fallback
}

// Stored as the ids switched OFF, so a service added after the last save is on by default.
// A record without disabledServices (older build) resolves to every service.
export function resolveEnabledServices(parsed) {
  if (!Array.isArray(parsed.disabledServices)) return DEFAULT_SETTINGS.enabledServices
  const off = new Set(parsed.disabledServices)
  return ALL_SERVICE_IDS.filter((id) => !off.has(id))
}

function readStored() {
  if (!canUseStorage) return DEFAULT_SETTINGS
  try {
    const raw = localStorage.getItem(SETTINGS_STORAGE_KEY)
    if (!raw) return DEFAULT_SETTINGS
    const parsed = JSON.parse(raw)
    return {
      period: VALID_PERIODS.includes(parsed.period) ? parsed.period : DEFAULT_SETTINGS.period,
      sla: typeof parsed.sla === 'number' && parsed.sla >= 0 && parsed.sla <= 100
        ? parsed.sla
        : DEFAULT_SETTINGS.sla,
      enabledServices: resolveEnabledServices(parsed),
      discordUrl: typeof parsed.discordUrl === 'string' ? parsed.discordUrl : DEFAULT_SETTINGS.discordUrl,
      alertCondition: normalizeAlertCondition(parsed.alertCondition, DEFAULT_SETTINGS.alertCondition),
      alertTarget: ['all', 'custom'].includes(parsed.alertTarget) ? parsed.alertTarget : DEFAULT_SETTINGS.alertTarget,
      alertServices: Array.isArray(parsed.alertServices)
        ? parsed.alertServices.filter((id) => ALL_SERVICE_IDS.includes(id))
        : DEFAULT_SETTINGS.alertServices,
      alertIncidents: typeof parsed.alertIncidents === 'boolean' ? parsed.alertIncidents : DEFAULT_SETTINGS.alertIncidents,
      alertMaintenance: typeof parsed.alertMaintenance === 'boolean' ? parsed.alertMaintenance : DEFAULT_SETTINGS.alertMaintenance,
    }
  } catch (err) {
    if (err instanceof SyntaxError || err instanceof DOMException) {
      console.warn('[useSettings] Failed to read stored settings:', err.message)
      return DEFAULT_SETTINGS
    }
    throw err
  }
}

export function useSettings() {
  const [settings, setSettings] = useState(readStored)

  // Listen for settings changes from other useSettings instances
  useEffect(() => {
    const handler = () => setSettings(readStored())
    window.addEventListener(SETTINGS_EVENT, handler)
    return () => window.removeEventListener(SETTINGS_EVENT, handler)
  }, [])

  function save(next) {
    const validated = {
      period: VALID_PERIODS.includes(next.period) ? next.period : settings.period,
      sla: typeof next.sla === 'number' && next.sla >= 0 && next.sla <= 100
        ? next.sla
        : settings.sla,
      enabledServices: Array.isArray(next.enabledServices)
        ? next.enabledServices.filter((id) => ALL_SERVICE_IDS.includes(id))
        : settings.enabledServices,
      discordUrl: typeof next.discordUrl === 'string' ? next.discordUrl : settings.discordUrl,
      alertCondition: normalizeAlertCondition(next.alertCondition, settings.alertCondition),
      alertTarget: ['all', 'custom'].includes(next.alertTarget) ? next.alertTarget : settings.alertTarget,
      alertServices: Array.isArray(next.alertServices)
        ? next.alertServices.filter((id) => ALL_SERVICE_IDS.includes(id))
        : settings.alertServices,
      alertIncidents: typeof next.alertIncidents === 'boolean' ? next.alertIncidents : settings.alertIncidents,
      alertMaintenance: typeof next.alertMaintenance === 'boolean' ? next.alertMaintenance : settings.alertMaintenance,
    }
    if (canUseStorage) {
      try {
        const { enabledServices, ...rest } = validated
        const disabledServices = ALL_SERVICE_IDS.filter((id) => !enabledServices.includes(id))
        localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify({ ...rest, disabledServices }))
      } catch (err) {
        if (err instanceof DOMException) {
          console.warn('[useSettings] Failed to persist settings:', err.message)
        } else {
          throw err
        }
        setSettings(validated)
        return false
      }
    }
    setSettings(validated)
    // Notify all other useSettings instances
    window.dispatchEvent(new Event(SETTINGS_EVENT))
    return true
  }

  return { settings, save }
}
