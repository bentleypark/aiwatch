import { describe, it, expect, vi } from 'vitest'

vi.mock('../clarity', () => ({ clarityInitScript: (nonce?: string) => `<script data-clarity-wired="${nonce ?? ''}"></script>` }))

import { renderBadgesPage } from '../../_badges/html-template'
import { renderLandingPage } from '../../_intro/html-template'
import { renderMethodologyPage } from '../../_methodology/html-template'
import { renderPluginPage } from '../../_plugin/html-template'
import { renderPage } from '../../_is-down/html-template'

const seo = { displayName: 'Claude', description: 'd', insight: 'i', whenDown: 'w', faqs: [] }

describe('every Edge page that renders consent-init also renders the Clarity init (#2024)', () => {
  it.each([
    ['badges', () => renderBadgesPage('n1'), 'n1'],
    ['intro', () => renderLandingPage({ nonce: 'n2' }), 'n2'],
    ['methodology', () => renderMethodologyPage('n3'), 'n3'],
    ['plugin', () => renderPluginPage('n4'), 'n4'],
    ['is-down', () => renderPage('claude', null, seo as never, []), ''],
  ])('%s', (_name, render, nonce) => {
    expect(render()).toContain(`<script data-clarity-wired="${nonce}"></script>`)
  })
})
