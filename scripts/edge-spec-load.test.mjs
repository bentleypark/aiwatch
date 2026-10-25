// #1191 — the Edge e2e projects only run against a Vercel preview, so a spec that fails to LOAD
// (an import Playwright's loader cannot resolve) was invisible to every local run. `--list` loads
// each spec without a browser or a server.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { findEdgeProjects } from './check-edge-e2e-coverage.mjs'
import { EDGE_BYPASS_STATE } from '../playwright/edge-bypass-setup.js'
import config from '../playwright.config.js'

test('every Edge Playwright project loads its specs', () => {
  const edge = findEdgeProjects(config.projects, EDGE_BYPASS_STATE).map(p => p.name)
  assert.ok(edge.length > 0, 'no Edge project found in playwright.config.js')
  const r = spawnSync('npx', ['playwright', 'test', ...edge.flatMap(p => ['--project', p]), '--list'], {
    env: { ...process.env, EDGE_BASE_URL: 'http://127.0.0.1:1' },
    encoding: 'utf8',
  })
  const out = `${r.stdout}\n${r.stderr}`
  assert.equal(r.status, 0, out)
  const total = Number(out.match(/Total: (\d+) tests? in/)?.[1] ?? 0)
  assert.ok(total > 0, out)
})
