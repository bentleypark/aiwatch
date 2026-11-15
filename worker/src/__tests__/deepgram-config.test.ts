// #2002 — pin the Deepgram scope against status.deepgram.com components.json as served 2026-11-15
// (39 components: the Global group, three regional groups added 2026-11-13, and the non-API groups).

import { describe, it, expect } from 'vitest'
import { SERVICES, atlassianRosterAuditServices, uptimeScopeOf } from '../services'
import { rosterAgedInFindings } from '../roster-audit'
import { atlassianRosterEntries } from '../parsers/statuspage'

const deepgram = SERVICES.find((s) => s.id === 'deepgram')!

// [id, name, created_at, group_id, group header?]
const PAGE: Array<[string, string, string, string | null, boolean]> = [
  ['cv8l6gg3cb9d', 'Deepgram Global API (api.deepgram.com)', '2022-01-06T00:00:00Z', null, true],
  ['m49xkwqkc4kh', 'STT Batch API', '2022-01-06T00:00:00Z', 'cv8l6gg3cb9d', false],
  ['l4ch656gbn1k', 'Developer Documentation', '2022-01-06T00:00:00Z', 'y4btfh52r1qh', false],
  ['l2n5q03f22t4', 'License Validation', '2022-01-24T00:00:00Z', 'cv7wd8pvvqh4', false],
  ['vzywqf1842nh', 'STT Batch API', '2026-11-13T00:00:00Z', 'h9vl9tdztvhy', false],
  ['vgr4wx93xm64', 'STT Batch API', '2026-11-13T00:00:00Z', 'mhm180xwg1yh', false],
  ['67ptg896ck3y', 'STT Batch API', '2026-11-13T00:00:00Z', 'rpbvy9wml5n2', false],
  ['s6v5z4lsl658', 'STT Streaming API', '2022-01-06T00:00:00Z', 'cv8l6gg3cb9d', false],
  ['jgfq9ffjsfqk', 'Usage API', '2022-01-06T00:00:00Z', 'cv7wd8pvvqh4', false],
  ['h9vl9tdztvhy', 'Deepgram AU API (api.au.deepgram.com)', '2026-11-13T00:00:00Z', null, true],
  ['fbk9dbyszcq7', 'STT Streaming API', '2026-11-13T00:00:00Z', 'h9vl9tdztvhy', false],
  ['rdgmkhrrp8bl', 'STT Streaming API', '2026-11-13T00:00:00Z', 'mhm180xwg1yh', false],
  ['tx6mbbk051hm', 'STT Streaming API', '2026-11-13T00:00:00Z', 'rpbvy9wml5n2', false],
  ['cvbdk3fslx9v', 'Developer Console', '2022-01-06T00:00:00Z', 'vhv1mkf16jjw', false],
  ['dspsk5mtjzqt', 'Deepgram Website', '2022-01-06T00:00:00Z', 'y4btfh52r1qh', false],
  ['6854s60zwxgw', 'TTS Batch API', '2024-03-18T00:00:00Z', 'cv8l6gg3cb9d', false],
  ['zzf5vl6hc18c', 'TTS Batch API', '2026-11-13T00:00:00Z', 'h9vl9tdztvhy', false],
  ['mhm180xwg1yh', 'Deepgram EU API (api.eu.deepgram.com)', '2026-11-13T00:00:00Z', null, true],
  ['yj914v8720kf', 'TTS Batch API', '2026-11-13T00:00:00Z', 'mhm180xwg1yh', false],
  ['06yq2x1nttt4', 'TTS Batch API', '2026-11-13T00:00:00Z', 'rpbvy9wml5n2', false],
  ['t80v4qz2jdsf', 'API Playground', '2024-10-23T00:00:00Z', 'vhv1mkf16jjw', false],
  ['gcdcfvkrksww', 'TTS Streaming API', '2026-11-13T00:00:00Z', 'h9vl9tdztvhy', false],
  ['rpbvy9wml5n2', 'Deepgram IN API (api.in.deepgram.com)', '2026-11-13T00:00:00Z', null, true],
  ['smz6tzfqz3f3', 'TTS Streaming API', '2026-11-13T00:00:00Z', 'rpbvy9wml5n2', false],
  ['n25c7zcftj6w', 'TTS Streaming API', '2026-11-13T00:00:00Z', 'cv8l6gg3cb9d', false],
  ['9rr5yjkk8nfg', 'TTS Streaming API', '2026-11-13T00:00:00Z', 'mhm180xwg1yh', false],
  ['cv7wd8pvvqh4', 'On-Premise', '2022-01-06T00:00:00Z', null, true],
  ['vm1x1v101qtn', 'Management APIs', '2024-10-23T00:00:00Z', 'vhv1mkf16jjw', false],
  ['r2z04fcdhhzb', 'Voice Agent API', '2025-10-14T00:00:00Z', 'cv8l6gg3cb9d', false],
  ['pt7xq5nh28cw', 'Voice Agent API', '2026-11-13T00:00:00Z', 'h9vl9tdztvhy', false],
  ['mkzqm71d1glf', 'Voice Agent API: Downstream Providers', '2026-11-13T00:00:00Z', 'mhm180xwg1yh', false],
  ['jzfh8qdcbzsf', 'Voice Agent API', '2026-11-13T00:00:00Z', 'rpbvy9wml5n2', false],
  ['vhv1mkf16jjw', 'Developer Console / Management APIs', '2022-01-06T00:00:00Z', null, true],
  ['7n3stjcbj4bx', 'Voice Agent API: Downstream Providers', '2025-10-16T00:00:00Z', 'cv8l6gg3cb9d', false],
  ['xzcth3z6ntnr', 'Voice Agent API: Downstream Providers', '2026-11-13T00:00:00Z', 'h9vl9tdztvhy', false],
  ['9hx742slyr5m', 'Voice Agent API', '2026-11-13T00:00:00Z', 'mhm180xwg1yh', false],
  ['gxbl4w7n0q3d', 'Voice Agent API: Downstream Providers', '2026-11-13T00:00:00Z', 'rpbvy9wml5n2', false],
  ['y4btfh52r1qh', 'Documentation', '2022-01-06T00:00:00Z', null, true],
  ['vsnk4gb1bb47', 'DG Whisper Cloud', '2023-06-09T00:00:00Z', 'cv8l6gg3cb9d', false],
]
const GLOBAL = 'cv8l6gg3cb9d'
const REGIONAL_GROUPS = ['h9vl9tdztvhy', 'mhm180xwg1yh', 'rpbvy9wml5n2']
const isRegional = (id: string, groupId: string | null) => REGIONAL_GROUPS.includes(id) || (groupId !== null && REGIONAL_GROUPS.includes(groupId))

describe('deepgram scope (#2002)', () => {
  it('every Global-group child is shown in the breakdown', () => {
    const shown = new Set(deepgram.displayComponentIds)
    for (const [id, name, , groupId] of PAGE) {
      if (groupId === GLOBAL) expect(shown.has(id), `${id} ${name}`).toBe(true)
    }
  })

  it('every regional component is roster-excluded and none is in the badge or breakdown scope', () => {
    const excluded = new Set(deepgram.rosterAuditExclude)
    const scope = new Set([...(deepgram.statusComponentIds ?? []), ...(deepgram.displayComponentIds ?? [])])
    for (const [id, name, , groupId] of PAGE) {
      if (!isRegional(id, groupId)) continue
      expect(excluded.has(id), `${id} ${name}`).toBe(true)
      expect(scope.has(id), `${id} ${name}`).toBe(false)
    }
  })

  it('the live page yields no aged-in roster finding under the real config, 30+ days after the regional groups appeared', () => {
    const config = atlassianRosterAuditServices().find((s) => s.id === 'deepgram')!
    const comps = PAGE.map(([id, , created_at, group_id]) => ({ id, created_at, group_id }))
    expect(rosterAgedInFindings(atlassianRosterEntries(comps), uptimeScopeOf(config), config.rosterAuditExclude ?? [], false, Date.parse('2026-12-20T00:00:00Z'))).toEqual([])
  })
})
