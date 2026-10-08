import { describe, it, expect } from 'vitest'
import { latencyCardState, latencyCardSub } from '../latencyCard'
import en from '../../locales/en'

const services = [
  { id: 'claude', name: 'Claude API' },
  { id: 'openai', name: 'OpenAI API' },
  { id: 'claudecode', name: 'Claude Code', probeInheritedFrom: 'claude' },
  { id: 'codex', name: 'Codex', probeInheritedFrom: 'openai' },
  { id: 'cursor', name: 'Cursor' },
  { id: 'chatgpt', name: 'ChatGPT' },
]
const byId = (id) => services.find((s) => s.id === id)

describe('latencyCardState (#883)', () => {
  it('directly-probed service → probe state with its own latency', () => {
    const svc = { ...byId('cursor'), latency: 1561 }
    const r = latencyCardState(svc, ['cursor', 'claude'], { cursor: { rtt: 1561 } }, services)
    expect(r).toEqual({ kind: 'probe', rtt: 1561, parentName: null, failure: null })
  })

  it('inherited service → inherited state showing the PARENT current RTT + parent name', () => {
    const svc = { ...byId('claudecode'), latency: null }
    const r = latencyCardState(svc, ['claude', 'openai'], { claude: { rtt: 2065 } }, services)
    expect(r).toEqual({ kind: 'inherited', rtt: 2065, parentName: 'Claude API', failure: null })
  })

  it('Codex inherits from openai', () => {
    const svc = { ...byId('codex'), latency: null }
    const r = latencyCardState(svc, ['openai'], { openai: { rtt: 2024 } }, services)
    expect(r).toEqual({ kind: 'inherited', rtt: 2024, parentName: 'OpenAI API', failure: null })
  })

  it('inherited but parent has NO probe snapshot yet → rtt null (card shows "collecting")', () => {
    const svc = { ...byId('claudecode'), latency: null }
    const r = latencyCardState(svc, [], {}, services)
    expect(r).toEqual({ kind: 'inherited', rtt: null, parentName: 'Claude API', failure: null })
  })

  it('inherited with a FAILED parent probe (rtt <= 0) → rtt null', () => {
    const svc = { ...byId('claudecode'), latency: null }
    const r = latencyCardState(svc, ['claude'], { claude: { rtt: -1 } }, services)
    expect(r.kind).toBe('inherited')
    expect(r.rtt).toBeNull()
  })

  it('non-probed, non-inheriting service → none, and a stray latency value is NOT shown (#1633)', () => {
    // 88 = a status-page fetch time an older Worker (or a pre-#1633 cache snapshot) still carries.
    const svc = { ...byId('chatgpt'), latency: 88 }
    const r = latencyCardState(svc, ['claude'], { claude: { rtt: 100 } }, services)
    expect(r).toEqual({ kind: 'none', rtt: null, parentName: null, failure: null })
  })

  it('direct probe wins over an inheritance flag (a service that is somehow both)', () => {
    const svc = { id: 'claudecode', name: 'Claude Code', probeInheritedFrom: 'claude', latency: 42 }
    const r = latencyCardState(svc, ['claudecode'], { claudecode: { rtt: 42 } }, services)
    expect(r.kind).toBe('probe')
  })

  it('parent name falls back to the id when the parent is not in the services list', () => {
    const svc = { id: 'claudecode', probeInheritedFrom: 'claude', latency: null }
    const r = latencyCardState(svc, [], {}, [])
    expect(r.parentName).toBe('claude')
  })

  it('tolerates missing probeServiceIds / services args', () => {
    const svc = { id: 'chatgpt', latency: 5 }
    expect(latencyCardState(svc, undefined, undefined, undefined)).toEqual({ kind: 'none', rtt: null, parentName: null, failure: null })
  })
})

describe('latencyCardState — a failed probe is named, not shown as "collecting" (#1644)', () => {
  it('a 5xx on the own probe → no rtt, failure carries the status', () => {
    const svc = { id: 'helicone', name: 'Helicone', latency: null }
    const r = latencyCardState(svc, ['helicone'], { helicone: { status: 502, rtt: 1436 } }, services)
    expect(r).toEqual({ kind: 'probe', rtt: null, parentName: null, failure: { status: 502 } })
  })

  it('a timeout → failure status 0', () => {
    const svc = { id: 'deepgram', name: 'Deepgram', latency: null }
    const r = latencyCardState(svc, ['deepgram'], { deepgram: { status: 0, rtt: -1 } }, services)
    expect(r.failure).toEqual({ status: 0 })
  })

  it("a 5xx on the PARENT's probe → the inherited card shows no rtt and the failure", () => {
    const r = latencyCardState({ ...byId('claudecode'), latency: null }, ['claude'], { claude: { status: 503, rtt: 380 } }, services)
    expect(r).toEqual({ kind: 'inherited', rtt: null, parentName: 'Claude API', failure: { status: 503 } })
  })

  it('a 401 or a 429 is a measured answer, not a failure', () => {
    const svc = { ...byId('cursor'), latency: 140 }
    expect(latencyCardState(svc, ['cursor'], { cursor: { status: 401, rtt: 140 } }, services).failure).toBeNull()
    expect(latencyCardState({ ...byId('codex'), latency: null }, ['openai'], { openai: { status: 429, rtt: 3 } }, services))
      .toEqual({ kind: 'inherited', rtt: 3, parentName: 'OpenAI API', failure: null })
  })
})

describe('latencyCardSub — the sub-line each card state renders (#1644)', () => {
  const t = (k) => en[k] ?? k
  const sub = (svc, ids, latest) => latencyCardSub(latencyCardState(svc, ids, latest, services), t)

  it('a 5xx names the code, a timeout says no response, and neither reads as collecting', () => {
    expect(sub({ id: 'helicone', latency: null }, ['helicone'], { helicone: { status: 502, rtt: 1436 } })).toBe('Probe failed · HTTP 502')
    expect(sub({ id: 'deepgram', latency: null }, ['deepgram'], { deepgram: { status: 0, rtt: -1 } })).toBe('Probe failed · no response')
    expect(sub({ ...byId('claudecode'), latency: null }, ['claude'], { claude: { status: 503, rtt: 380 } })).toBe('Probe failed · HTTP 503')
  })

  it('a measured probe, a not-yet-probed parent and an unprobed service keep their existing lines', () => {
    expect(sub({ ...byId('cursor'), latency: 140 }, ['cursor'], { cursor: { status: 200, rtt: 140 } })).toBe(en['svc.latency.sub'])
    expect(sub({ ...byId('claudecode'), latency: null }, ['openai'], {})).toBe(en['uptime.collecting'])
    expect(sub({ ...byId('chatgpt'), latency: 99 }, ['claude'], {})).toBe(en['svc.latency.notMeasured'])
  })
})
