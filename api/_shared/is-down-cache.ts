// #1531 Part 6 — the is-down pages' Cache-Control, shared by `is-down.ts` and `is-down-group.ts`.
// A fallback render (both Worker fetches failed) stays uncached (#378). A good render carries
// `stale-if-error`, which lets the Vercel CDN answer an error with the last good page it holds
// (https://vercel.com/docs/caching/cache-control-headers#stale-if-error).

export const STALE_IF_ERROR_S = 600

export function isDownCacheControl(isFallback: boolean): string {
  return isFallback
    ? 'no-store, max-age=0, must-revalidate'
    : `public, s-maxage=60, stale-while-revalidate=300, stale-if-error=${STALE_IF_ERROR_S}`
}
