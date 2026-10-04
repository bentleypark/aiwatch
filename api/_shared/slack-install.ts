// #1581 — the "Add to Slack" link every surface uses, Edge pages and the SPA alike. The worker route
// starts Slack's OAuth flow; `services` scopes the install (none = every service).

export const SLACK_INSTALL_URL = 'https://aiwatch-worker.p2c2kbf.workers.dev/api/slack/install'

const SERVICE_ID_RE = /^[a-z0-9]+$/

/** The four-colour Slack mark, decorative (the visible label names the action). */
export function slackLogoSvg(size = 14): string {
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" aria-hidden="true" style="flex-shrink:0;vertical-align:-2px">`
    + '<path fill="#E01E5A" d="M5.04 15.17a2.53 2.53 0 1 1-2.52-2.52h2.52v2.52zm1.27 0a2.53 2.53 0 0 1 5.05 0v6.3a2.53 2.53 0 1 1-5.05 0v-6.3z"/>'
    + '<path fill="#36C5F0" d="M8.83 5.04a2.53 2.53 0 1 1 2.53-2.52v2.52H8.83zm0 1.27a2.53 2.53 0 0 1 0 5.05H2.52a2.53 2.53 0 0 1 0-5.05h6.31z"/>'
    + '<path fill="#2EB67D" d="M18.96 8.83a2.53 2.53 0 1 1 2.52 2.53h-2.52V8.83zm-1.27 0a2.53 2.53 0 0 1-5.05 0V2.52a2.53 2.53 0 1 1 5.05 0v6.31z"/>'
    + '<path fill="#ECB22E" d="M15.17 18.96a2.53 2.53 0 1 1-2.53 2.52v-2.52h2.53zm0-1.27a2.53 2.53 0 0 1 0-5.05h6.31a2.53 2.53 0 1 1 0 5.05h-6.31z"/>'
    + '</svg>'
}

export function slackInstallUrl(serviceIds: readonly string[] = []): string {
  const ids = [...new Set(serviceIds.filter((id) => SERVICE_ID_RE.test(id)))]
  return ids.length > 0 ? `${SLACK_INSTALL_URL}?services=${ids.join(',')}` : SLACK_INSTALL_URL
}
