import { vi } from 'vitest'
import { LOCAL_TIME_CLIENT_JS } from '../_is-down/html-template'

/** The text a no-JS reader gets: the #2062 `<time>` wrappers removed. */
export const noJs = (html: string) => html.replace(/<span class="local-time-utc">( UTC)<\/span>/g, '$1').replace(/<\/?time\b[^>]*>/g, '')

const RealDateTimeFormat = Intl.DateTimeFormat

export function viewIn(timeZone: string): void {
  vi.stubGlobal('Intl', {
    DateTimeFormat: function (locale: string, options: Intl.DateTimeFormatOptions) {
      return new RealDateTimeFormat(locale, { timeZone, ...options })
    },
  })
}

export function runLocalTimeScript(html: string): void {
  document.body.innerHTML = html
  new Function(LOCAL_TIME_CLIENT_JS)()
  document.dispatchEvent(new Event('DOMContentLoaded'))
}
