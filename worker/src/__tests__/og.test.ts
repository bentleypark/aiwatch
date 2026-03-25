import { describe, it, expect } from 'vitest'
import { generateOgSvg } from '../og'

describe('generateOgSvg', () => {
  it('generates valid SVG with service name and status', () => {
    const svg = generateOgSvg('Claude API', 'operational', '90', '99.28')
    expect(svg).toContain('<svg')
    expect(svg).toContain('Is Claude API Down?')
    expect(svg).toContain('Operational')
    expect(svg).toContain('#3fb950') // green
    expect(svg).toContain('Score:')
    expect(svg).toContain('90')
    expect(svg).toContain('Uptime:')
    expect(svg).toContain('99.28%')
  })

  it('uses degraded style for degraded status', () => {
    const svg = generateOgSvg('OpenAI', 'degraded', '', '')
    expect(svg).toContain('Degraded')
    expect(svg).toContain('#e86235') // amber
  })

  it('uses down style for down status', () => {
    const svg = generateOgSvg('Gemini', 'down', '', '')
    expect(svg).toContain('Down')
    expect(svg).toContain('#f85149') // red
  })

  it('falls back to operational for unknown status', () => {
    const svg = generateOgSvg('Test', 'maintenance', '', '')
    expect(svg).toContain('Operational')
    expect(svg).toContain('#3fb950')
  })

  it('omits metrics when score and uptime are empty', () => {
    const svg = generateOgSvg('Claude', 'operational', '', '')
    expect(svg).not.toContain('Score:')
    expect(svg).not.toContain('Uptime:')
  })

  it('escapes XSS in service name', () => {
    const svg = generateOgSvg('<script>alert(1)</script>', 'down', '', '')
    expect(svg).not.toContain('<script>')
    expect(svg).toContain('&lt;script&gt;')
  })

  it('escapes special characters in score and uptime', () => {
    const svg = generateOgSvg('Test', 'operational', '9"0', '99&5')
    expect(svg).toContain('9&quot;0')
    expect(svg).toContain('99&amp;5%')
  })

  it('truncates long service names', () => {
    const longName = 'A'.repeat(100)
    const svg = generateOgSvg(longName, 'operational', '', '')
    // generateOgSvg slices to 50 chars
    expect(svg).toContain('A'.repeat(50))
    expect(svg).not.toContain('A'.repeat(51))
  })
})
