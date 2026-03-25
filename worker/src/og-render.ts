// SVG → PNG conversion using @resvg/resvg-wasm for Cloudflare Workers

import { Resvg, initWasm } from '@resvg/resvg-wasm'
// @ts-expect-error — wasm import handled by wrangler bundler
import resvgWasm from '@resvg/resvg-wasm/index_bg.wasm'

let initialized = false
let fontBuffer: ArrayBuffer | null = null

const FONT_URL = 'https://cdn.jsdelivr.net/fontsource/fonts/inter@latest/latin-400-normal.woff2'

export async function renderPng(svg: string): Promise<Uint8Array> {
  if (!initialized) {
    await initWasm(resvgWasm)
    initialized = true
  }
  if (!fontBuffer) {
    const res = await fetch(FONT_URL)
    if (res.ok) fontBuffer = await res.arrayBuffer()
  }
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
