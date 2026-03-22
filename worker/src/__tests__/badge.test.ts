import { describe, it, expect } from 'vitest'
import { generateBadgeSvg, escapeXml } from '../badge'

describe('escapeXml', () => {
  it('escapes & < > "', () => {
    expect(escapeXml('a&b')).toBe('a&amp;b')
    expect(escapeXml('<script>')).toBe('&lt;script&gt;')
    expect(escapeXml('"hello"')).toBe('&quot;hello&quot;')
  })

  it('handles empty string', () => {
    expect(escapeXml('')).toBe('')
  })

  it('passes through safe text', () => {
    expect(escapeXml('Claude API')).toBe('Claude API')
  })
})

describe('generateBadgeSvg', () => {
  it('generates valid SVG with label and status', () => {
    const svg = generateBadgeSvg('Claude API', 'operational', '#3fb950', 'flat')
    expect(svg).toContain('<svg')
    expect(svg).toContain('Claude API')
    expect(svg).toContain('operational')
    expect(svg).toContain('fill="#3fb950"')
    expect(svg).toContain('rx="3"') // flat style = rounded
  })

  it('uses rx=0 for flat-square style', () => {
    const svg = generateBadgeSvg('Test', 'up', '#3fb950', 'flat-square')
    expect(svg).toContain('rx="0"')
  })

  it('escapes XSS in label', () => {
    const svg = generateBadgeSvg('<script>alert(1)</script>', 'ok', '#3fb950', 'flat')
    expect(svg).not.toContain('<script>')
    expect(svg).toContain('&lt;script&gt;')
  })

  it('escapes XSS in status', () => {
    const svg = generateBadgeSvg('Test', '"><img onerror=alert(1)>', '#3fb950', 'flat')
    // The < and > and " are escaped, so the img tag cannot be parsed as HTML
    expect(svg).not.toContain('<img')
    expect(svg).toContain('&lt;img')
    expect(svg).toContain('&quot;&gt;')
  })

  it('sanitizes invalid color to fallback gray', () => {
    const svg = generateBadgeSvg('Test', 'ok', 'javascript:alert(1)', 'flat')
    expect(svg).toContain('fill="#9e9e9e"')
    expect(svg).not.toContain('javascript')
  })

  it('accepts valid hex colors', () => {
    expect(generateBadgeSvg('T', 'ok', '#fff', 'flat')).toContain('fill="#fff"')
    expect(generateBadgeSvg('T', 'ok', '#3fb950', 'flat')).toContain('fill="#3fb950"')
    expect(generateBadgeSvg('T', 'ok', '#FF5733AA', 'flat')).toContain('fill="#FF5733AA"')
  })

  it('includes aria-label and title for accessibility', () => {
    const svg = generateBadgeSvg('Claude API', 'down', '#f85149', 'flat')
    expect(svg).toContain('aria-label="Claude API: down"')
    expect(svg).toContain('<title>Claude API: down</title>')
  })

  it('calculates width based on text length', () => {
    const short = generateBadgeSvg('A', 'B', '#fff', 'flat')
    const long = generateBadgeSvg('Very Long Service Name', 'operational', '#fff', 'flat')
    const shortWidth = parseInt(short.match(/width="(\d+)"/)?.[1] ?? '0')
    const longWidth = parseInt(long.match(/width="(\d+)"/)?.[1] ?? '0')
    expect(longWidth).toBeGreaterThan(shortWidth)
  })
})
