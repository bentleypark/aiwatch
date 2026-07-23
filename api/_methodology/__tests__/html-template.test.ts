import { describe, it, expect } from 'vitest'
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
    expect(html).toContain('Operational · Partial · Degraded · Down')
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

  it('keeps the probe count + non-probed set in LOCKSTEP with PROBE_TARGETS (#678)', () => {
    // The methodology copy hardcodes the probe count + the non-probed list. Derive the expected
    // count from the source of truth (worker/src/probe.PROBE_TARGETS) so a change to probe.ts that
    // forgets to update this page fails HERE — otherwise the two layers drift independently (the
    // exact regression #678 guards against).
    const n = PROBE_TARGETS.length // 33 as of #1067 (kimi); derived, so this comment is the only thing that can go stale
    expect(html).toContain(`${n} AI service`)  // EN (matches "32 AI services")
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
