// Time formatting utilities using Intl APIs.
// `lang` must be 'ko' or 'en' — unrecognized values fall back to 'en-US'.

const LOCALE_MAP = { ko: 'ko-KR', en: 'en-US' }

export function formatTime(date, lang) {
  if (!date) return ''
  return new Date(date).toLocaleTimeString(LOCALE_MAP[lang] ?? 'en-US', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
}

export function formatDate(date, lang) {
  if (!date) return ''
  return new Intl.DateTimeFormat(LOCALE_MAP[lang] ?? 'en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(date))
}
