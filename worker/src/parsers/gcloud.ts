// Google Cloud Status Parser — incidents.json with product filtering

import type { TimelineEntry, Incident } from '../types'
import { formatDuration } from '../utils'

export interface GCloudIncident {
  id: string
  service_name: string
  severity: string
  begin: string
  end: string | null
  affected_products?: Array<{ title: string; id: string }>
  most_recent_update?: { status: string; text: string }
  updates?: Array<{ status: string; when: string; text: string }>
}

export function parseGCloudIncidents(data: GCloudIncident[], productFilter: string, productId?: string): Incident[] {
  return data
    .filter((inc) =>
      (productId && inc.affected_products?.some((p) => p.id === productId)) ||
      inc.affected_products?.some((p) => p.title === productFilter) ||
      inc.service_name?.toLowerCase().includes(productFilter.toLowerCase())
    )
    .slice(0, 5)
    .flatMap((inc) => {
      try {
        const duration = inc.end
          ? formatDuration(new Date(inc.begin), new Date(inc.end))
          : null
        const status = inc.most_recent_update?.status
        const timeline: TimelineEntry[] = (inc.updates ?? [])
          .map((u) => ({
            stage: u.status === 'AVAILABLE' ? 'resolved' as const
              : u.status === 'SERVICE_DISRUPTION' ? 'investigating' as const
              : u.status === 'SERVICE_INFORMATION' ? 'identified' as const
              : 'investigating' as const,
            text: u.text?.replace(/^#.*\n/gm, '').replace(/\*\*/g, '').trim().substring(0, 200) || null,
            at: u.when,
          }))
          .reverse()

        const impact = inc.severity === 'high' ? 'major' as const
          : inc.severity === 'medium' ? 'minor' as const
          : null

        // Include regional info in title if present in affected_products
        const regionInfo = inc.affected_products
          ?.filter((p) => p.title.toLowerCase().includes(productFilter.toLowerCase()))
          .map((p) => p.title)
          .join(', ')
        const displayTitle = regionInfo || inc.service_name

        return [{
          id: inc.id,
          title: `${displayTitle} — ${inc.severity}`,
          status: status === 'AVAILABLE' ? 'resolved' as const
            : status === 'SERVICE_DISRUPTION' ? 'investigating' as const
            : 'investigating' as const,
          impact,
          startedAt: inc.begin,
          duration,
          timeline,
        }]
      } catch { return [] }
    })
}
