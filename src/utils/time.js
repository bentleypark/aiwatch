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

/**
 * #1292 — `dayOnly` drops the time of day and `day` supplies the date. A `status_history`-derived
 * incident is reconstructed from a per-DAY downtime-seconds bucket, so its `startedAt` is AIWatch's
 * own anchor inside that day: printing it beside the (real) duration would assert a window the
 * provider's own page contradicts, and reading its DATE lands on the wrong day for a viewer far
 * enough from the page. Every other incident's timestamp IS provider-published, hence the exception.
 */
export function formatDate(date, lang, { dayOnly = false, day = undefined } = {}) {
  if (!date) return ''
  // #1292 — `day` is the page-local calendar day carried on the incident (`derivedDay`). Formatting the
  // ANCHOR instead published the wrong date twice over: the anchor is an arbitrary instant inside that
  // day, and this formats in the VIEWER's zone, so a Seoul reader of a US-zoned status page saw the
  // next day. Parsed at noon UTC so the date cannot drift back across a zone boundary here either.
  const src = dayOnly && day ? new Date(`${day}T12:00:00Z`) : new Date(date)
  // `Intl.format()` THROWS on an invalid Date, which in React is an unhandled render throw — a blank
  // dashboard, not a bad date. `startedAt` was always a round-tripped `toISOString()`, but `day` is a
  // raw string forwarded through KV → archive → SPA. The Edge twin in `api/_is-down/html-template.ts`
  // already guards; the two mirrors must fail the same way.
  if (Number.isNaN(src.getTime())) return ''
  return new Intl.DateTimeFormat(LOCALE_MAP[lang] ?? 'en-US', {
    month: 'short',
    day: 'numeric',
    ...(dayOnly ? { timeZone: 'UTC' } : { hour: '2-digit', minute: '2-digit', hour12: false, timeZoneName: 'short' }),
  }).format(src)
}

export function filterLast24h(snapshots) {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000
  return snapshots.filter((s) => new Date(s.t).getTime() >= cutoff)
}
