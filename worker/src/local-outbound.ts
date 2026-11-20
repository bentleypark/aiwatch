// #2058 — a local `wrangler dev` worker reads the operator webhook from `.dev.vars` and an empty local
// KV, so its cron-side checks fire as if for the first time and land in the production Discord. Neither
// the version-metadata binding nor the user agent tells `wrangler dev` from the deployed worker (both
// measured on #2058), so `.dev.vars` carries the signal: `AIWATCH_LOCAL=1`. With it, the entry points
// hand the code an env without the operator alert channels or the production Blob token;
// `AIWATCH_LOCAL_ALERTS=1` puts the alert channels back for a deliberate local check of an alert.

export const OPERATOR_ALERT_KEYS = ['DISCORD_WEBHOOK_URL', 'NTFY_TOPIC'] as const
export const PRODUCTION_WRITE_KEYS = ['BLOB_READ_WRITE_TOKEN'] as const

export interface LocalMarkers {
  AIWATCH_LOCAL?: string
  AIWATCH_LOCAL_ALERTS?: string
}

export function hiddenKeys(env: LocalMarkers): ReadonlySet<string> {
  if (env.AIWATCH_LOCAL !== '1') return new Set()
  return new Set<string>(env.AIWATCH_LOCAL_ALERTS === '1' ? PRODUCTION_WRITE_KEYS : [...PRODUCTION_WRITE_KEYS, ...OPERATOR_ALERT_KEYS])
}

let announced = false

export function withLocalOutboundMuted<E extends object>(env: E): E {
  const hidden = hiddenKeys(env as LocalMarkers)
  if (hidden.size === 0) return env
  if (!announced) {
    announced = true
    console.log(`[local] #2058 AIWATCH_LOCAL=1 — hidden from this run: ${[...hidden].join(', ')}`)
  }
  const isHidden = (prop: PropertyKey) => typeof prop === 'string' && hidden.has(prop)
  return new Proxy(env, {
    get: (target, prop) => (isHidden(prop) ? undefined : Reflect.get(target, prop)),
    has: (target, prop) => !isHidden(prop) && Reflect.has(target, prop),
  })
}
