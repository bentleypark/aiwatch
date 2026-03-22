import { useState, useEffect } from 'react'
import {
  SETTINGS_STORAGE_KEY,
  VALID_PERIODS,
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
      enabledServices: Array.isArray(parsed.enabledServices)
        ? parsed.enabledServices.filter((id) => ALL_SERVICE_IDS.includes(id))
        : DEFAULT_SETTINGS.enabledServices,
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
    }
    if (canUseStorage) {
      try {
        localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(validated))
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
