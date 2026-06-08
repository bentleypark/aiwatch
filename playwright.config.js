import { defineConfig, devices } from '@playwright/test'
import { EDGE_BYPASS_STATE } from './playwright/edge-bypass-setup.js'

// #570: the Edge-SSR projects (is-down/intro/reports/consent) default to a local
// `vercel dev` on :3333, but in CI we point them at the PR's Vercel Preview deployment
// via EDGE_BASE_URL (set by the deployment_status-triggered edge-e2e workflow). When
// EDGE_BASE_URL is set we also skip the Vite webServer — the Edge run needs no local
// server (the preview is remote) and only the Edge projects run in that job.
const EDGE_BASE_URL = process.env.EDGE_BASE_URL || 'http://localhost:3333'

// #570: Vercel Preview has Deployment Protection (401 to anonymous requests). globalSetup
// (playwright/edge-bypass-setup.js) obtains a preview-domain-scoped bypass cookie and saves
// it to EDGE_BYPASS_STATE; the Edge projects load it via storageState so navigations get
// through. The setup writes an empty (cookie-less) state when no secret/EDGE_BASE_URL is
// present, so local `vercel dev` runs are unaffected and the secret never leaves the
// preview origin (we avoid extraHTTPHeaders, which would leak it cross-origin to GA4/CDNs).
const EDGE_USE = { ...devices['Desktop Chrome'], baseURL: EDGE_BASE_URL, storageState: EDGE_BYPASS_STATE }

export default defineConfig({
  testDir: './tests',
  // #570: runs once before all projects — primes the Vercel preview bypass cookie (no-op
  // / empty state when EDGE_BASE_URL + the secret aren't both set, i.e. local/desktop runs).
  globalSetup: './playwright/edge-bypass-setup.js',
  timeout: 60000,
  expect: { timeout: 20000 },
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: 'html',
  use: {
    baseURL: 'http://localhost:5173',
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'desktop',
      use: { ...devices['Desktop Chrome'] },
      testIgnore: /mobile\.spec|is-down\.spec|intro\.spec|reports\.spec|consent\.spec/,
    },
    {
      name: 'mobile',
      use: { viewport: { width: 375, height: 812 } },
      testMatch: /mobile\.spec/,
    },
    {
      name: 'is-down',
      // Port matches CLAUDE.md "Local verification by page type" table — `vercel dev --listen 3333`
      use: EDGE_USE,
      testMatch: /is-down\.spec/,
    },
    {
      name: 'intro',
      use: EDGE_USE,
      testMatch: /intro\.spec/,
    },
    {
      name: 'reports',
      use: EDGE_USE,
      testMatch: /reports\.spec/,
    },
    {
      name: 'consent',
      // Edge SSR + inline cookie banner gate (#352) — runs against vercel dev :3333.
      use: EDGE_USE,
      testMatch: /consent\.spec/,
    },
  ],
  // Skip the Vite dev server when running only the Edge projects against a remote
  // preview (EDGE_BASE_URL set) — desktop/mobile aren't run in that job, so :5173
  // would start unused. Local + the desktop/mobile CI job keep the Vite webServer.
  webServer: process.env.EDGE_BASE_URL
    ? undefined
    : {
        command: 'npm run dev',
        url: 'http://localhost:5173',
        reuseExistingServer: !process.env.CI,
      },
})
