import { describe, it, expect } from 'vitest'
import { orderServicesForTicker, tickerClassesFor } from '../TickerBar'
import { SERVICE_CATEGORIES } from '../../utils/constants'

// #658 — the header ticker scrolls services in the dev-audience category order
// (LLM APIs → Coding Agents → Voice → Inference & Infra → Video → AI Apps), with
// no group dividers. Pin the ordering invariant here so a future SERVICE_CATEGORIES
// reorder (or a regression to the old api/app-vs-agent split) is caught.

const idOf = (s) => s.id

describe('orderServicesForTicker', () => {
  it('orders services by the flattened SERVICE_CATEGORIES (dev-audience) sequence', () => {
    const expected = Object.keys(SERVICE_CATEGORIES)
      .filter((k) => k !== 'all')
      .flatMap((k) => SERVICE_CATEGORIES[k].ids)
    // Feed in a deliberately shuffled copy.
    const shuffled = [...expected].reverse().map((id) => ({ id, name: id, status: 'operational' }))
    expect(orderServicesForTicker(shuffled).map(idOf)).toEqual(expected)
  })

  it('places Coding Agents right after LLM APIs — not last (the #658 fix)', () => {
    const sample = ['claudeai', 'claude', 'claudecode', 'chatgpt', 'cursor'].map((id) => ({
      id,
      name: id,
      status: 'operational',
    }))
    const order = orderServicesForTicker(sample).map(idOf)
    const lastLlm = Math.max(...['claude'].map((id) => order.indexOf(id)))
    const firstAgent = Math.min(...['claudecode', 'cursor'].map((id) => order.indexOf(id)))
    const firstApp = Math.min(...['claudeai', 'chatgpt'].map((id) => order.indexOf(id)))
    // LLM before agents, agents before apps.
    expect(lastLlm).toBeLessThan(firstAgent)
    expect(firstAgent).toBeLessThan(firstApp)
  })

  it('is non-mutating and tolerates null/unknown ids', () => {
    const input = [{ id: 'mystery', name: 'Mystery', status: 'down' }, { id: 'claude', name: 'Claude', status: 'operational' }]
    const snapshot = [...input]
    const out = orderServicesForTicker(input)
    expect(input).toEqual(snapshot) // original untouched
    expect(out[0].id).toBe('claude') // known id first, unknown sorts to end
    expect(out[out.length - 1].id).toBe('mystery')
    expect(orderServicesForTicker(null)).toEqual([])
    expect(orderServicesForTicker(undefined)).toEqual([])
  })
})

// #1233 — the ticker is the dashboard's always-visible status strip, and its two class maps had no
// `unknown` entry. A missing key fell through `?? operational`, so a service whose status source
// AIWatch could not read rendered a GREEN dot — worse than the amber it replaced, because it asserts
// health rather than an outage. The maps are keyed lookups, so nothing else could have caught this:
// not the type checker (plain JS), not the `.status === '...'` sweep this refactor was built around.
describe('tickerClassesFor (#1233)', () => {
  it('gives an unreadable source the NEUTRAL classes — never the operational ones', () => {
    const unknown = tickerClassesFor('unknown')
    const operational = tickerClassesFor('operational')
    expect(unknown.dot).not.toBe(operational.dot)
    expect(unknown.dot).toContain('--text2')
    expect(unknown.text).toContain('--text2')
  })

  it('an UNRECOGNISED status also falls to neutral, not to green', () => {
    // The fail-safe direction: a value we cannot interpret must not claim health.
    expect(tickerClassesFor('maintenance').dot).toBe(tickerClassesFor('unknown').dot)
    expect(tickerClassesFor(undefined).dot).toBe(tickerClassesFor('unknown').dot)
  })

  it('controls: the three known verdicts keep their own colours', () => {
    expect(tickerClassesFor('operational').dot).toContain('--green')
    expect(tickerClassesFor('degraded').dot).toContain('--amber')
    expect(tickerClassesFor('down').dot).toContain('--red')
  })
})
