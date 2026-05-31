import { describe, it, expect, vi } from 'vitest'
import handler from '../confirm'

// /confirm is the double-opt-in landing page (#486 PR2). Its security contract: the GET is
// side-effect-free (Discord/scanners PREFETCH links — a GET must not activate), and the reflected
// h/c params are strictly validated before they reach the inline <script> (XSS gate). These tests
// pin both, following the api/__tests__/is-down.test.ts handler-invocation pattern.

const HASH = 'a'.repeat(64)
const CODE = '123456'
const ok = (h = HASH, c = CODE) => new Request(`https://ai-watch.dev/confirm?h=${h}&c=${c}`)

describe('/confirm GET — crawler safety', () => {
  it('does NOT call fetch on GET (no auto-confirm on prefetch)', async () => {
    const f = vi.spyOn(globalThis, 'fetch')
    await handler(ok())
    expect(f).not.toHaveBeenCalled()
    f.mockRestore()
  })

  it('renders the Activate button for a valid hash + code, no-store cache', async () => {
    const res = await handler(ok())
    expect(res.status).toBe(200)
    expect(res.headers.get('Cache-Control')).toContain('no-store')
    const html = await res.text()
    expect(html).toContain('id="go"')
    expect(html).toContain('Activate alerts')
    // the validated params are embedded for the button's POST
    expect(html).toContain(HASH)
    expect(html).toContain(CODE)
    // and the POST target is the worker confirm endpoint
    expect(html).toContain('/api/webhook/confirm')
  })
})

describe('/confirm — worker API target selection (workerApiFor)', () => {
  // The button POSTs to a worker chosen by the request host. A regression that always returned the
  // local worker would make EVERY production confirm silently POST to localhost:8788 and never
  // activate — the render-only tests above wouldn't catch it, so pin the host branch explicitly.
  it('targets the PRODUCTION worker when served from ai-watch.dev', async () => {
    const html = await (await handler(ok())).text()
    expect(html).toContain('aiwatch-worker.p2c2kbf.workers.dev')
    expect(html).not.toContain('localhost:8788')
  })

  it('targets the LOCAL worker when served from localhost (vercel dev)', async () => {
    const res = await handler(new Request(`http://localhost:3333/confirm?h=${HASH}&c=${CODE}`))
    const html = await res.text()
    expect(html).toContain('localhost:8788')
    expect(html).not.toContain('aiwatch-worker.p2c2kbf.workers.dev')
  })

  it('targets the local worker for a 127.0.0.1 host too', async () => {
    const html = await (await handler(new Request(`http://127.0.0.1:3333/confirm?h=${HASH}&c=${CODE}`))).text()
    expect(html).toContain('localhost:8788')
  })
})

describe('/confirm GET — param validation (XSS gate)', () => {
  it('rejects a malformed hash with 400 and renders no button', async () => {
    const res = await handler(new Request('https://ai-watch.dev/confirm?h=short&c=123456'))
    expect(res.status).toBe(400)
    const html = await res.text()
    expect(html).toContain('Invalid confirmation link')
    expect(html).not.toContain('id="go"')
  })

  it('rejects a non-6-digit code with 400', async () => {
    const res = await handler(new Request('https://ai-watch.dev/confirm?h=' + HASH + '&c=12'))
    expect(res.status).toBe(400)
  })

  it('rejects missing params with 400', async () => {
    const res = await handler(new Request('https://ai-watch.dev/confirm'))
    expect(res.status).toBe(400)
  })

  it('rejects an injection attempt in hash (non-hex chars) before reflecting it', async () => {
    // A hash containing </script> or quotes must never reach the inline script — the regex gate
    // returns the 400 page first, so the payload is not echoed into executable context.
    const evil = '"></script><script>alert(1)</script>'
    const res = await handler(new Request('https://ai-watch.dev/confirm?h=' + encodeURIComponent(evil) + '&c=123456'))
    expect(res.status).toBe(400)
    const html = await res.text()
    expect(html).not.toContain('<script>alert(1)</script>')
  })
})
