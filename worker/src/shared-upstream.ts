// #1991 — services from different providers whose live incidents name the same third party: a likely
// shared upstream cause, which the dashboard otherwise shows as unrelated cards. Unlike
// `upstream-link.ts` it needs no declared dependency and no feed for the third party: on 2026-11-12
// Microsoft's public post came ~12h after claude.ai's incident (measured in #1991).

import type { Incident, ServiceStatus } from './types'
import { causalIncidents } from './incident-text'

export interface ThirdParty {
  key: string
  name: string
  /** product names only — a generic word ("teams") matches unrelated prose */
  aliases: string[]
  /** providers that own this third party: their services mention it in routine incidents */
  ownerProviders: string[]
  statusUrl: string
}

export const THIRD_PARTIES: ThirdParty[] = [
  { key: 'microsoft365', name: 'Microsoft 365', aliases: ['microsoft 365', 'office 365'], ownerProviders: ['Microsoft'], statusUrl: 'https://status.cloud.microsoft/' },
  { key: 'azure', name: 'Azure', aliases: ['azure'], ownerProviders: ['Microsoft'], statusUrl: 'https://azure.status.microsoft/en-us/status' },
  { key: 'aws', name: 'AWS', aliases: ['aws', 'amazon web services'], ownerProviders: ['AWS'], statusUrl: 'https://health.aws.amazon.com/health/status' },
  { key: 'gcp', name: 'Google Cloud', aliases: ['gcp', 'google cloud'], ownerProviders: ['Google'], statusUrl: 'https://status.cloud.google.com/' },
  { key: 'cloudflare', name: 'Cloudflare', aliases: ['cloudflare'], ownerProviders: [], statusUrl: 'https://www.cloudflarestatus.com/' },
  { key: 'github', name: 'GitHub', aliases: ['github'], ownerProviders: ['GitHub'], statusUrl: 'https://www.githubstatus.com/' },
]

/** Word-bounded, case- and spacing-insensitive: "aws" must not match "draws". */
export function namesThirdParty(text: string, aliases: string[]): boolean {
  return aliases.some((a) => {
    const body = a.trim().split(/\s+/).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[\\s._-]*')
    return new RegExp(`(^|[^a-z0-9])${body}($|[^a-z0-9])`, 'i').test(text)
  })
}

/** Title + updates without bracketed tags or region ids: `[AWS][us-east-1]` or `aws-us-west-2` says where,
 *  not who is to blame. A markdown link's `[text](url)` is kept. */
export function blameText(inc: Pick<Incident, 'title' | 'timeline'>): string {
  return [inc.title ?? '', ...(inc.timeline ?? []).map((e) => e.text ?? '')]
    .map((t) => t
      .replace(/\[[^\]]*\](?!\()/g, ' ')
      .replace(/(^|[^a-z0-9])(aws|gcp|azure)-[a-z]+(-[a-z0-9]+)+/gi, '$1 '))
    .join(' ')
}

export interface SharedUpstreamGroup {
  thirdParty: Pick<ThirdParty, 'key' | 'name' | 'statusUrl'>
  services: Array<Pick<ServiceStatus, 'id' | 'name' | 'provider'>>
}

/** Third parties named by live incidents of services from at least two different providers. */
export function sharedUpstreamGroups(
  services: Array<Pick<ServiceStatus, 'id' | 'name' | 'provider' | 'incidents'>>,
  thirdParties: ThirdParty[] = THIRD_PARTIES,
): SharedUpstreamGroup[] {
  const groups: SharedUpstreamGroup[] = []
  for (const tp of thirdParties) {
    const naming = services.filter((s) =>
      !tp.ownerProviders.includes(s.provider) &&
      causalIncidents(s).some((c) => namesThirdParty(blameText(c.inc), tp.aliases)))
    if (new Set(naming.map((s) => s.provider)).size < 2) continue
    groups.push({
      thirdParty: { key: tp.key, name: tp.name, statusUrl: tp.statusUrl },
      services: naming.map(({ id, name, provider }) => ({ id, name, provider })),
    })
  }
  return groups.sort((a, b) => b.services.length - a.services.length)
}
