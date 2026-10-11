import { describe, it, expect, vi } from 'vitest'
import { audienceBeaconScript } from '../_shared/audience-beacon'

/** Run the emitted script against a stub page and return the JSON body it posted. */
function postedBody(search: string, referrer = ''): Record<string, unknown> {
  const fetchStub = vi.fn().mockResolvedValue(undefined)
  const run = new Function('location', 'document', 'fetch', audienceBeaconScript('claude', true, 'group'))
  run({ search }, { referrer }, fetchStub)
  return JSON.parse(fetchStub.mock.calls[0][1].body)
}

describe('audience beacon (#1653)', () => {
  it('sends utm_content alongside utm_source, so the worker can split reply from post', () => {
    expect(postedBody('?utm_source=x&utm_content=reply')).toMatchObject({ utm: 'x', uc: 'reply' })
    expect(postedBody('?utm_source=x&utm_content=post')).toMatchObject({ utm: 'x', uc: 'post' })
  })
  it('sends an empty utm_content when the link has none', () => {
    expect(postedBody('?utm_source=x')).toMatchObject({ utm: 'x', uc: '' })
  })
})
