import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { renderMethodologyPage } from '../html-template'
import { PROBE_TARGETS } from '../../../worker/src/probe' // #678 — lockstep source of truth
import { SERVICES } from '../../../worker/src/services' // #1110 — Better Stack roster lockstep

// #673 — the public /methodology page. Renders once (no per-request data), so these assertions
// guard: it renders without throwing, carries all 7 section anchors + the SEO head, is bilingual,
// keeps the migrated Score facts accurate, surfaces the "what we can't measure" transparency table,
// and stays CSP-clean (no inline event handlers — #482) so it doesn't join the Phase-2 refactor list.
const html = renderMethodologyPage()

describe('renderMethodologyPage', () => {
  it('renders a full HTML document with the methodology title', () => {
    expect(html).toContain('<!DOCTYPE html>')
    expect(html).toContain('How AIWatch Works')
    expect(html).toMatch(/<title>[^<]*Methodology[^<]*<\/title>/)
  })

  it('carries all 7 section anchors', () => {
    for (const id of ['sources', 'status', 'uptime', 'score', 'latency', 'incidents', 'independence']) {
      expect(html, `missing anchor #${id}`).toContain(`id="${id}"`)
    }
  })

  it('is indexable + canonical to /methodology', () => {
    expect(html).toContain('rel="canonical"')
    expect(html).toContain('https://ai-watch.dev/methodology')
    expect(html).not.toMatch(/noindex/i)
  })

  it('is CSP-clean — no inline event-handler attributes (#482)', () => {
    expect(html).not.toMatch(/\son(click|error|mouseover|load|change)=/i)
  })

  it('stamps the per-response nonce on every inline <script> when given one (#482)', () => {
    const withNonce = renderMethodologyPage('NONCE123')
    // every EXECUTABLE inline <script> (no src, not the JSON-LD data block) carries the nonce
    const tags = (withNonce.match(/<script(?![^>]*\bsrc=)(?![^>]*application\/ld\+json)[^>]*>/g) ?? [])
    expect(tags.length).toBeGreaterThanOrEqual(2) // consent init + the i18n/interactivity script (+ cookie banner)
    for (const tag of tags) expect(tag).toContain('nonce="NONCE123"')
    // gtag.js loader (src) also nonce-stamped for GA4 propagation; JSON-LD stays clean
    expect(withNonce).toMatch(/<script async nonce="NONCE123" src="https:\/\/www\.googletagmanager\.com/)
    expect(withNonce).toMatch(/<script type="application\/ld\+json">/) // unchanged, no nonce needed
    // no stray nonce when omitted
    expect(renderMethodologyPage()).not.toContain('nonce="')
  })

  it('every inline <script> is syntactically valid JS (guards i18n quote-escaping)', () => {
    // Regression for the pre-existing break where an i18n string used an unescaped apostrophe
    // (e.g. KO 'degraded') — inside the `return \`...\`` template literal a source `\'` collapses to
    // `'` in the rendered output, ending the JS string early ("Unexpected identifier") and killing
    // the WHOLE inline script (so setLang/the lang toggle silently never ran). new Function() compiles
    // the body without executing it, so undefined globals (document/navigator/gtag) don't matter — it
    // throws ONLY on a real syntax error.
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1].trim()).filter(Boolean)
    expect(scripts.length).toBeGreaterThan(0)
    for (const body of scripts) {
      expect(() => new Function(body), `inline script must parse: ${body.slice(0, 60)}…`).not.toThrow()
    }
  })

  it('the language toggle defaults to English (active = EN)', () => {
    // #601 follow-up — methodology is <html lang="en"> + English-indexed; default render is English.
    expect(html).toMatch(/class="lang-btn active" data-lang="en"/)
    expect(html).toMatch(/let currentLang = 'en'/)
  })

  it('is bilingual (KO + EN copy both present)', () => {
    // the transparency principle line in both languages (client-side toggle keeps both in the DOM)
    expect(html).toMatch(/can measure/i)        // EN
    expect(html).toMatch(/측정|투명|공개/)        // KO
    expect(html).toMatch(/lang/i)               // a lang toggle exists
  })

  it('keeps the migrated AIWatch Score facts accurate', () => {
    // the formula + the four component weights — assert the weight bound to its component
    // (a bare toContain('40') would pass on any '40' in the page, e.g. CSS or "0–40 days").
    expect(html).toContain('AIWatch Score = Uptime + Incidents + Recovery + Responsiveness')
    expect(html).toMatch(/Uptime Score \(0[~–-]40\)/)
    expect(html).toMatch(/Incident Score \(0[~–-]25\)/)
    expect(html).toMatch(/Recovery Score \(0[~–-]15\)/)
    expect(html).toMatch(/Responsiveness Score \(0[~–-]20\)/)
    // grade thresholds — bound to the grade name (excellent ≥90 … unstable <40)
    expect(html).toMatch(/90\+[\s\S]{0,80}Excellent/)
    expect(html).toMatch(/75\+[\s\S]{0,80}Good/)
    expect(html).toMatch(/55\+[\s\S]{0,80}Fair/)
    expect(html).toMatch(/40\+[\s\S]{0,80}Degrading/)
    expect(html).toMatch(/&lt;40[\s\S]{0,80}Unstable/)
  })

  it('surfaces the "what we cannot measure" transparency table (the moat)', () => {
    // the no-uptime-records services must be named with the honest "Not provided" treatment.
    // Mistral + Perplexity were removed once their Instatus pages were read (#1006); OpenRouter followed
    // once AIWatch computed its uptime from the OnlineOrNot incident records (#1006).
    for (const svc of ['Bedrock', 'Azure', 'Gemini', 'xAI', 'Deepgram', 'Character']) {
      expect(html, `limits table should name ${svc}`).toContain(svc)
    }
    expect(html).toMatch(/Not provided|not provided|미제공|제공.*않/)
  })

  it('no .formula div leaks untranslated Korean onto the English page (#974)', () => {
    // Defect 1 (#974): the noUptime Score formula div had no data-i18n, so setLang('en') never
    // rewrote it and its Korean rendered on the English page. The client toggle only rewrites
    // [data-i18n] elements, so a .formula div is leak-safe iff EITHER the div itself carries
    // data-i18n, OR the only Korean it contains sits inside a data-i18n child span (which IS
    // rewritten) — pure-math formula divs (language-neutral) are safe with neither.
    const formulaDivs = [...html.matchAll(/<div class="formula"([^>]*)>([\s\S]*?)<\/div>/g)]
    expect(formulaDivs.length).toBeGreaterThan(0)
    for (const [, attrs, inner] of formulaDivs) {
      if (/\bdata-i18n=/.test(attrs)) continue // whole div is translated on toggle
      // strip translated child spans; any Korean left is direct div text that never gets rewritten
      const bare = inner.replace(/<span[^>]*\bdata-i18n=[^>]*>[\s\S]*?<\/span>/g, '')
      expect(/[가-힣]/.test(bare), `.formula div leaks Korean on the EN page (needs data-i18n): ${inner.slice(0, 70)}`).toBe(false)
    }
    // the fix's keys BOTH exist in BOTH locale blocks (ko + en). The leak scan above strips every
    // data-i18n span unconditionally, so a key wired in only ONE locale would still pass it while
    // leaking the other locale's text — exactly #974's bug class. Assert both keys, both locales.
    expect((html.match(/'s4\.noUptime\.formula':/g) ?? []).length, 's4.noUptime.formula must exist in both locales').toBeGreaterThanOrEqual(2)
    expect((html.match(/'s4\.noUptime\.formulaSub':/g) ?? []).length, 's4.noUptime.formulaSub must exist in both locales').toBeGreaterThanOrEqual(2)
  })

  it('never lists an incident.io-uptime service as "no uptime source" (#974 anti-drift)', () => {
    // The §3 "coverage & limits" table hardcodes the no-official-uptime service names — prose that
    // cannot derive from data, so it silently drifted: stability/elevenlabs/replicate/turbopuffer
    // each gained an incidentIoComponentId (we now COMPUTE their uptime from incident.io
    // component_impacts → uptimeSource 'official') but kept sitting in the table.
    //
    // Sound static invariant: a service with an incidentIoComponentId ALWAYS produces official
    // uptime, so it must never appear in the limits table. This is the one direction config can
    // pin. LIMIT: the statusComponentId / Atlassian path (deepgram vs openrouter) depends on
    // whether the provider's HTML actually carries window.uptimeData — runtime-only, not statically
    // derivable here — so that direction is verified against live /api/status via the issue's
    // Tier-A verify-after assert, not this test.
    const uptimeSection = html.slice(html.indexOf('id="uptime"'), html.indexOf('id="latency"'))
    const limitsBlock = uptimeSection.slice(uptimeSection.indexOf('class="limits"'))
    // first-column cells hold the ·-separated display names ("Amazon Bedrock · Azure OpenAI", …)
    const namedNoUptime = new Set(
      [...limitsBlock.matchAll(/<tr>\s*<td>([^<]+)<\/td>/g)]
        .flatMap((m) => m[1].split('·').map((s) => s.trim()))
        .filter(Boolean),
    )
    expect(namedNoUptime.size, 'limits-table service names should parse').toBeGreaterThan(0)
    // Exact-name membership (NOT substring — "OpenAI" is an incident.io service whose name is a
    // substring of the table's "Azure OpenAI", so toContain would false-positive). This assumes the
    // table cell uses the service's config `.name` verbatim; a few no-uptime services are listed under
    // a shortened display name (config "Gemini API"→table "Gemini", "xAI (Grok)"→"xAI"), but none of
    // those carry an incidentIoComponentId, so the exact-name guard covers the whole incident.io set.
    const ioNames = SERVICES.filter((s) => s.incidentIoComponentId).map((s) => s.name)
    expect(ioNames.length).toBeGreaterThan(0)
    for (const name of ioNames) {
      expect(namedNoUptime.has(name), `${name} has an incidentIoComponentId (we compute its official uptime) — it must not be listed as "no uptime source"`).toBe(false)
    }
  })

  it('names every data-source platform (kept in sync with worker/src/parsers)', () => {
    // The §1 "Data sources" list must cover the real parser set — Google AI Studio (aistudio.ts,
    // #310) and Flashduty/DeepSeek (flashduty.ts, #618) were missing on first ship.
    for (const src of [
      'Atlassian Statuspage', 'incident.io', 'Google Cloud Status', 'AI Studio',
      'Better Stack', 'Instatus', 'OnlineOrNot', 'Flashduty', 'AWS Health Dashboard',
      'Azure Status', 'xAI', 'Direct RTT probes',
    ]) {
      expect(html, `data sources should name ${src}`).toContain(src)
    }
  })

  it('documents the security-issue monitoring track surfaced in the monthly report', () => {
    // Security findings are public via MonthlySecuritySummary (bySource: osv | hackernews) → /api/report.
    // The page names those public sources and scopes them OUT of the Score / incident counts.
    expect(html).toMatch(/Security-issue monitoring|보안 이슈 모니터링/)
    expect(html).toContain('OSV.dev')
    expect(html).toContain('Hacker News')
    expect(html).toMatch(/monthly report|월간 리포트/)
    // explicitly excluded from the reliability Score
    expect(html).toMatch(/does not feed the AIWatch Score|Score나 인시던트 집계에는 반영되지 않/)
  })

  it('uses the UI-facing status labels, not the raw internal names (#674 — badge ≠ impact axis)', () => {
    // §2 must match the dashboard service BADGE (availability axis): Operational / Partial / Degraded
    // / Down (status.* labels; Partial added #722), and the worst-of priority is stated in those terms.
    expect(html).toContain('Operational · Partial · Degraded · Down · Unknown')
    expect(html).toContain('Down &gt; Degraded &gt; Operational')
    // #674 — the badge axis must NOT carry the calendar's impact-scale words ("Partial Outage" /
    // "Major Outage" are the OLD colliding labels; the calendar impact axis is now Minor/Major/Critical).
    expect(html).not.toContain('Partial Outage')
    expect(html).not.toContain('Major Outage')
    // §2 note links out to the open-source status-determination reference
    expect(html).toContain('docs/reference/status-determination.md')
  })

  it('is a doc-style page — sticky sidebar "on this page" TOC, not a landing hero', () => {
    // #673 follow-up: section navigation lives in ONE place (the sidebar TOC), with scroll-spy.
    expect(html).toContain('class="toc-side"')
    expect(html).toContain('aria-label="On this page"')
    // the sidebar carries all 7 section anchors
    for (const id of ['sources', 'status', 'uptime', 'score', 'latency', 'incidents', 'independence']) {
      expect(html, `sidebar TOC should link #${id}`).toContain(`href="#${id}"`)
    }
    // scroll-spy active-section highlighting is wired (geometry-based scroll listener + active class)
    expect(html).toMatch(/addEventListener\(\s*'scroll'/)
    expect(html).toContain("classList.toggle('active'")
    // the old duplicate landing-style top-bar section anchors are gone — the top nav is site-level only
    expect(html).not.toContain('<div class="toc">')
    expect(html).not.toContain('class="hero-outer"')
  })

  // #1233 — the fetch-failure card states the gate that decides whether an unreadable source gets
  // judged at all, and it states it as a DERIVATION: "최근 3회 probe(5분 간격이므로 15분)". Three
  // numbers, none of them free — the cadence is the cron schedule, the window is `maxAgeMs`, and the
  // cycle count is the quotient. That is why the copy reads the way it does: 15 minutes was never
  // chosen as a duration, it is 3 probe cycles (the reason recorded at introduction, #187/#188).
  //
  // So this pins the ARITHMETIC, not the strings: change `crons` to `*/10` and 3 cycles becomes wrong
  // even though `maxAgeMs` never moved. Both inputs are read from their own source of truth.
  it('keeps the probe-judgement gate in LOCKSTEP with probe.ts + the cron schedule (#1233)', () => {
    const repoRoot = process.cwd()
    const probeSrc = readFileSync(join(repoRoot, 'worker', 'src', 'probe.ts'), 'utf8')
    const servicesSrc = readFileSync(join(repoRoot, 'worker', 'src', 'services.ts'), 'utf8')
    const wranglerSrc = readFileSync(join(repoRoot, 'worker', 'wrangler.toml'), 'utf8')

    const windowMs = Number(probeSrc.match(/maxAgeMs = (\d[\d_]*)/)?.[1].replace(/_/g, ''))
    expect(windowMs, 'maxAgeMs default not found in probe.ts').toBeGreaterThan(0)
    const cadenceMin = Number(wranglerSrc.match(/crons\s*=\s*\["\*\/(\d+) /)?.[1])
    expect(cadenceMin, 'cron cadence not found in wrangler.toml').toBeGreaterThan(0)

    const windowMin = windowMs / 60_000
    const cycles = windowMin / cadenceMin
    expect(Number.isInteger(cycles), 'the window is no longer a whole number of probe cycles').toBe(true)

    // The minimum-sample gate, read from BOTH predicates so a change to either is caught.
    const gates = probeSrc.match(/recent\.length < (\d+)/g) ?? []
    expect(gates.length, 'expected the min-sample gate in both predicates').toBe(2)
    expect(new Set(gates).size, 'the two predicates disagree on the minimum').toBe(1)
    const minSamples = Number(gates[0].match(/(\d+)/)![1])

    expect(html).toContain(`최근 ${cycles}회 probe(${cadenceMin}분 간격이므로 ${windowMin}분)`)
    expect(html).toContain(`${minSamples}회 이상일 때 그 기록으로 판정합니다`)
    expect(html).toContain(`기록이 ${minSamples}회 미만일 때도`)
    expect(html).toContain(`at least ${minSamples} of the last ${cycles} probes`)
    expect(html).toContain(`every ${cadenceMin} minutes, so a ${windowMin}-minute window`)

    // The published window is only true if the cross-validation uses the DEFAULT `maxAgeMs`; a call
    // site passing its own would silently make every number above wrong.
    const overrides = servicesSrc.match(/isProbe(?:Healthy|Failing)\([^)]*,[^)]*,[^)]*\)/g) ?? []
    expect(overrides, 'a call site overrides maxAgeMs — the published window is no longer accurate').toEqual([])
  })

  it('keeps the probe count + non-probed set in LOCKSTEP with PROBE_TARGETS (#678)', () => {
    // The methodology copy hardcodes the probe count + the non-probed list. Derive the expected
    // count from the source of truth (worker/src/probe.PROBE_TARGETS) so a change to probe.ts that
    // forgets to update this page fails HERE — otherwise the two layers drift independently (the
    // exact regression #678 guards against).
    const n = PROBE_TARGETS.length // derived, so no number here can go stale
    expect(html).toContain(`${n} AI service`)  // EN
    expect(html).toContain(`${n}개 AI 서비스`)   // KO
    // the 3 remaining non-probed API services must be named...
    for (const svc of ['Bedrock', 'Azure OpenAI', 'Modal']) {
      expect(html, `non-probed list should name ${svc}`).toContain(svc)
    }
    // ...and the now-probed ones must NOT appear in the doc (Runway/Pinecone/LangSmith appear
    // nowhere else; Luma is also a Platform-uptime example so it's intentionally not asserted here).
    for (const svc of ['Runway', 'Pinecone', 'LangSmith']) {
      expect(html, `${svc} is now probed — must not be listed as non-probed`).not.toContain(svc)
    }
  })

  it('keeps the honest detection framing — MTTD + RTT, explicitly disclaiming "faster than official" (#464)', () => {
    // #464: the page must NOT positively claim speed superiority over the official status page.
    // The honest framing is MTTD + RTT degradation; a sentence that explicitly DISCLAIMS the
    // "faster than official" headline is the correct treatment, so assert the disclaimer is present
    // rather than naively banning the substring (which would flag the disclaimer itself).
    expect(html).toMatch(/MTTD|mean time to detect/i)
    expect(html).toMatch(/RTT degradation/i)
    expect(html).toMatch(/never claims?[^.]*faster than the official/i)
  })

  // i18n integrity (#673): setLang() only swaps an element when its key exists in i18n[lang]
  // (`if (... key in i18n[lang])`), so a key present in KO but missing from EN silently leaves
  // a stray Korean string on the EN page — invisible without a parity guard. The i18n object is
  // inline-script text (not an importable binding), so extract the KO/EN key sets from the
  // rendered HTML and assert they match, plus that every data-i18n key is translated in both.
  it('has matching KO/EN i18n key sets — no language drops a key (#673)', () => {
    const decl = html.slice(html.indexOf('const i18n = {'))
    const koStart = decl.indexOf('ko: {')
    const enStart = decl.indexOf('en: {')
    const enEnd = decl.indexOf('function setLang')
    expect(koStart).toBeGreaterThan(-1)
    expect(enStart).toBeGreaterThan(koStart)
    expect(enEnd).toBeGreaterThan(enStart)

    const koBlock = decl.slice(koStart, enStart)
    const enBlock = decl.slice(enStart, enEnd)
    const keysOf = (block: string) =>
      new Set([...block.matchAll(/'([A-Za-z0-9_.]+)':/g)].map((m) => m[1]))

    const koKeys = keysOf(koBlock)
    const enKeys = keysOf(enBlock)
    expect(koKeys.size).toBeGreaterThan(50) // sanity: the block was actually parsed
    expect([...koKeys].filter((k) => !enKeys.has(k))).toEqual([]) // KO key missing in EN
    expect([...enKeys].filter((k) => !koKeys.has(k))).toEqual([]) // EN key missing in KO

    // Every element the page asks to translate must have a key in both languages.
    const usedKeys = new Set([...html.matchAll(/data-i18n="([^"]+)"/g)].map((m) => m[1]))
    expect([...usedKeys].filter((k) => !koKeys.has(k) || !enKeys.has(k))).toEqual([])
  })

  // #1110 — the Better Stack roster is hand-listed in SIX strings: `s2.partial` and `s3.platformDesc`,
  // each existing three times (the inline KO default in the HTML, the `i18n.ko` map, the `i18n.en` map).
  // It had already drifted: Helicone was added to SERVICES in #802 and never reached `s2.partial`, so
  // the page told readers five services behaved a way six of them do. That is the drift class the
  // probe-count lockstep above already guards, so pin the roster the same way — to `betterStackUrl`,
  // the flag that actually routes a service to `parseBetterStackUptime`, not to a hand-kept list.
  //
  // Covering all six matters: a first cut of this guard matched only `data-i18n="…"` attributes, which
  // exist ONLY in the inline KO HTML, so dropping Helicone from either i18n map still passed 18/18.
  // A guard whose default state is `pass` has to be mutated against itself before it is believed.
  it('every Better Stack service is named in all six /methodology enumerations (#1110)', () => {
    const expected = SERVICES.filter((s) => s.betterStackUrl).map((s) => s.id)
    expect(expected.length).toBeGreaterThan(0) // sanity: the flag still exists

    const decl = html.slice(html.indexOf('const i18n = {'))
    const koStart = decl.indexOf('ko: {')
    const enStart = decl.indexOf('en: {')
    const enEnd = decl.indexOf('function setLang')
    const koMap = decl.slice(koStart, enStart)
    const enMap = decl.slice(enStart, enEnd)

    /** The value of one i18n key inside one language block. */
    const entry = (block: string, key: string) => {
      const m = block.match(new RegExp(`'${key.replaceAll('.', '\\.')}':\\s*'((?:\\\\'|[^'])*)'`))
      expect(m, `i18n entry '${key}' not found in its language block`).not.toBeNull()
      return m![1]
    }
    /** The inline (SSR default) copy for one data-i18n key. */
    const inline = (key: string, close: string) => {
      const m = html.match(new RegExp(`data-i18n="${key.replaceAll('.', '\\.')}"[^>]*>([\\s\\S]*?)</${close}>`))
      expect(m, `inline default for '${key}' not found`).not.toBeNull()
      return m![1]
    }

    const enumerations: Array<[string, string]> = [
      ['s2.partial inline', inline('s2.partial', 'p')],
      ['s2.partial ko', entry(koMap, 's2.partial')],
      ['s2.partial en', entry(enMap, 's2.partial')],
      ['s3.platformDesc inline', inline('s3.platformDesc', 'span')],
      ['s3.platformDesc ko', entry(koMap, 's3.platformDesc')],
      ['s3.platformDesc en', entry(enMap, 's3.platformDesc')],
    ]

    // Compare on the service ID, not the display name: the page writes the short marketing form
    // ("HuggingFace", "Together") while `name` is "Hugging Face" / "Together AI". Tokenise on the `·`
    // separator so a short id can't match incidentally across two concatenated words.
    const tokens = (block: string) =>
      new Set(block.split(/[·(),—]/).map((t) => t.toLowerCase().replace(/[^a-z0-9]/g, '')).filter(Boolean))

    // Subset AND superset: a missing service is the drift that started this, but a service listed here
    // that is NOT on Better Stack is the same lie in the other direction — and `s2.partial` states no
    // count in either language, so nothing else would catch an over-listing there.
    const otherIds = new Set(SERVICES.map((s) => s.id).filter((id) => !expected.includes(id)))
    for (const [where, block] of enumerations) {
      const present = tokens(block)
      for (const id of expected) {
        expect([...present], `Better Stack service "${id}" missing from ${where}`).toContain(id)
      }
      for (const id of present) {
        expect(otherIds.has(id), `"${id}" is listed in ${where} but is not a Better Stack service`).toBe(false)
      }
    }

    // The stated counts go stale silently too — pin both languages' numerals.
    const koCounts = [...html.matchAll(/이 (\d+)개 서비스의 상태 페이지는 Better Stack/g)]
    expect(koCounts.length, 'KO Platform bullet must state the count in both the inline copy and the ko map').toBe(2)
    for (const m of koCounts) expect(Number(m[1])).toBe(expected.length)

    const NUMBER_WORD: Record<number, string> = { 4: 'four', 5: 'five', 6: 'six', 7: 'seven', 8: 'eight' }
    const word = NUMBER_WORD[expected.length]
    expect(word, `add ${expected.length} to NUMBER_WORD — the EN copy spells this count out`).toBeDefined()
    expect(entry(enMap, 's3.platformDesc')).toContain(`These ${word} status pages`)
  })
})
