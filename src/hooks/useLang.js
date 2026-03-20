import { useState, createContext, useContext, createElement } from 'react'
import { VALID_LANGS, LANG_STORAGE_KEY } from '../utils/constants'
import { t } from '../utils/lang'

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
  return navigator.language.startsWith('en') ? 'en' : 'ko'
}

function readStoredLang() {
  if (!canUseStorage) return detectBrowserLang()
  try {
    const stored = localStorage.getItem(LANG_STORAGE_KEY)
    if (stored === null) return detectBrowserLang()
    if (!VALID_LANGS.includes(stored)) {
      localStorage.removeItem(LANG_STORAGE_KEY)
      return detectBrowserLang()
    }
    return stored
  } catch {
    return detectBrowserLang()
  }
}

// Shared context so all components see the same lang
const LangContext = createContext(null)

function useLangInternal() {
  const [lang, setLangState] = useState(readStoredLang)

  function setLang(next) {
    if (!VALID_LANGS.includes(next)) return
    if (canUseStorage) {
      try { localStorage.setItem(LANG_STORAGE_KEY, next) } catch { /* ignore */ }
    }
    setLangState(next)
  }

  return { lang, setLang, t: (key) => t(key, lang) }
}

export function LangProvider({ children }) {
  const value = useLangInternal()
  return createElement(LangContext.Provider, { value }, children)
}

export function useLang() {
  const ctx = useContext(LangContext)
  if (!ctx) throw new Error('useLang must be used within a LangProvider')
  return ctx
}
