import { expect } from 'vitest'
import { EXTENSION_STORES } from '../extension-cta'

// #1773 — every store in EXTENSION_STORES reaches the page as its own install link.
export function expectEveryStoreLink(html: string, loc: string): void {
  for (const [store, url] of Object.entries(EXTENSION_STORES)) {
    const a = (html.match(/<a [^>]*data-ga="install_extension"[^>]*>/g) ?? []).filter((t) => t.includes(`data-ga-source="${store}"`))
    expect(a, store).toHaveLength(1)
    expect(a[0]).toContain(`href="${url}"`)
    expect(a[0]).toContain(`data-ga-loc="${loc}"`)
  }
}
