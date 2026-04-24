#!/usr/bin/env node
// #337: bump <lastmod> in public/sitemap.xml to today's UTC date.
// Runs as `prebuild` on every Vercel deploy so Googlebot sees fresh re-crawl
// priority signals. Without this, `lastmod` silently drifts (we saw 4-32 day
// staleness in production on 2026-04-24).
//
// Node-based rather than sed so the same script works on BSD (macOS local)
// and GNU (Vercel Linux) without flag quirks.

import fs from 'node:fs'
import path from 'node:path'

const SITEMAP_PATH = path.resolve(process.cwd(), 'public/sitemap.xml')
const today = new Date().toISOString().slice(0, 10)

if (!fs.existsSync(SITEMAP_PATH)) {
  console.error(`[bump-sitemap] ${SITEMAP_PATH} not found — skipping (not a fatal build error)`)
  process.exit(0)
}

const before = fs.readFileSync(SITEMAP_PATH, 'utf8')
// Strict YYYY-MM-DD match — won't touch any other timestamps elsewhere in the file.
const matches = before.match(/<lastmod>\d{4}-\d{2}-\d{2}<\/lastmod>/g) ?? []
if (matches.length === 0) {
  // Genuine schema drift — no YYYY-MM-DD <lastmod> entries at all. Warn so a
  // future contributor who changes the sitemap format (e.g. to ISO datetime)
  // updates this script too instead of silently deploying with stale signals.
  console.error(`[bump-sitemap] WARNING: no <lastmod>YYYY-MM-DD</lastmod> entries in ${SITEMAP_PATH} — schema may have changed, update this script`)
  process.exit(0)  // non-fatal so builds don't break on a docs edit
}

const after = before.replace(/<lastmod>\d{4}-\d{2}-\d{2}<\/lastmod>/g, `<lastmod>${today}</lastmod>`)
if (after === before) {
  console.log(`[bump-sitemap] ${matches.length} entries already at ${today} — no change`)
  process.exit(0)
}

fs.writeFileSync(SITEMAP_PATH, after)
console.log(`[bump-sitemap] updated ${matches.length} <lastmod> entries → ${today}`)
