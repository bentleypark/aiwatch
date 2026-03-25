// SVG → PNG conversion using @resvg/resvg-wasm for Cloudflare Workers

import { Resvg, initWasm } from '@resvg/resvg-wasm'
// @ts-expect-error — wasm import handled by wrangler bundler
import resvgWasm from '@resvg/resvg-wasm/index_bg.wasm'

let initialized = false

export async function renderPng(svg: string): Promise<Uint8Array> {
  if (!initialized) {
    await initWasm(resvgWasm)
    initialized = true
  }
  const resvg = new Resvg(svg, { fitTo: { mode: 'width', value: 1200 } })
  const rendered = resvg.render()
  return rendered.asPng()
}
