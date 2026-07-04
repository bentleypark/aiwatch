import { describe, it, expect } from 'vitest'
import { latencyCardState } from '../latencyCard'

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
    expect(r).toEqual({ kind: 'probe', rtt: 1561, parentName: null })
  })

  it('inherited service → inherited state showing the PARENT current RTT + parent name', () => {
    const svc = { ...byId('claudecode'), latency: null }
    const r = latencyCardState(svc, ['claude', 'openai'], { claude: { rtt: 2065 } }, services)
    expect(r).toEqual({ kind: 'inherited', rtt: 2065, parentName: 'Claude API' })
  })

  it('Codex inherits from openai', () => {
    const svc = { ...byId('codex'), latency: null }
    const r = latencyCardState(svc, ['openai'], { openai: { rtt: 2024 } }, services)
    expect(r).toEqual({ kind: 'inherited', rtt: 2024, parentName: 'OpenAI API' })
  })

  it('inherited but parent has NO probe snapshot yet → rtt null (card shows "collecting")', () => {
    const svc = { ...byId('claudecode'), latency: null }
    const r = latencyCardState(svc, [], {}, services)
    expect(r).toEqual({ kind: 'inherited', rtt: null, parentName: 'Claude API' })
  })

  it('inherited with a FAILED parent probe (rtt <= 0) → rtt null', () => {
    const svc = { ...byId('claudecode'), latency: null }
    const r = latencyCardState(svc, ['claude'], { claude: { rtt: -1 } }, services)
    expect(r.kind).toBe('inherited')
    expect(r.rtt).toBeNull()
  })

  it('non-probed, non-inheriting service → statusPage state with status-page timing', () => {
    const svc = { ...byId('chatgpt'), latency: 88 }
    const r = latencyCardState(svc, ['claude'], { claude: { rtt: 100 } }, services)
    expect(r).toEqual({ kind: 'statusPage', rtt: 88, parentName: null })
  })

  it('statusPage with no timing → rtt null (card shows "—")', () => {
    const svc = { ...byId('chatgpt'), latency: null }
    expect(latencyCardState(svc, [], {}, services).rtt).toBeNull()
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
    expect(latencyCardState(svc, undefined, undefined, undefined)).toEqual({ kind: 'statusPage', rtt: 5, parentName: null })
  })
})
