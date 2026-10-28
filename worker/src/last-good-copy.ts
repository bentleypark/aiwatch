// #1531 Part 7 — the hourly copy of the lean `/api/status/cached?series=0` payload the Edge is-down
// pages fall back to when both Worker requests fail. It lives in Vercel Blob, outside Cloudflare.

import { put } from '@vercel/blob'
import { LAST_GOOD_COPY_PATH } from './last-good-copy-path'
import { settleWithin } from './utils'

export const LAST_GOOD_COPY_UPLOAD_MS = 20_000

export type LastGoodCopyOutcome = 'written' | 'no-payload' | 'write-failed' | 'timed-out'

const TIMED_OUT = Symbol('timed-out')

export async function writeLastGoodCopy(
  payload: object | null,
  token: string,
  putBlob: typeof put = put,
): Promise<LastGoodCopyOutcome> {
  if (!payload) return 'no-payload'
  const controller = new AbortController()
  try {
    const upload = putBlob(LAST_GOOD_COPY_PATH, JSON.stringify(payload), {
      access: 'public',
      token,
      addRandomSuffix: false,
      allowOverwrite: true,
      cacheControlMaxAge: 60,
      contentType: 'application/json',
      abortSignal: controller.signal,
    })
    if (await settleWithin(upload, LAST_GOOD_COPY_UPLOAD_MS, TIMED_OUT) !== TIMED_OUT) return 'written'
    controller.abort()
    console.warn(`[cron] #1531 last-good copy upload still unfinished after ${LAST_GOOD_COPY_UPLOAD_MS} ms`)
    return 'timed-out'
  } catch (err) {
    console.warn('[cron] #1531 last-good copy write failed:', err instanceof Error ? err.message : err)
    return 'write-failed'
  }
}
