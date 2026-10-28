import { describe, it, expect, vi } from 'vitest'
import { writeLastGoodCopy, LAST_GOOD_COPY_UPLOAD_MS } from '../last-good-copy'
import { LAST_GOOD_COPY_PATH } from '../last-good-copy-path'

type PutBlob = NonNullable<Parameters<typeof writeLastGoodCopy>[2]>

describe('writeLastGoodCopy (#1531 Part 7)', () => {
  it('overwrites the one public blob with the payload, cached for the minimum minute', async () => {
    const putBlob = vi.fn(async () => ({}) as never) as unknown as PutBlob
    const payload = { services: [{ id: 'claude', status: 'operational' }], lastUpdated: '2026-10-28T11:00:00.000Z' }
    expect(await writeLastGoodCopy(payload, 'tok', putBlob)).toBe('written')
    expect(putBlob).toHaveBeenCalledTimes(1)
    const [path, body, opts] = vi.mocked(putBlob).mock.calls[0]
    expect(path).toBe(LAST_GOOD_COPY_PATH)
    expect(JSON.parse(body as string)).toEqual(payload)
    expect(opts).toMatchObject({ access: 'public', token: 'tok', addRandomSuffix: false, allowOverwrite: true, cacheControlMaxAge: 60, contentType: 'application/json' })
  })

  it('writes nothing when there is no snapshot to copy', async () => {
    const putBlob = vi.fn() as unknown as PutBlob
    expect(await writeLastGoodCopy(null, 'tok', putBlob)).toBe('no-payload')
    expect(putBlob).not.toHaveBeenCalled()
  })

  it('an upload still retrying at the bound is abandoned and aborted, so the cron tick moves on', async () => {
    vi.useFakeTimers()
    try {
      let signal: AbortSignal | undefined
      const putBlob = vi.fn((_p: string, _b: unknown, opts: { abortSignal?: AbortSignal }) => {
        signal = opts.abortSignal
        return new Promise(() => {})
      }) as unknown as PutBlob
      const result = writeLastGoodCopy({ services: [] }, 'tok', putBlob)
      await vi.advanceTimersByTimeAsync(LAST_GOOD_COPY_UPLOAD_MS)
      expect(await result).toBe('timed-out')
      expect(signal?.aborted).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('a failed upload is reported, not thrown into the cron', async () => {
    const putBlob = vi.fn(async () => { throw new Error('Vercel Blob: Access denied') }) as unknown as PutBlob
    expect(await writeLastGoodCopy({ services: [] }, 'tok', putBlob)).toBe('write-failed')
  })
})
