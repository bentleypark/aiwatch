// #980 — an unlayered rule outranks every Tailwind v4 utility (they live in `@layer utilities`), so an
// unlayered `* { margin: 0; padding: 0 }` zeroed every margin/padding utility in src/.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Selectors of rules outside any `@layer` that put margin/padding on a universal (`*`) selector. */
export function unlayeredUniversalSpacing(css) {
  const src = css.replace(/\/\*[\s\S]*?\*\//g, '')
  const found = []
  const stack = []
  let start = 0
  for (let i = 0; i < src.length; i++) {
    const c = src[i]
    if (c === '{') {
      stack.push(src.slice(start, i).trim())
      start = i + 1
    } else if (c === '}') {
      const prelude = stack.pop() ?? ''
      const body = src.slice(start, i)
      const layered = stack.some((p) => p.startsWith('@layer'))
      const universal = prelude.split(',').some((s) => s.trim() === '*')
      if (!layered && universal && /(^|;)\s*(margin|padding)[\w-]*\s*:/.test(body)) found.push(prelude)
      start = i + 1
    } else if (c === ';' && stack.length === 0) {
      start = i + 1
    }
  }
  return found
}

describe('unlayeredUniversalSpacing', () => {
  it.each([
    ['the #980 reset', '* { box-sizing: border-box; margin: 0; padding: 0 }', ['*']],
    ['a selector list containing *', '*, ::before { padding: 0 }', ['*, ::before']],
    ['inside an unlayered @media', '@media (min-width: 1px) { * { margin: 0 } }', ['*']],
    ['the same reset inside @layer base', '@layer base { * { margin: 0; padding: 0 } }', []],
    ['* with no spacing property', '* { scrollbar-width: thin }', []],
    ['a class selector', '.content-padding { padding: 14px }', []],
    ['a statement at-rule before it', '@import "tailwindcss";\n* { margin: 0 }', ['*']],
  ])('%s', (_, css, expected) => {
    expect(unlayeredUniversalSpacing(css)).toEqual(expected)
  })
})

describe('src/index.css', () => {
  it('has no unlayered universal rule setting margin or padding', () => {
    const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../index.css'), 'utf8')
    expect(unlayeredUniversalSpacing(css)).toEqual([])
  })
})
