import { defineConfig, devices } from '@playwright/test'

// #570: the Edge-SSR projects (is-down/intro/reports/consent) default to a local
// `vercel dev` on :3333, but in CI we point them at the PR's Vercel Preview deployment
// via EDGE_BASE_URL (set by the deployment_status-triggered edge-e2e workflow). When
// EDGE_BASE_URL is set we also skip the Vite webServer — the Edge run needs no local
// server (the preview is remote) and only the Edge projects run in that job.
const EDGE_BASE_URL = process.env.EDGE_BASE_URL || 'http://localhost:3333'

export default defineConfig({
  testDir: './tests',
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
      use: { ...devices['Desktop Chrome'], baseURL: EDGE_BASE_URL },
      testMatch: /is-down\.spec/,
    },
    {
      name: 'intro',
      use: { ...devices['Desktop Chrome'], baseURL: EDGE_BASE_URL },
      testMatch: /intro\.spec/,
    },
    {
      name: 'reports',
      use: { ...devices['Desktop Chrome'], baseURL: EDGE_BASE_URL },
      testMatch: /reports\.spec/,
    },
    {
      name: 'consent',
      // Edge SSR + inline cookie banner gate (#352) — runs against vercel dev :3333.
      use: { ...devices['Desktop Chrome'], baseURL: EDGE_BASE_URL },
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
