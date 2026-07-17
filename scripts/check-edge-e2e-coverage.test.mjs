import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  findEdgeE2eGaps,
  specCoversPage,
  pagePathToken,
  readPageStems,
  readSpecSources,
  findEdgeProjects,
  findUnwiredEdgeProjects,
  findDesktopLeaks,
  findApiPageDirs,
  projectFlags,
  auditRepo,
  NON_PAGE_ENDPOINTS,
  PAGE_PATH_OVERRIDES,
} from './check-edge-e2e-coverage.mjs'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const BYPASS = '/tmp/.edge-bypass-state.json'
const EDGE_USE = { baseURL: 'x', storageState: BYPASS }

// The four fail-open holes a TEXT parse of playwright.config.js had (all proven by review, all
// dissolved by classifying the IMPORTED config structurally). Pinned so nobody "simplifies" back.
const PROJECTS = [
  { name: 'desktop', use: {}, testIgnore: /mobile\.spec|edge-pages\.spec/ },
  { name: 'edge-pages', use: EDGE_USE, testMatch: /edge-pages\.spec/ },
  { name: 'edge-spread', use: { ...EDGE_USE, viewport: {} }, testMatch: /edge-spread\.spec/ },
]

test('a spread `use` is still an Edge project (the text parse matched nothing here)', () => {
  assert.deepEqual(
    findEdgeProjects(PROJECTS, BYPASS).map((p) => p.name),
    ['edge-pages', 'edge-spread'],
  )
})

test('key order is irrelevant to structural classification', () => {
  const reordered = [{ use: EDGE_USE, name: 'edge-new', testMatch: /x/ }]
  assert.deepEqual(findEdgeProjects(reordered, BYPASS).map((p) => p.name), ['edge-new'])
})

test('flags an Edge project that test:edge never runs', () => {
  assert.deepEqual(
    findUnwiredEdgeProjects(PROJECTS, BYPASS, 'playwright test --project=edge-pages'),
    ['edge-spread'],
  )
})

test('a longer project name does NOT satisfy a shorter one', () => {
  // `--project=edge-pages-v2` satisfying `edge-pages` is the same false-pass class as
  // '/plugin-privacy' covering '/plugin' — closed one level down, so close it here too.
  assert.deepEqual(projectFlags('test --project=edge-pages-v2'), ['edge-pages-v2'])
  assert.ok(
    findUnwiredEdgeProjects(PROJECTS, BYPASS, 'test --project=edge-pages-v2').includes('edge-pages'),
  )
})

test('flags an Edge spec desktop would also run against Vite', () => {
  // edge-spread.spec is absent from desktop's testIgnore → desktop runs it at :5173, where it 404s.
  assert.deepEqual(
    findDesktopLeaks(PROJECTS, BYPASS, ['edge-pages.spec.js', 'edge-spread.spec.js']),
    ['edge-spread:edge-spread.spec.js'],
  )
})

test('findDesktopLeaks fails CLOSED when the desktop project is gone', () => {
  const out = findDesktopLeaks([PROJECTS[1]], BYPASS, ['edge-pages.spec.js'])
  assert.equal(out.length, 1)
  assert.match(out[0], /fail-closed/)
})

test('a page referenced ONLY by a non-Edge spec is still a gap', () => {
  // The desktop project runs at Vite :5173, where Edge paths 404 — so `a[href="/badges"]` in a
  // desktop spec mentions the path while nothing Edge-loads it. auditRepo scopes the sources to
  // specs an Edge project's testMatch actually claims; this pins the scoping decision itself.
  const specs = [
    { file: 'navigation.spec.js', source: 'page.click(\'a[href="/badges"]\')' },
    { file: 'edge-pages.spec.js', source: "const PAGES = [{ path: '/plugin' }]" },
  ]
  const edgeSpecs = specs.filter((s) => PROJECTS.some((p) => p.testMatch?.test(s.file)))
  assert.deepEqual(edgeSpecs.map((s) => s.file), ['edge-pages.spec.js'])
  assert.deepEqual(findEdgeE2eGaps(['badges'], edgeSpecs.map((s) => s.source)), ['badges'])
  // ...and the unscoped call is exactly the false pass, i.e. the scoping is load-bearing.
  assert.deepEqual(findEdgeE2eGaps(['badges'], specs.map((s) => s.source)), [])
})

test('findDesktopLeaks reports a non-RegExp pattern in its own voice', () => {
  const stringMatch = [
    { name: 'desktop', use: {}, testIgnore: /x/ },
    { name: 'edge-str', use: EDGE_USE, testMatch: 'edge-str.spec.js' },
  ]
  const out = findDesktopLeaks(stringMatch, BYPASS, ['edge-str.spec.js'])
  assert.match(out[0], /not a RegExp/)
})

test('the REAL repo passes every coverage + wiring check', async () => {
  assert.deepEqual(await auditRepo(repoRoot), [])
})

test('flags a page no spec navigates to', () => {
  assert.deepEqual(findEdgeE2eGaps(['plugin'], ["await page.goto('/intro')"]), ['plugin'])
})

test('passes a page a spec navigates to', () => {
  assert.deepEqual(findEdgeE2eGaps(['plugin'], ["await page.goto('/plugin')"]), [])
})

test('a prefix path is NOT covered by a longer sibling path', () => {
  // The guard's own false-pass trap: '/plugin-privacy'.includes('/plugin') is true, which would
  // report /plugin covered while no spec ever loads it — the same invisible gap one level up.
  assert.deepEqual(findEdgeE2eGaps(['plugin'], ["page.goto('/plugin-privacy')"]), ['plugin'])
  assert.deepEqual(findEdgeE2eGaps(['plugin-privacy'], ["page.goto('/plugin-privacy')"]), [])
})

test('prose cannot fake coverage — comments and test titles are not code', () => {
  // Caught for real: before the strip, deleting /plugin from the PAGES table still passed, because
  // the spec's header comment and its `test.describe('/plugin serves …')` title both say "/plugin".
  assert.deepEqual(findEdgeE2eGaps(['plugin'], ['// we should test /plugin someday']), ['plugin'])
  assert.deepEqual(findEdgeE2eGaps(['plugin'], ['/* covers /plugin */ page.goto("/intro")']), ['plugin'])
  assert.deepEqual(findEdgeE2eGaps(['plugin'], ["test.describe('/plugin works', () => {})"]), ['plugin'])
  assert.deepEqual(findEdgeE2eGaps(['plugin'], ["test('/plugin works', () => {})"]), ['plugin'])
  // ...but a data table of real paths IS code, and must still count.
  assert.deepEqual(findEdgeE2eGaps(['plugin'], ["const PAGES = [{ path: '/plugin' }]"]), [])
})

test('specCoversPage is boundary-aware', () => {
  assert.equal(specCoversPage("'/plugin'", '/plugin'), true)
  assert.equal(specCoversPage("'/plugin?x=1'", '/plugin'), true)
  assert.equal(specCoversPage("'/plugin-privacy'", '/plugin'), false)
  assert.equal(specCoversPage("'/plugins'", '/plugin'), false)
})

test('non-page endpoints are exempt, and each exemption carries a reason', () => {
  assert.deepEqual(findEdgeE2eGaps(['csp-report'], []), [])
  for (const [stem, reason] of NON_PAGE_ENDPOINTS) {
    assert.ok(reason && reason.length > 20, `${stem} exemption needs a real reason`)
  }
})

test('irregular paths resolve via overrides, regular ones default to /<stem>', () => {
  assert.ok(pagePathToken('is-down') instanceof RegExp) // served as /is-{slug}-down, pinned as a shape
  assert.equal(pagePathToken('methodology'), '/methodology') // no entry needed
  assert.deepEqual(findEdgeE2eGaps(['is-down'], ["page.goto('/is-claude-down')"]), [])
})

test('a brand-new page defaults to needing a spec (no override entry required)', () => {
  assert.deepEqual(findEdgeE2eGaps(['brand-new'], ["page.goto('/intro')"]), ['brand-new'])
})

// The assertion that actually guards the repo: everything above could pass on synthetic input while
// the real tree is uncovered. Mirrors check-e2e-ga-guard.test.mjs's real-tests/ assertion.
test('the REAL api/ + tests/ tree has no uncovered Edge page', () => {
  const stems = readPageStems(join(repoRoot, 'api'))
  assert.ok(stems.length >= 9, `expected the api/ page set, got ${stems.length}`)
  assert.deepEqual(findEdgeE2eGaps(stems, readSpecSources(join(repoRoot, 'tests'))), [])
})

test('every override + exemption still points at a real api/ file', () => {
  // A page deleted or renamed leaves a stale entry that silently exempts nothing — or worse, masks
  // its replacement. Fails loudly instead.
  const stems = new Set(readPageStems(join(repoRoot, 'api')))
  for (const stem of [...NON_PAGE_ENDPOINTS.keys(), ...PAGE_PATH_OVERRIDES.keys()]) {
    assert.ok(stems.has(stem), `stale entry: api/${stem}.ts no longer exists`)
  }
})
