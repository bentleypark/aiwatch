import { useState, useEffect } from 'react'
import { VALID_THEMES, THEME_STORAGE_KEY } from '../utils/constants'

const canUseStorage = (() => {
  try {
    localStorage.setItem('__test__', '1')
    localStorage.removeItem('__test__')
    return true
  } catch {
    return false
  }
})()

const canUseMatchMedia =
  typeof window !== 'undefined' && typeof window.matchMedia === 'function'

function readStoredTheme() {
  if (!canUseStorage) return 'dark'
  try {
    const stored = localStorage.getItem(THEME_STORAGE_KEY)
    if (stored === null) return 'dark'
    if (!VALID_THEMES.includes(stored)) {
      console.warn(
        `[useTheme] Unrecognized theme "${stored}" in localStorage. Falling back to "dark".`
      )
      localStorage.removeItem(THEME_STORAGE_KEY)
      return 'dark'
    }
    return stored
  } catch (err) {
    if (err instanceof DOMException) {
      console.warn('[useTheme] localStorage read failed:', err.message)
      return 'dark'
    }
    throw err
  }
}

function applyTheme(theme) {
  const root = document.documentElement
  if (theme === 'system') {
    const prefersDark = canUseMatchMedia
      ? window.matchMedia('(prefers-color-scheme: dark)').matches
      : true
    root.removeAttribute('data-theme')
    if (!prefersDark) root.setAttribute('data-theme', 'light')
  } else {
    theme === 'light'
      ? root.setAttribute('data-theme', 'light')
      : root.removeAttribute('data-theme')
  }
}

export function useTheme() {
  const [theme, setTheme] = useState(readStoredTheme)

  useEffect(() => {
    try {
      applyTheme(theme)
    } catch (err) {
      console.warn('[useTheme] Failed to apply theme:', err.message)
    }
  }, [theme])

  useEffect(() => {
    if (theme !== 'system' || !canUseMatchMedia) return
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const handler = () => applyTheme('system')
    mq.addEventListener('change', handler)
    return () => mq.removeEventListener('change', handler)
  }, [theme])

  function setAndPersist(next) {
    if (!VALID_THEMES.includes(next)) {
      console.error(`[useTheme] Invalid theme value: "${next}"`)
      return
    }
    if (canUseStorage) {
      try {
        localStorage.setItem(THEME_STORAGE_KEY, next)
      } catch (err) {
        if (err instanceof DOMException) {
          console.warn('[useTheme] Failed to persist theme preference:', err.message)
        } else {
          throw err
        }
      }
    }
    setTheme(next)
  }

  return { theme, setTheme: setAndPersist }
}
