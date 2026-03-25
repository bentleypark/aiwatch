// SVG → PNG conversion using @resvg/resvg-wasm for Cloudflare Workers

import { Resvg, initWasm } from '@resvg/resvg-wasm'
// @ts-expect-error — wasm import handled by wrangler bundler
import resvgWasm from '@resvg/resvg-wasm/index_bg.wasm'

const FONT_URL = 'https://cdn.jsdelivr.net/fontsource/fonts/inter@latest/latin-400-normal.woff2'

let wasmState: 'uninitialized' | 'initialized' | 'failed' = 'uninitialized'
let wasmPromise: Promise<void> | null = null
let fontBuffer: ArrayBuffer | null = null
let fontFetched = false

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

async function ensureFont(): Promise<void> {
  if (fontFetched) return
  fontFetched = true
  const res = await fetch(FONT_URL)
  if (!res.ok) throw new Error(`Font fetch failed: HTTP ${res.status}`)
  fontBuffer = await res.arrayBuffer()
}

export async function renderPng(svg: string): Promise<Uint8Array> {
  await ensureWasm()
  await ensureFont()
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
