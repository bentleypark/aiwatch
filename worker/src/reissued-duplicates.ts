// #1938 — a provider that re-issues an old incident under a new id leaves the accumulator holding
// both: the id banked in real time and the one the provider serves now. The new id is a ULID minted
// after the incident had already resolved. Read-only: the operator corrects the frozen month with a
// `ROW_REPLACEMENTS` entry (#1937).

import type { MonthlyIncidentEntry } from './monthly-archive'

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/

/** How long after the incident resolved its id must have been minted to count as a re-issue. */
export const REISSUE_MINT_LAG_MS = 3_600_000
/** How far apart two rows' starts may be for the same title to name the same event. */
export const REISSUE_START_WINDOW_MS = 24 * 3_600_000

export interface ReissuedPair {
  svcId: string
  title: string
  /** The id minted after the incident resolved. */
  reissuedId: string
  /** Earlier-minted rows of the same service, same title, starting within the window. */
  olderIds: string[]
}

/** The millisecond a ULID was minted, or null when `id` is not a ULID. */
export function ulidMintedMs(id: string): number | null {
  if (!ULID.test(id)) return null
  let ms = 0
  for (const ch of id.slice(0, 10)) ms = ms * 32 + CROCKFORD.indexOf(ch)
  return ms
}

const sameTitle = (a: string, b: string) => baseTitle(a) === baseTitle(b)
const baseTitle = (t: string) => t.replace(/·.*$/, '').trim().toLowerCase()

export function findReissuedDuplicates(
  services: Record<string, { incidentList?: MonthlyIncidentEntry[] } | undefined>,
): ReissuedPair[] {
  const out: ReissuedPair[] = []
  for (const [svcId, svc] of Object.entries(services)) {
    const rows = (svc?.incidentList ?? []).filter((r) => r.resolvedAt)
    for (const row of rows) {
      const minted = ulidMintedMs(row.id)
      if (minted == null || minted - Date.parse(row.resolvedAt!) <= REISSUE_MINT_LAG_MS) continue
      const older = rows.filter((o) => {
        if (!sameTitle(o.title, row.title)) return false
        if (Math.abs(Date.parse(o.startedAt) - Date.parse(row.startedAt)) >= REISSUE_START_WINDOW_MS) return false
        const olderMinted = ulidMintedMs(o.id)
        return olderMinted == null || olderMinted < minted
      })
      if (older.length > 0) out.push({ svcId, title: row.title, reissuedId: row.id, olderIds: older.map((o) => o.id) })
    }
  }
  return out
}
