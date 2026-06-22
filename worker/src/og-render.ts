// SVG → PNG conversion using @resvg/resvg-wasm for Cloudflare Workers

import { Resvg, initWasm } from '@resvg/resvg-wasm'
// @ts-expect-error — wasm import handled by wrangler bundler
import resvgWasm from '@resvg/resvg-wasm/index_bg.wasm'

const FONT_URL = 'https://cdn.jsdelivr.net/fontsource/fonts/inter@latest/latin-400-normal.woff2'

let wasmState: 'uninitialized' | 'initialized' | 'failed' = 'uninitialized'
let wasmPromise: Promise<void> | null = null
let fontBuffer: ArrayBuffer | null = null
let fontPromise: Promise<void> | null = null

async function ensureWasm(): Promise<void> {
  if (wasmState === 'failed') throw new Error('WASM init previously failed')
  if (wasmState === 'initialized') return
  if (!wasmPromise) {
    wasmPromise = initWasm(resvgWasm).then(
      () => { wasmState = 'initialized' },
      (err) => { wasmState = 'failed'; throw err },
    )
  }
  return wasmPromise
}

// Memoize the in-flight fetch as a shared PROMISE (mirrors `wasmPromise`) — NOT a boolean set before
// the await. A boolean guard flipped before `fetch()` resolves let concurrent callers skip the wait
// and construct Resvg while `fontBuffer` was still null → resvg renders the vector shapes but DROPS
// all text (no embedded font, no WASM fallback) → a text-less OG PNG (the Slack "black box", #740
// follow-up). Awaiting the shared promise guarantees every caller renders only after the font is in.
async function ensureFont(): Promise<void> {
  if (fontBuffer) return
  if (!fontPromise) {
    fontPromise = (async () => {
      const res = await fetch(FONT_URL)
      if (!res.ok) throw new Error(`Font fetch failed: HTTP ${res.status}`)
      fontBuffer = await res.arrayBuffer()
    })().catch((err) => {
      fontPromise = null // reset so a transient CDN failure can retry on the next request
      throw err
    })
  }
  return fontPromise
}

export async function renderPng(svg: string): Promise<Uint8Array> {
  await ensureWasm()
  await ensureFont()
  // Guard: never render with an empty font buffer (would silently drop all text). If the font is
  // somehow absent here, throw so the caller emits its SVG fallback instead of a text-less PNG.
  if (!fontBuffer) throw new Error('Font buffer unavailable — refusing to render text-less PNG')
  const resvg = new Resvg(svg, {
    fitTo: { mode: 'width', value: 1200 },
    font: {
      fontBuffers: fontBuffer ? [new Uint8Array(fontBuffer)] : [],
      defaultFontFamily: 'Inter',
    },
  })
  const rendered = resvg.render()
  return rendered.asPng()
}
