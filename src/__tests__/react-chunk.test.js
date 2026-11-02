// #1881 — React ships in its own chunk.
import { describe, it, expect } from 'vitest'
import config, { REACT_CHUNK } from '../../vite.config.js'

describe('react chunk', () => {
  it('is the code-splitting group the SPA build uses', () => {
    expect(config.build.rolldownOptions.output.codeSplitting.groups).toEqual([REACT_CHUNK])
  })

  it.each([
    ['/repo/node_modules/react/index.js', true],
    ['/repo/node_modules/react-dom/client.js', true],
    ['/repo/node_modules/scheduler/index.js', true],
    ['C:\\repo\\node_modules\\react-dom\\client.js', true],
    ['/repo/node_modules/chart.js/dist/chart.js', false],
    ['/repo/node_modules/web-vitals/dist/web-vitals.js', false],
    ['/repo/node_modules/react-is/index.js', false],
    ['/repo/src/react/index.js', false],
  ])('%s → %s', (id, expected) => {
    expect(REACT_CHUNK.test.test(id)).toBe(expected)
  })
})
