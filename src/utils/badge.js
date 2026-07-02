// #805 — embeddable status-badge markdown for the ServiceDetails "Badge Embed" section.
//
// The badge link MUST target the crawlable is-down SEO page (`/is-{slug}-down`), NOT the SPA hash
// route (`/#{serviceId}`). Google does not treat `#fragment` as a separate crawlable URL, so a badge
// embedded on a third-party site passed its backlink authority to the bare homepage instead of the
// page that actually ranks for "is {service} down" — leaking the one SEO lever the badge exists for.
//
// Services without an is-down page (bedrock / azureopenai — excluded from SLUG_TO_SERVICE per #263)
// have no crawlable target, so they fall back to the dashboard detail hash route.
import { SERVICE_ID_TO_SLUG } from '../../api/_is-down/slug-map'

const BADGE_BASE = 'https://aiwatch-worker.p2c2kbf.workers.dev'

/** Resolve the badge's link target: the crawlable is-down page when one exists, else the SPA detail route. */
export function buildBadgeLinkTarget(serviceId) {
  const slug = SERVICE_ID_TO_SLUG[serviceId]
  return slug ? `https://ai-watch.dev/is-${slug}-down` : `https://ai-watch.dev/#${serviceId}`
}

/** Build the copy-paste markdown for an embeddable status badge. */
export function buildBadgeMarkdown(serviceId, serviceName) {
  return `[![${serviceName}](${BADGE_BASE}/badge/${serviceId})](${buildBadgeLinkTarget(serviceId)})`
}
