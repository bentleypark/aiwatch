// Reusable announcement banner config for the /intro landing page.
//
// A banner is surfaced via `?banner=<key>` and resolves against ANNOUNCEMENTS
// below. No banner renders unless a known key is requested, so the default
// landing page is clean (this replaced the time-bound "Welcome, Product
// Hunters!" banner — #265).
//
// To run a campaign (launch, monthly-report drop, feature announcement) add an
// entry here and link to `/intro?banner=<key>`. Remove the entry when the
// campaign ends so a stale banner can never resurface from an old link.
//
//   export const ANNOUNCEMENTS: AnnouncementMap = {
//     'launch-2026-06': {
//       html: '🚀 New: per-region fallback routing — <strong>see what changed</strong>',
//       href: 'https://ai-watch.dev/#changelog',
//     },
//   }

export interface Announcement {
  /** Stable id, derived from the map key — emitted as the GA4 `click_announcement` `id`. */
  id: string
  /** Inner HTML of the banner. Trusted, author-controlled — never user input. */
  html: string
  /** Optional click-through URL; when set the banner content is wrapped in an <a>. */
  href?: string
}

/**
 * Stored shape omits `id`: the map key *is* the id, injected at resolve time so
 * the two can never drift (and the GA4 event id always matches the `?banner=` key).
 */
export type AnnouncementMap = Record<string, Omit<Announcement, 'id'>>

/** Active announcements keyed by `?banner=<key>`. Empty = no banner ever shows. */
export const ANNOUNCEMENTS: AnnouncementMap = {}

/**
 * Pure resolver kept separate from the module-level ANNOUNCEMENTS so it can be
 * unit-tested with a fixture map. Uses hasOwnProperty to avoid resolving
 * inherited keys like `__proto__` / `constructor`. `id` is set from the key.
 */
export function resolveAnnouncementFrom(
  map: AnnouncementMap,
  key: string | null | undefined,
): Announcement | null {
  if (!key) return null
  return Object.prototype.hasOwnProperty.call(map, key) ? { ...map[key], id: key } : null
}

export function resolveAnnouncement(key: string | null | undefined): Announcement | null {
  return resolveAnnouncementFrom(ANNOUNCEMENTS, key)
}
