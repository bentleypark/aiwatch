import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Mock the WASM binary import + the resvg module so renderPng runs without a real WASM runtime.
// `Resvg` captures the fontBuffers length each construction received — the bug under test is that
// concurrent renders constructed Resvg with an EMPTY fontBuffers array (font not yet fetched), so
// resvg dropped all text → a text-less OG PNG (the Slack "black box", #740 follow-up).
vi.mock('@resvg/resvg-wasm/index_bg.wasm', () => ({ default: new Uint8Array() }))

const { fontBufferLengths } = vi.hoisted(() => ({ fontBufferLengths: [] as number[] }))
vi.mock('@resvg/resvg-wasm', () => ({
  initWasm: vi.fn().mockResolvedValue(undefined),
  Resvg: class {
    constructor(_svg: string, opts: { font?: { fontBuffers?: Uint8Array[] } }) {
      fontBufferLengths.push(opts.font?.fontBuffers?.length ?? 0)
    }
    render() {
      return { asPng: () => new Uint8Array([1, 2, 3]) }
    }
  },
}))

// A deferred promise lets us hold the font fetch in-flight while a second renderPng() starts — the
// exact concurrency window the old boolean `fontFetched` guard mishandled.
function deferred<T>() {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

describe('og-render renderPng — font fetch race (#740 follow-up)', () => {
  beforeEach(() => {
    fontBufferLengths.length = 0
    vi.resetModules() // fresh module-private fontBuffer/fontPromise state per test
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('embeds the font for ALL concurrent renders (no text-less PNG) and fetches the font once', async () => {
    const d = deferred<Response>()
    const fetchMock = vi.fn().mockReturnValue(d.promise)
    vi.stubGlobal('fetch', fetchMock)

    const { renderPng } = await import('../og-render')

    // Start TWO renders before the font fetch resolves — the second must AWAIT the same fetch, not
    // skip ahead and render with an empty font buffer.
    const p1 = renderPng('<svg/>')
    const p2 = renderPng('<svg/>')
    await Promise.resolve() // let both reach `await ensureFont()`

    d.resolve({ ok: true, arrayBuffer: async () => new ArrayBuffer(8) } as Response)
    await Promise.all([p1, p2])

    expect(fetchMock).toHaveBeenCalledTimes(1) // shared promise → single fetch
    expect(fontBufferLengths).toHaveLength(2)
    // The bug: one of these would be 0 (empty fontBuffers → text-less render).
    expect(fontBufferLengths.every((n) => n === 1)).toBe(true)
  })

  it('throws (→ SVG fallback) instead of rendering text-less when the font fetch fails', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 503 } as Response)
    vi.stubGlobal('fetch', fetchMock)

    const { renderPng } = await import('../og-render')
    await expect(renderPng('<svg/>')).rejects.toThrow(/Font fetch failed/)
    // No Resvg constructed at all when the font is unavailable.
    expect(fontBufferLengths).toHaveLength(0)
  })

  it('retries the font fetch on the next request after a transient failure', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 503 } as Response)
      .mockResolvedValueOnce({ ok: true, arrayBuffer: async () => new ArrayBuffer(8) } as Response)
    vi.stubGlobal('fetch', fetchMock)

    const { renderPng } = await import('../og-render')
    await expect(renderPng('<svg/>')).rejects.toThrow() // first fails
    await renderPng('<svg/>') // fontPromise was reset → retries and succeeds

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fontBufferLengths).toEqual([1])
  })
})
