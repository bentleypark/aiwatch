import { useState } from 'react'
import { VALID_LANGS, LANG_STORAGE_KEY } from '../utils/constants'
import { t } from '../utils/lang'

// Mirrors the canUseStorage pattern from useTheme.js
const canUseStorage = (() => {
  try {
    localStorage.setItem('__test__', '1')
    localStorage.removeItem('__test__')
    return true
  } catch {
    return false
  }
})()

function detectBrowserLang() {
  if (typeof navigator === 'undefined') return 'ko'
  if (!navigator.language) return 'ko'
  // Default to Korean unless browser explicitly uses English
  return navigator.language.startsWith('en') ? 'en' : 'ko'
}

function readStoredLang() {
  if (!canUseStorage) return detectBrowserLang()
  try {
    const stored = localStorage.getItem(LANG_STORAGE_KEY)
    if (stored === null) return detectBrowserLang()
    if (!VALID_LANGS.includes(stored)) {
      console.warn(
        `[useLang] Unrecognized lang "${stored}" in localStorage. Falling back to browser detection.`
      )
      localStorage.removeItem(LANG_STORAGE_KEY)
      return detectBrowserLang()
    }
    return stored
  } catch (err) {
    if (err instanceof DOMException) {
      console.warn('[useLang] localStorage read failed:', err.message)
      return detectBrowserLang()
    }
    throw err
  }
}

export function useLang() {
  const [lang, setLangState] = useState(readStoredLang)

  function setLang(next) {
    if (!VALID_LANGS.includes(next)) {
      console.error(`[useLang] Invalid lang value: "${next}"`)
      return
    }
    if (canUseStorage) {
      try {
        localStorage.setItem(LANG_STORAGE_KEY, next)
      } catch (err) {
        if (err instanceof DOMException) {
          // Preference not persisted but still applied in-memory for this session
          console.warn('[useLang] Failed to persist language preference:', err.message)
        } else {
          throw err
        }
      }
    }
    setLangState(next)
  }

  return { lang, setLang, t: (key) => t(key, lang) }
}
