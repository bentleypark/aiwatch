/**
 * #1510 Part B — status.mistral.ai's email notifications as a TRIGGER.
 *
 * A notification carries the incident title, the status word and nothing else (no id, components,
 * impact or start time), so nothing from it is stored. Its arrival only starts an immediate
 * `mistral-feed.yml` dispatch.
 *
 * Sender check: the From domain and the subject prefix. It is not proof of origin — rootly.com
 * publishes `p=quarantine`, and Email Routing's docs do not say whether that mode is rejected.
 */
import { maybeDispatchWorkflow, MISTRAL_EMAIL_DISPATCH_CONFIG } from './workflow-dispatch'

const ROOTLY_DOMAIN = 'rootly.com'
const MISTRAL_SUBJECT_PREFIX = 'Mistral AI | '

/** The address inside `Name <addr>`, or the bare value. Lowercased. */
export function headerAddress(from: string | null): string | null {
  if (!from) return null
  const angled = /<([^<>\s]+@[^<>\s]+)>/.exec(from)
  const addr = (angled ? angled[1] : from).toLowerCase()
  return /^[^@\s]+@[^@\s]+$/.test(addr) ? addr : null
}

export function isMistralRootlyNotification(headers: Headers): boolean {
  const addr = headerAddress(headers.get('from'))
  if (!addr || addr.slice(addr.lastIndexOf('@') + 1) !== ROOTLY_DOMAIN) return false
  return (headers.get('subject') ?? '').startsWith(MISTRAL_SUBJECT_PREFIX)
}

export interface MistralEmailEnv {
  STATUS_CACHE: KVNamespace
  GH_DISPATCH_TOKEN?: string
  /** Verified Email Routing destination; every mail is forwarded there, matched or not. */
  MISTRAL_EMAIL_FORWARD_TO?: string
}

export async function handleMistralEmail(
  message: ForwardableEmailMessage,
  env: MistralEmailEnv,
  ctx: ExecutionContext,
): Promise<void> {
  if (isMistralRootlyNotification(message.headers)) {
    ctx.waitUntil(maybeDispatchWorkflow(env, MISTRAL_EMAIL_DISPATCH_CONFIG))
  } else {
    console.warn(`[email] not a Mistral Rootly notification — forwarded only (from ${message.from})`)
  }
  if (!env.MISTRAL_EMAIL_FORWARD_TO) {
    console.warn('[email] MISTRAL_EMAIL_FORWARD_TO unset — mail not forwarded')
    return
  }
  try {
    await message.forward(env.MISTRAL_EMAIL_FORWARD_TO)
  } catch (err) {
    console.warn('[email] forward failed:', err instanceof Error ? err.message : err)
  }
}
