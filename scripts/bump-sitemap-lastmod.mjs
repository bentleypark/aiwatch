#!/usr/bin/env node
// #337: bump <lastmod> in public/sitemap.xml to today's UTC date so Googlebot sees fresh re-crawl
// priority signals. Without this, `lastmod` silently drifts (we saw 4-32 day staleness in production
// on 2026-04-24).
//
// #648: gated to DEPLOY/CI builds only. The `prebuild` npm hook fires on EVERY `npm run build`,
// including local dev builds — which rewrote the working tree on every build and forced a manual
// `git checkout public/sitemap.xml` before each commit (recurring review-step friction + a risk of
// committing date-only churn). Google reads the *served* sitemap, which Vercel rebuilds (and bumps)
// on every deploy: `prebuild` rewrites the source `public/sitemap.xml`, and Vite copies that
// freshly-bumped file into the served `dist/sitemap.xml`. The committed file is only a base — so
// skipping the bump locally does not stale the SEO signal. Vercel sets VERCEL=1 during its build.
//
// Node-based rather than sed so the same script works on BSD (macOS local) and GNU (Vercel Linux)
// without flag quirks.

import fs from 'node:fs'
import path from 'node:path'

const LASTMOD_RE = /<lastmod>\d{4}-\d{2}-\d{2}<\/lastmod>/g

// Only bump on a real deploy/CI build — not on local `npm run build` (#648).
export function shouldBump(env = process.env) {
  return Boolean(env.VERCEL || env.CI)
}

// Pure transform: replace every YYYY-MM-DD <lastmod> with `today`. Returns the new content + the
// match count + whether anything changed (count 0 = schema drift; changed false = already today).
// The strict YYYY-MM-DD match won't touch any other timestamps elsewhere in the file.
export function bumpLastmod(content, today) {
  const matches = content.match(LASTMOD_RE) ?? []
  const next = content.replace(LASTMOD_RE, `<lastmod>${today}</lastmod>`)
  return { content: next, count: matches.length, changed: next !== content }
}

function main() {
  if (!shouldBump()) {
    console.log('[bump-sitemap] local build (no VERCEL/CI env) — skipping lastmod bump (deploy-only, #648)')
    return
  }

  const sitemapPath = path.resolve(process.cwd(), 'public/sitemap.xml')
  if (!fs.existsSync(sitemapPath)) {
    console.error(`[bump-sitemap] ${sitemapPath} not found — skipping (not a fatal build error)`)
    return
  }

  const today = new Date().toISOString().slice(0, 10)
  const before = fs.readFileSync(sitemapPath, 'utf8')
  const { content: after, count, changed } = bumpLastmod(before, today)

  if (count === 0) {
    // Genuine schema drift — no YYYY-MM-DD <lastmod> entries at all. Warn so a future contributor who
    // changes the sitemap format (e.g. to ISO datetime) updates this script too instead of silently
    // deploying with stale signals.
    console.error(`[bump-sitemap] WARNING: no <lastmod>YYYY-MM-DD</lastmod> entries in ${sitemapPath} — schema may have changed, update this script`)
    return
  }
  if (!changed) {
    console.log(`[bump-sitemap] ${count} entries already at ${today} — no change`)
    return
  }

  fs.writeFileSync(sitemapPath, after)
  console.log(`[bump-sitemap] updated ${count} <lastmod> entries → ${today}`)
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main()
}
