import { describe, it, expect, vi, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { fetchService, SERVICES } from '../services'

// #1830 — status.fal.ai saved 2026-10-29. Both notices reference only children of the `API` component
// (`Model API`, and `Serverless API` for the 09-29 one).
const page = readFileSync(fileURLToPath(new URL('./fixtures/fal-page-2026-10-29.html', import.meta.url)), 'utf8')
const fal = SERVICES.find((s) => s.id === 'fal')!

const MAJOR_0904 = 'cmtn4hy2u0d4r1mqj4tgiir1w'
const DEGRADED_0929 = 'cmumesz6f02sk0wmobbyr9i01'
const MODEL_API = 'cmp1437hn01j2bv9drf8hek1u'
const WEBSITE_CHILD_DASHBOARD = 'cmp143r0m010ora58rs3nxgm4'

async function falIncidents(html: string) {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(html, { status: 200 })))
  const svc = await fetchService(fal, undefined, undefined, {})
  return svc.incidents
}

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('#1830 — an incident on a child component of fal API is kept', () => {
  it('keeps both live notices, named by their child components', async () => {
    const incidents = await falIncidents(page)
    const byId = new Map(incidents.map((i) => [i.id, i]))
    expect(byId.get(MAJOR_0904)?.componentNames).toEqual(['Model API'])
    expect(byId.get(MAJOR_0904)?.impact).toBe('major')
    expect(byId.get(DEGRADED_0929)?.componentNames).toEqual(['Serverless API', 'Model API'])
  })

  it('still drops a notice that references only a Website child', async () => {
    const websiteOnly = page.split(`{\\"id\\":\\"${MODEL_API}\\"}`).join(`{\\"id\\":\\"${WEBSITE_CHILD_DASHBOARD}\\"}`)
    expect(websiteOnly, 'the fixture rewrite must change the notice references').not.toBe(page)
    const ids = (await falIncidents(websiteOnly)).map((i) => i.id)
    expect(ids).not.toContain(MAJOR_0904)
  })
})

describe('#1830 — the unresolved-reference warning', () => {
  const unresolvedWarns = (spy: { mock: { calls: unknown[][] } }) =>
    spy.mock.calls.filter((args) => String(args[0]).includes('none resolved')).length

  it('stays silent on the live page, where every reference resolves', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await falIncidents(page)
    expect(unresolvedWarns(warn)).toBe(0)
  })

  it('warns when a notice references only ids the page does not define', async () => {
    const unknownRefs = page.split(`{\\"id\\":\\"${MODEL_API}\\"}`).join('{\\"id\\":\\"cmpunknownzzzzzzzzzzzzzzz\\"}')
    expect(unknownRefs, 'the fixture rewrite must change the notice references').not.toBe(page)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await falIncidents(unknownRefs)
    expect(unresolvedWarns(warn)).toBeGreaterThan(0)
  })
})
