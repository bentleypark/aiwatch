// #1893 — theme tokens are pinned by role (which surface sits above which) and by WCAG AA contrast,
// not by their hex spelling.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SCORE_BADGE_CLASS, SCORE_TEXT_CLASS } from '../utils/constants'
import { PILL_CLASS } from '../utils/statusDisplay'

const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../index.css'), 'utf8')

function tokensIn(selector) {
  const start = css.indexOf(`${selector} {`)
  if (start < 0) throw new Error(`no ${selector} block in index.css`)
  const body = css.slice(start, css.indexOf('\n}', start))
  return Object.fromEntries([...body.matchAll(/--([\w-]+):\s*(#[0-9a-fA-F]{6})\b/g)].map((m) => [m[1], m[2]]))
}

const dark = tokensIn(':root')
const lightOverrides = tokensIn('[data-theme="light"]')
const light = { ...dark, ...lightOverrides }
const THEMES = { dark, light }
const ROLE_TOKENS = ['bg0', 'bg1', 'bg2', 'bg3', 'bg4', 'bg-selected', 'on-accent', 'text0', 'text1', 'text2',
  'green', 'yellow', 'amber', 'red', 'blue', 'teal', 'purple',
  'yellow-text', 'on-yellow', 'status-bg-green', 'status-bg-yellow', 'status-bg-amber', 'status-bg-red', 'blue-dim']

function luminance(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
  const lin = (c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
}

function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

const AA = 4.5

describe('theme tokens (#1893)', () => {
  it('both theme blocks define every role token, so no light value silently falls back to dark', () => {
    for (const t of ROLE_TOKENS) {
      expect(dark[t], `:root --${t}`).toMatch(/^#/)
      expect(lightOverrides[t], `light --${t}`).toMatch(/^#/)
    }
  })

  for (const [name, th] of Object.entries(THEMES)) {
    it(`${name}: cards and bars (bg1) sit above the page (bg0)`, () => {
      expect(luminance(th.bg1)).toBeGreaterThan(luminance(th.bg0))
    })

    it(`${name}: a selected segment is lighter than the track it sits in (bg2)`, () => {
      expect(luminance(th['bg-selected'])).toBeGreaterThan(luminance(th.bg2))
    })

    it(`${name}: list-row and control hover fills (bg1→bg2, bg0→bg3, bg2→bg3) change visibly`, () => {
      for (const [rest, hover] of [['bg1', 'bg2'], ['bg0', 'bg3'], ['bg2', 'bg3']]) {
        expect(contrast(th[rest], th[hover]), `${rest} -> ${hover}`).toBeGreaterThan(1.05)
      }
    })

    it(`${name}: yellow and amber differ in lightness, not only in hue`, () => {
      expect(contrast(th.yellow, th.amber)).toBeGreaterThanOrEqual(1.2)
    })
  }

  it('light: text and status colours meet AA on the surface tokens bg0–bg3', () => {
    const fg = ['text0', 'text1', 'text2', 'green', 'yellow-text', 'amber', 'red', 'blue', 'teal', 'purple']
    for (const surface of ['bg0', 'bg1', 'bg2', 'bg3']) {
      for (const f of fg) expect(contrast(light[f], light[surface]), `${f} on ${surface}`).toBeGreaterThanOrEqual(AA)
    }
  })

  it('light: text on a solid status fill (on-accent) meets AA', () => {
    for (const fill of ['green', 'amber', 'red', 'blue']) {
      expect(contrast(light['on-accent'], light[fill]), `on-accent on ${fill}`).toBeGreaterThanOrEqual(AA)
    }
  })

  it('light: a status colour on its own pill background meets AA', () => {
    for (const [fg, pill] of [['green', 'status-bg-green'], ['amber', 'status-bg-amber'], ['red', 'status-bg-red'], ['blue', 'blue-dim']]) {
      expect(contrast(light[fg], light[pill]), `${fg} on ${pill}`).toBeGreaterThanOrEqual(AA)
    }
  })

  const tokenOf = (cls, prefix) => cls.match(new RegExp(`${prefix}-\\[var\\(--([\\w-]+)\\)\\]`))?.[1]

  for (const [name, th] of Object.entries(THEMES)) {
    it(`${name}: every score badge's text meets AA on its fill`, () => {
      for (const [grade, cls] of Object.entries(SCORE_BADGE_CLASS)) {
        const [bg, fg] = [tokenOf(cls, 'bg'), tokenOf(cls, 'text')]
        expect(contrast(th[fg], th[bg]), `${grade}: ${fg} on ${bg}`).toBeGreaterThanOrEqual(AA)
      }
    })

    it(`${name}: every score text colour meets AA on a card and on its hover (bg1, bg3)`, () => {
      for (const [grade, cls] of Object.entries(SCORE_TEXT_CLASS)) {
        for (const surface of ['bg1', 'bg3']) {
          expect(contrast(th[tokenOf(cls, 'text')], th[surface]), `${grade} on ${surface}`).toBeGreaterThanOrEqual(AA)
        }
      }
    })

    it(`${name}: every status pill's text meets AA on its own background`, () => {
      for (const [status, cls] of Object.entries(PILL_CLASS)) {
        const [bg, fg] = [tokenOf(cls, 'bg'), tokenOf(cls, 'text')]
        expect(contrast(th[fg], th[bg]), `${status}: ${fg} on ${bg}`).toBeGreaterThanOrEqual(AA)
      }
    })
  }
})
