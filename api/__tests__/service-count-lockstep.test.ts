// #1074 — the monitored-service COUNT and its 8-bucket category BREAKDOWN are hardcoded prose on five
// public surfaces (two Edge SSR templates, the SPA's static index.html, and both READMEs). Nothing
// pinned them, so adding a service meant hand-editing ~29 occurrences off a checklist: miss one and a
// wrong number ships to an indexed page — including JSON-LD structured data — with CI green.
//
// Source of truth is GROUP_MEMBERS (worker/src/service-groups.ts): it carries BOTH the total and the
// per-bucket split that `s1.lead` states, and is itself pinned to the frontend SERVICE_CATEGORIES by
// service-groups-sync.test.ts, so it cannot drift from the dashboard. It has zero imports, so pulling
// it into this surface drags in nothing. (SERVICES from services.ts would drag ~12 modules — don't.)
//
// WHY ANCHORED PATTERNS, NOT A BARE NUMBER SEARCH: `/methodology` states TWO different service counts
// — the monitored count and the probed count (PROBE_TARGETS, pinned separately by the #678 test). A generic
// /\d+개 AI 서비스/ matches both, so a test written that way would pass while pointing at the wrong
// sentence. Every assertion below anchors on text unique to its occurrence.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { GROUP_MEMBERS } from '../../worker/src/service-groups'
import { PROBE_TARGETS } from '../../worker/src/probe'
import { OSV_PACKAGES } from '../../worker/src/security-monitor'
import { renderMethodologyPage } from '../_methodology/html-template'
import { renderLandingPage } from '../_intro/html-template'

const REPO = join(__dirname, '..', '..')
const read = (f: string) => readFileSync(join(REPO, f), 'utf-8')

const BUCKETS = Object.fromEntries(
  Object.entries(GROUP_MEMBERS).map(([g, ids]) => [g, ids.length]),
) as Record<keyof typeof GROUP_MEMBERS, number>
const TOTAL = Object.values(BUCKETS).reduce((a, b) => a + b, 0)

/**
 * Assert EVERY anchored occurrence carries the derived count. Each `anchor` is a regex with ONE
 * capture group around the number; every match in the surface must equal `expected`, and a match
 * count of zero fails — otherwise deleting the sentence would silently pass.
 *
 * `matchAll`, NOT `match`, and this is load-bearing rather than stylistic: both Edge templates carry
 * each KO string TWICE — once as the inline `data-i18n` default, once in the `ko` map inside the
 * inline <script> (adding-a-service.md: "each count appears ~4×"). `String.match` with a non-global
 * regex returns only the FIRST, so the original version of this helper read the inline default and
 * never looked at the map copy — which is the string that actually renders after a language toggle.
 * Two review passes each caught 8 mutations that stayed green that way.
 *
 * matchAll alone is still not enough: with BOTH copies present, DELETING one leaves the other
 * matching with a correct value, so the anchor stays quiet. That is why a twinned string declares
 * `minOccurrences: 2` — the count is the only thing that distinguishes "both copies present" from
 * "the visible paragraph was deleted and only the dictionary entry survives". It is `>=`, not `===`,
 * so adding a legitimate third mention is allowed (its value gets checked like any other).
 */
type Anchor = [label: string, re: RegExp, minOccurrences?: number]

function expectCount(text: string, surface: string, expected: number, anchors: Anchor[]) {
  for (const [label, re, min = 1] of anchors) {
    const all = [...text.matchAll(new RegExp(re, re.flags.includes('g') ? re.flags : re.flags + 'g'))]
    expect(all.length, `${surface}: anchor "${label}" matched ${all.length}× but must appear at least ${min}× — a copy was deleted or reworded, so this guard is no longer watching it (pattern: ${re})`).toBeGreaterThanOrEqual(min)
    for (const m of all) {
      expect(Number(m[1]), `${surface}: "${label}" says ${m[1]} (occurrence ${all.indexOf(m) + 1} of ${all.length}), but GROUP_MEMBERS totals ${expected}`).toBe(expected)
    }
  }
}

describe('service-count lockstep across public surfaces (#1074)', () => {
  it('GROUP_MEMBERS is a sane source of truth', () => {
    // Guard the guard: if the source collapsed to empty, every `toBe(TOTAL)` below would still pass
    // against a bogus 0 and the whole suite would go quietly green.
    expect(TOTAL).toBeGreaterThan(30)
    expect(Object.keys(BUCKETS).length).toBe(8)
    for (const [g, n] of Object.entries(BUCKETS)) {
      expect(n, `bucket ${g} must be non-empty`).toBeGreaterThan(0)
    }
    // An id listed in TWO buckets inflates TOTAL, and every surface assertion above would then fail
    // pointing at 5 innocent files. service-groups-sync.test.ts does NOT catch it either — its
    // completeness (`serviceGroupOf(id) !== undefined`) and staleness (`ids ⊆ realIds`) checks are
    // both satisfied by a duplicate. Name the real cause here instead.
    const allIds = Object.values(GROUP_MEMBERS).flat()
    expect(new Set(allIds).size, 'a service id appears in more than one GROUP_MEMBERS bucket').toBe(TOTAL)
  })

  it('/methodology states the total in both locales + the meta description', () => {
    const html = renderMethodologyPage()
    expectCount(html, '/methodology', TOTAL, [
      ['meta description', /content="[^"]*?(\d+) services, polled every 5 min/],
      ['hero.meta KO', /(\d+)개 서비스 · 5분 간격 폴링/, 2],
      ['hero.meta EN', /(\d+) services · polled every 5 min/],
      ['s1.lead KO', /총 (\d+)개 AI 서비스를 최대 5분 간격으로/, 2],
      ['s1.lead EN', /AIWatch polls (\d+) AI services/],
    ])
  })

  it('/methodology §1 breakdown matches GROUP_MEMBERS bucket-for-bucket, in BOTH locales', () => {
    // The one place the 8-bucket split is spelled out. A KO-only edit (the likely half-fix) fails here.
    const html = renderMethodologyPage()
    const ko: [keyof typeof BUCKETS, RegExp][] = [
      ['llm', /LLM API (\d+)개/], ['agents', /코딩 에이전트 (\d+)개/], ['voice', /음성 (\d+)개/],
      ['inference', /추론·인프라 (\d+)개/], ['observability', /관측 (\d+)개/], ['video', /영상 (\d+)개/],
      ['image', /이미지 (\d+)개/], ['apps', /AI 앱 (\d+)개/],
    ]
    const en: [keyof typeof BUCKETS, RegExp][] = [
      ['llm', /(\d+) LLM APIs/], ['agents', /(\d+) coding agents/], ['voice', /(\d+) voice\b/],
      ['inference', /(\d+) inference & infra/], ['observability', /(\d+) observability/],
      ['video', /(\d+) video\b/], ['image', /(\d+) image\b/], ['apps', /(\d+) AI apps/],
    ]
    // Route through expectCount rather than re-implementing the matchAll idiom: a second copy drifts
    // (this loop had no minOccurrences, so stripping the breakdown prefix from the INLINE s1.lead —
    // deleting the only reader-facing statement of the 8-bucket split — passed silently, while the
    // `s1.lead KO` anchor kept matching the surviving tail in both copies).
    for (const [locale, anchors, min] of [['KO', ko, 2], ['EN', en, 1]] as const) {
      for (const [bucket, re] of anchors) {
        expectCount(html, `/methodology s1.lead ${locale} [${bucket}]`, BUCKETS[bucket], [[bucket, re, min]])
      }
    }
    // ...and the parts must sum to the whole, so a bucket rename that dodges every anchor above
    // (matching nothing, hence never checked) still can't leave the sentence quietly incomplete.
    expect(Object.values(BUCKETS).reduce((a, b) => a + b, 0)).toBe(TOTAL)
  })

  it('/intro states the total in every count-bearing string, both locales', () => {
    const html = renderLandingPage()
    expectCount(html, '/intro', TOTAL, [
      ['JSON-LD description', /Real-time status monitoring for (\d+) AI services/],
      ['hero.sub KO', /(\d+)개 AI 서비스 상태를 한 화면에서/, 2],
      ['hero.sub EN', /Real-time status for (\d+) AI services in one view/],
      ['stat-pill', /stat-pill-num">(\d+)<\/span> <span data-i18n="hero.pill1"/],
      // dict-only (no inline KO default on this row), so the default min of 1 is right
      ['compare.sub KO', /공식 페이지 데이터를 기반으로, (\d+)개를 한 화면에서/],
      ['compare.sub EN', /aggregated across (\d+) services in one place/],
      ['compare.r2b KO', /(\d+)개를 한 곳에서 — Discord/, 2],
      ['compare.r2b EN', /All (\d+) in one — Discord/],
      ['report.sub KO', /매월 (\d+)개 서비스의 AIWatch Score/, 2],
      ['report.sub EN', /provider recommendations — all in one monthly report for (\d+) services/],
      ['dashboard-mock filter tab', /mock-filter-tab active">All (\d+)</],
    ])
  })

  it('index.html SEO meta + JSON-LD state the total', () => {
    // Static file — it CANNOT derive the count at render time, which is why this whole invariant is
    // guarded by a test rather than by SSR interpolation on the two Edge pages.
    const html = read('index.html')
    expectCount(html, 'index.html', TOTAL, [
      ['meta description', /name="description" content="Real-time status monitoring for (\d+) AI services/],
      ['og:title', /og:title" content="AIWatch — (\d+)개 AI 서비스/],
      ['og:description', /og:description" content="[^"]*?등 (\d+)개 AI 서비스/],
      ['twitter:title', /twitter:title" content="AIWatch — (\d+)개 AI 서비스/],
      ['twitter:description', /twitter:description" content="[^"]*?등 (\d+)개 AI 서비스/],
      ['JSON-LD', /"description": "Real-time status monitoring for (\d+) AI services/],
    ])
  })

  it('both READMEs state the total, and neither has an anchor the other lacks', () => {
    // The label sets are asserted equal below. That structural check is the point: the ONE anchor that
    // existed on only one side ('statusline', KO-only) is where the last live-stale number hid — the EN
    // twin read "and 36 more" (i.e. a total of 40) through four service additions. A per-file list that
    // a human eyeballs for symmetry is exactly what failed; assert the symmetry instead.
    const EN: Anchor[] = [
      ['intro line', /Real-time monitoring dashboard for \*\*(\d+) AI services\*\*/],
      ['features', /Operational \/ Degraded \/ Down for (\d+) AI services/],
      ['taxonomy', /\((\d+) total — sidebar filters/],
      ['api diagram', /parallel fetch \((\d+) services\)/],
    ]
    const KO: Anchor[] = [
      ['intro line', /\*\*(\d+)개 AI 서비스\*\*의 상태/],
      ['features', /(\d+)개 AI 서비스의 정상 \/ 성능 저하/],
      ['taxonomy', /\(총 (\d+)개 — 사이드바 필터/],
      ['api diagram', /병렬 fetch \((\d+)개 서비스\)/],
    ]
    expect(EN.map(a => a[0]).sort(), 'README.md and README.ko.md must anchor the SAME set of sentences — an anchor on one side only means the other side is unguarded').toEqual(KO.map(a => a[0]).sort())
    expectCount(read('README.md'), 'README.md', TOTAL, EN)
    expectCount(read('README.ko.md'), 'README.ko.md', TOTAL, KO)
    // The social-share badges pre-fill the text a visitor posts to X / Reddit / HN, so a stale number
    // here gets published OFF-site. They are URL-ENCODED (`%20N%20`, `N%EA%B0%9C`), so a
    // decoded-form search never sees them — that is how they sat at 39 while every other count read 44.
    expectCount(read('README.md'), 'README.md badges', TOTAL, [
      ['share badge EN', /monitoring%20for%20(\d+)%20AI/, 3],
    ])
    expectCount(read('README.ko.md'), 'README.ko.md badges', TOTAL, [
      ['share badge KO', /%E2%80%94%20(\d+)%EA%B0%9C%20AI/, 2],
      ['share badge EN', /monitoring%20for%20(\d+)%20AI/],
    ])

    // The statusline sentence states the count DIFFERENTLY per locale — KO gives the total, EN gives a
    // remainder after naming examples — so it cannot join the symmetric lists above. Derive EN's
    // expectation from the names actually rendered, so renaming an example can't silently re-break it.
    const enLine = read('README.md').match(/Surface AI service outages — (.+?), and (\d+) more —/)!
    expect(enLine, 'the statusline sentence must exist to be guarded').toBeTruthy()
    const named = enLine[1].split(',').length
    expectCount(read('README.md'), 'README.md statusline', TOTAL - named, [['statusline EN', /and (\d+) more —/]])
    expectCount(read('README.ko.md'), 'README.ko.md statusline', TOTAL, [['statusline KO', /등 (\d+)개 AI 서비스의 장애 여부를/]])
  })

  it('both READMEs spell out the same 8-bucket split, per bucket', () => {
    // Adding a service moves exactly ONE bucket, and that is the scenario this whole suite exists for:
    // without this, the half-fix the /methodology bucket test catches was still available one file over.
    const en: [keyof typeof BUCKETS, RegExp][] = [
      ['llm', /^### LLM APIs \((\d+)\)/m], ['agents', /^### Coding Agents \((\d+)\)/m],
      ['voice', /^### Voice \((\d+)\)/m], ['inference', /^### Inference & Infra \((\d+)\)/m],
      ['observability', /^### Observability \((\d+)\)/m], ['video', /^### Video \((\d+)\)/m],
      ['image', /^### Image \((\d+)\)/m], ['apps', /^### AI Apps \((\d+)\)/m],
    ]
    const ko: [keyof typeof BUCKETS, RegExp][] = [
      ['llm', /^### LLM API \((\d+)개\)/m], ['agents', /^### 코딩 에이전트 \((\d+)개\)/m],
      ['voice', /^### 음성 \((\d+)개\)/m], ['inference', /^### 추론 & 인프라 \((\d+)개\)/m],
      ['observability', /^### 관측 \((\d+)개\)/m], ['video', /^### 영상 \((\d+)개\)/m],
      ['image', /^### 이미지 \((\d+)개\)/m], ['apps', /^### AI 앱 \((\d+)개\)/m],
    ]
    for (const [file, anchors] of [['README.md', en], ['README.ko.md', ko]] as const) {
      for (const [bucket, re] of anchors) {
        expectCount(read(file), `${file} [${bucket}]`, BUCKETS[bucket], [[bucket, re]])
      }
    }
  })

  it('CLAUDE.md states the total + its COARSE 3-bucket split', () => {
    // Beyond #1074's five public surfaces, added because this file was found carrying live drift
    // during that work (it claimed 32 probe targets against PROBE_TARGETS' 33 — fixed in the same PR).
    // It states the COARSE taxonomy (api / agent / app), which is what /api/v1/status `category`
    // exposes, so derive those three from the same GROUP_MEMBERS: everything that is neither an agent
    // nor an app is an API service.
    const coarse = {
      api: TOTAL - BUCKETS.agents - BUCKETS.apps,
      apps: BUCKETS.apps,
      agents: BUCKETS.agents,
    }
    const md = read('CLAUDE.md')
    expectCount(md, 'CLAUDE.md', TOTAL, [
      ['intro line', /monitors (\d+) AI services in real time/],
      // Same sentence as the READMEs' api diagram — but phrased `N-service fetch`,
      // so their anchor never matched it and this copy sat at 39 across five service additions.
      ['data-flow sentence', /parallel (\d+)-service fetch/],
    ])
    expectCount(md, 'CLAUDE.md', coarse.api, [['API services', /\*\*(\d+) API services\*\*/]])
    expectCount(md, 'CLAUDE.md', coarse.apps, [['AI apps', /\*\*(\d+) AI apps\*\*/]])
    expectCount(md, 'CLAUDE.md', coarse.agents, [['coding agents', /\*\*(\d+) coding agents\*\*/]])
    expect(coarse.api + coarse.apps + coarse.agents, 'the coarse split must still sum to the total').toBe(TOTAL)
  })

  it('every surface states the PROBE count, pinned to PROBE_TARGETS', () => {
    // A SECOND count, and the one that actually drifted: kimi (#1067) moved it 32→33 and CLAUDE.md,
    // directory-map.md and adding-a-service.md all went stale (fixed in this PR). #678 pins it on
    // /methodology only, so the READMEs were the surviving unguarded copy.
    const n = PROBE_TARGETS.length
    expectCount(read('README.md'), 'README.md', n, [
      ['latency feature', /RTT\) for (\d+) probe-capable services/],
      ['probing feature', /to service endpoints \((\d+) probe targets\)/],
      ['kv schema', /TTL 7d, (\d+) probe targets\)/],
    ])
    // CLAUDE.md carries it too — this is the copy that was actually found stale (it said 32).
    expectCount(read('CLAUDE.md'), 'CLAUDE.md', n, [['directory map', /Direct RTT probing \((\d+) targets\)/]])

    // /methodology is the MOST exposed surface (public, indexed) and was NOT meaningfully guarded: the
    // #678 test checks the probe count with two `toContain` EXISTENCE assertions, so nearly all of its
    // copies could read 99 while one KO and one EN stayed correct — and the suite passed. An earlier
    // revision of this file claimed that test pinned it; the claim was false. #678 keeps its own
    // coverage of the non-probed SERVICE LIST (Bedrock/Azure OpenAI/Modal), not duplicated here.
    //
    // NO occurrence COUNT is asserted in prose here, deliberately. Enumerating "N mentions" by grepping
    // the CURRENT value structurally cannot see a STALE copy — which is how the EN `33-service probe
    // set` below sat at 32 through two review rounds while a "all 11 mentions covered" comment claimed
    // otherwise. Enumerate by PHRASING, and let the anchors below be the count.
    expectCount(renderMethodologyPage(), '/methodology probe', n, [
      ['s1.src.probe KO', /(\d+)개 AI 서비스의 엔드포인트 직접 측정/, 2],
      ['s1.src.probe EN', /direct measurement of (\d+) AI services/],
      ['s5.lead KO', /(\d+)개 AI 서비스의 엔드포인트를/, 2],
      ['s5.lead EN', /We measure the endpoints of (\d+) AI services/],
      ['s4.resp.desc KO', /(\d+)개 AI 서비스\)/, 2],
      ['s4.resp.desc EN', /health-check probes \((\d+) AI services\)/],
      ['probe-set KO', /probe 세트\((\d+)개\)/, 2],
      ['probe-set EN', /outside the (\d+)-service probe set/],
    ])
    expectCount(read('README.ko.md'), 'README.ko.md', n, [
      ['latency feature', /(\d+)개 probe 대상 서비스의 엔드포인트/],
      ['probing feature', /RTT 측정 \((\d+)개 probe 대상\)/],
      ['kv schema', /TTL 7일, (\d+)개 probe 대상\)/],
    ])
    expect(n).not.toBe(TOTAL) // if these ever coincide the anchors still hold; this documents that they differ today
  })

  it('every LOCALE-SUFFIXED anchor has its sibling (partial guard — see the caveat)', () => {
    // Four review rounds surfaced the same defect: a KO string anchored, its EN twin left out, and the
    // unguarded EN copy live-stale. The anchor lists are hand-maintained prose pairs, so an unpaired
    // entry is invisible on inspection — assert the pairing instead of re-checking it.
    //
    // CAVEAT, because this guard reads broader than it is: it can only see labels that CARRY a `KO`/`EN`
    // suffix. ~20 anchors are unsuffixed (`intro line`, `taxonomy`, `api diagram`, `kv schema`, …) and
    // are invisible to it — which is exactly how the KO-only `statusline` anchor survived four rounds
    // while its EN twin read a stale 36. The README pair is now covered structurally by the label-set
    // equality assertion in the READMEs test; this one covers the Edge templates' locale pairs.
    const labels = readFileSync(join(__dirname, 'service-count-lockstep.test.ts'), 'utf-8')
      .match(/\['[^']+ (KO|EN)'/g)!.map(l => l.slice(2, -1))
    const ko = labels.filter(l => l.endsWith(' KO')).map(l => l.slice(0, -3))
    const en = labels.filter(l => l.endsWith(' EN')).map(l => l.slice(0, -3))
    // compare.sub is the one legitimate exception: /intro renders no inline KO default for that row,
    // but both locales ARE anchored, so it appears in both lists. Every other name must too.
    for (const name of ko) expect(en, `KO anchor "${name}" has no EN sibling — the EN copy is unguarded`).toContain(name)
    for (const name of en) expect(ko, `EN anchor "${name}" has no KO sibling — the KO copy is unguarded`).toContain(name)
  })

  it('the is-down page count is TOTAL minus the two no-official-uptime services', () => {
    // Derived, not independent: /is-*-down covers every monitored service except bedrock and
    // azureopenai. The copies this block pins are the ones that state a number; #1184 deleted two more
    // in docs/reference that had already gone stale at 42, rather than re-arming them.
    const isDown = TOTAL - 2
    expectCount(read('CLAUDE.md'), 'CLAUDE.md', isDown, [['directory map', /"Is X Down\?" SEO pages \((\d+) services/]])
    expectCount(read('README.md'), 'README.md', isDown, [
      ['feature line', /\*\*Is X Down SEO pages\*\* — (\d+) services/],
      ['directory map', /"Is X Down\?" SSR pages \((\d+) services\)/],
    ])
    expectCount(read('README.ko.md'), 'README.ko.md', isDown, [
      ['feature line', /\*\*Is X Down SEO 페이지\*\* — (\d+)개 서비스/],
      ['directory map', /"Is X Down\?" SSR 페이지 \((\d+)개 서비스\)/],
    ])
  })

  it('the /intro dashboard mock is internally consistent with its own "All N" tab', () => {
    // The mock renders a few service cards under an `All <TOTAL>` filter tab and a "+ N more services"
    // link. N is not free: it is TOTAL minus the cards actually shown. It read 34 against 3 cards and
    // a 44 tab — visible arithmetic, wrong by 7, on an indexed page.
    const html = renderLandingPage()
    const cards = [...html.matchAll(/mock-card-name">/g)].length
    expect(cards, 'the mock must render at least one card for this to mean anything').toBeGreaterThan(0)
    expectCount(html, '/intro mock', TOTAL - cards, [
      ['demo.more KO', /\+ (\d+)개 서비스 더 보기/, 2],
      ['demo.more EN', /\+ (\d+) more services/],
    ])

    // The stat card and the filter tab state the SAME quantity and had drifted apart (34 vs
    // "Operational 35"), summing to 35 against their own "All 44". Operational = TOTAL − issues.
    const issues = Number(html.match(/mock-filter-tab">Issues (\d+)</)![1])
    expectCount(html, '/intro mock', TOTAL - issues, [
      ['operational stat card', /mock-stat-value" style="color:var\(--green\);">(\d+)</],
      ['operational filter tab', /mock-filter-tab">Operational (\d+)</],
    ])
  })

  it('/methodology states no count this suite cannot pin', () => {
    // The §3 "Official" bullet used to say "(30 services)". uptimeSource is assigned at RUNTIME from
    // whether a parse yielded uptime30d — there is no static constant to derive it from, and the value
    // is a FLOOR (a transient fetch failure moves a service out), so even a correct number is unstable.
    // It had already drifted (live: 31, after kimi #1067 landed with official uptime). A number this
    // suite structurally cannot guard does not belong in published copy — the sibling "Platform" bullet
    // NAMES its services instead, which is the pattern to follow if a count is wanted back.
    const html = renderMethodologyPage()
    expect(html).not.toMatch(/\(\d+개 서비스\)/)
    expect(html).not.toMatch(/status page \(\d+ services\)/)
  })

  it('both READMEs state the OSV package count, pinned to OSV_PACKAGES', () => {
    // A THIRD count on the same files (24 today, correct) and — unlike the multi-component and
    // official-uptime counts — genuinely pinnable: OSV_PACKAGES is a static array, so the number is a
    // config fact, not a parse outcome. That distinction is the rule this suite applies: pin what a
    // constant determines, remove what only a live fetch does.
    const n = OSV_PACKAGES.length
    expectCount(read('README.md'), 'README.md', n, [
      ['osv feature EN', /across (\d+) AI SDK packages/],
      ['osv directory EN', /OSV\.dev SDK vulnerabilities — (\d+) tracked packages/],
    ])
    expectCount(read('README.ko.md'), 'README.ko.md', n, [
      ['osv feature KO', /(\d+)개 AI SDK 패키지/],
      ['osv directory KO', /OSV\.dev SDK 취약점 — (\d+)개 추적 패키지/],
    ])
  })

  it('the Component-breakdown bullet states NO count — it is a parse outcome, not a constant', () => {
    // It read 24 while live was 31. The set is NOT config-determined: `resolveSvcComponents` is gated on
    // displayAllComponents / displayComponentIds / statusComponentIds (26 services), but
    // `parseBetterStackComponents` attaches components with no COMPONENT-LIST config gate (only a
    // denylist + a >= 2 self-gate; reaching it needs just `betterStackUrl`), which is why 6 unconfigured
    // BetterStack services render one while characterai — configured, dead status page (#689/#800) —
    // does not. 26 − 1 + 6 = 31 was the coincidence of the day, not a fact to publish.
    //
    // Assert NO DIGIT in the bullet rather than banning the literal phrase: matching `N multi-component`
    // let a paraphrase ("24 services with multiple components") ship green, and rephrasing is the exact
    // drift vector this suite's own doctrine names. The bullet carries no legitimate number, so any
    // digit appearing in it is a reintroduced count. Requiring the bullet to EXIST also stops the
    // negative assertion from passing vacuously if someone deletes it.
    for (const [f, head] of [['README.md', 'Component status breakdown'], ['README.ko.md', '구성요소 상태 분해']] as const) {
      const bullet = read(f).split('\n').find(l => l.includes(`**${head}**`))
      expect(bullet, `${f}: the "${head}" bullet must exist for this guard to mean anything`).toBeTruthy()
      expect(bullet!, `${f}: the "${head}" bullet must state no service count — the set is a parse outcome`).not.toMatch(/\d/)
    }
  })

  it("docs/reference and public/llms.txt state the total where they state one", () => {
    // #1184 — data-flow.md carries the SAME `parallel fetch (N services)` sentence as README.md, and
    // the README copy is anchored above. This one was not: docs/reference was outside this suite's
    // surface list, so it sat at 44 while every guarded surface read 45. Being a reference doc rather
    // than an indexed page is not a reason to leave it unpinned — it is what the next change reads.
    expectCount(read('docs/reference/data-flow.md'), 'data-flow.md', TOTAL, [
      ['api diagram', /parallel fetch \((\d+) services\)/],
    ])
    // `public/llms.txt` is served by Vercel's filesystem at /llms.txt and exists so AI crawlers read
    // it — the "published off-site" harm class this suite was built for, and it was in NO list: not
    // the surfaces here, not adding-a-service's steps, not even its hand-checked note. It read 43
    // (the is-down subtotal) for the monitored total; the dashboard lists every service.
    expectCount(read('public/llms.txt'), 'llms.txt', TOTAL, [
      ['lead', /incidents of (\d+) AI services \(LLM APIs/],
      ['dashboard link', /live status of all (\d+) monitored services/],
    ])
  })

  it('does NOT confuse the monitored count with the probed count (#678 regression guard)', () => {
    // /methodology states both. This guard exists because the obvious implementation of this whole
    // test — search for /\d+개 AI 서비스/ — matches the PROBE sentence too, and would have passed
    // while watching the wrong number. If the two ever coincide numerically the distinction still
    // holds structurally, so assert the probe sentences are anchored separately rather than equal.
    const html = renderMethodologyPage()
    expect(html).toMatch(/(\d+)개 AI 서비스의 엔드포인트 직접 측정/)
    expect(html).toMatch(/direct measurement of (\d+) AI services\\' endpoints/) // escaped: inside an inline-script string
    // The probe count itself is asserted against PROBE_TARGETS in the test above; this one only
    // asserts the two counts stay TEXTUALLY distinguishable, which is what keeps the anchors honest.
  })
})
