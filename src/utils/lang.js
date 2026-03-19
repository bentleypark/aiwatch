import ko from '../locales/ko'
import en from '../locales/en'

const LOCALES = { ko, en }

export function t(key, lang) {
  if (LOCALES[lang] === undefined) {
    console.error(`[t] Unknown locale "${lang}" for key "${key}"`)
  }

  const inLocale = LOCALES[lang]?.[key]
  if (inLocale !== undefined) return inLocale

  const inKo = LOCALES['ko']?.[key]
  if (inKo !== undefined) {
    if (lang !== 'ko') {
      console.warn(`[t] Missing translation for "${key}" in locale "${lang}". Using "ko" fallback.`)
    }
    return inKo
  }

  console.error(`[t] Missing translation key "${key}" in all locales.`)
  return key
}
