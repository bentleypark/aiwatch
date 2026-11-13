// #1991 — the is-down "Likely Shared Cause" card: of the worker's `sharedUpstream` groups, the ones that
// include this page's service. Rendered with the Related Upstream card's rows (html-template.ts): one row
// per other provider, never a row from this page's own provider. Optional on the wire: a worker
// deployed before #1991 sends no key.

import { SERVICE_ID_TO_SLUG } from './slug-map'
import { isSafeExternalUrl, type UpstreamNote, type UpstreamNoteUpstream } from './upstream-note'

export interface SharedUpstreamGroupLike {
  thirdParty: { key: string; name: string; statusUrl: string }
  services: Array<{ id: string; name: string; provider: string; status: string; incidentTitle: string; startedAt: string }>
}

export interface SharedUpstreamNote {
  /** this page's service id — GA `from_service` */
  fromId: string
  /** this page's own incident that names the third party */
  incidentTitle: string
  key: string
  name: string
  statusUrl: string
  peers: UpstreamNoteUpstream[]
}

const host = (url: string) => {
  try { return new URL(url).host } catch { return null }
}

/** The groups holding `pageId`, minus a third party the page's Related Upstream card already shows. */
export function buildSharedUpstreamNotes(
  groups: SharedUpstreamGroupLike[] | undefined,
  pageId: string,
  upstreamNote: UpstreamNote | null,
): SharedUpstreamNote[] {
  if (!Array.isArray(groups)) return []
  const shownHosts = new Set((upstreamNote?.upstream ?? []).flatMap((u) => u.external && u.href ? [host(u.href)] : []))
  return groups.flatMap((g) => {
    const own = g.services.find((s) => s.id === pageId)
    if (!own || !isSafeExternalUrl(g.thirdParty.statusUrl) || shownHosts.has(host(g.thirdParty.statusUrl))) return []
    return [{
      fromId: pageId,
      incidentTitle: own.incidentTitle,
      key: g.thirdParty.key,
      name: g.thirdParty.name,
      statusUrl: g.thirdParty.statusUrl,
      peers: g.services.filter((s, i) => s.provider !== own.provider && g.services.findIndex((t) => t.provider === s.provider) === i).map((s) => {
        const slug = SERVICE_ID_TO_SLUG[s.id]
        return { id: s.id, name: s.name, status: s.status, incidentTitle: s.incidentTitle, startedAt: s.startedAt, href: slug ? `/is-${slug}-down` : null, external: false, leadMinutes: null }
      }),
    }]
  })
}
