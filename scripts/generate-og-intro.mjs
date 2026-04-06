#!/usr/bin/env node
// Generate OG intro image (1200×630 PNG) for social sharing & GitHub preview.
// Uses public/icon-192.png as the logo icon.
// Usage: node scripts/generate-og-intro.mjs
// Output: public/og-intro.png + docs/social-preview.png
//
// Update SERVICE_COUNT when adding new services.

import { createRequire } from 'module'
const require = createRequire(import.meta.url)
const sharp = require('sharp')
const path = require('path')
const fs = require('fs')

const SERVICE_COUNT = 30
const rootDir = path.resolve(import.meta.dirname, '..')

// Resize icon-192.png and encode as base64 for SVG embedding
const iconPath = path.join(rootDir, 'public', 'icon-192.png')
const iconBuffer = await sharp(iconPath).resize(72, 72).png().toBuffer()
const iconB64 = iconBuffer.toString('base64')

const svg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="1200" height="630" viewBox="0 0 1200 630">
  <rect width="1200" height="630" fill="#080c10"/>

  <!-- Logo icon -->
  <image x="564" y="120" width="72" height="72" href="data:image/png;base64,${iconB64}"/>

  <!-- AI Watch text -->
  <text x="582" y="218" text-anchor="end" fill="#e6edf3" font-size="16" font-weight="700" font-family="Arial, Helvetica, sans-serif" letter-spacing="0.3">AI</text>
  <text x="588" y="218" text-anchor="start" fill="#3fb950" font-size="16" font-weight="700" font-family="Arial, Helvetica, sans-serif" letter-spacing="0.3">Watch</text>

  <!-- Title -->
  <text x="600" y="296" text-anchor="middle" fill="#e6edf3" font-size="40" font-weight="700" font-family="Arial, Helvetica, sans-serif" letter-spacing="-0.5">Real-time AI Service Monitoring</text>

  <!-- Subtitle -->
  <text x="600" y="345" text-anchor="middle" fill="#8b949e" font-size="22" font-family="Arial, Helvetica, sans-serif">Track ${SERVICE_COUNT} AI services · AI-powered incident analysis · Instant fallback</text>

  <!-- Footer -->
  <text x="600" y="518" text-anchor="middle" fill="#3fb950" font-size="20" font-family="Arial, Helvetica, sans-serif">Free &amp; Open Source</text>
  <text x="600" y="550" text-anchor="middle" fill="#484f58" font-size="18" font-family="Arial, Helvetica, sans-serif">ai-watch.dev/intro</text>
</svg>`

const targets = [
  path.join(rootDir, 'public', 'og-intro.png'),
  path.join(rootDir, 'docs', 'social-preview.png'),
]

for (const target of targets) {
  await sharp(Buffer.from(svg)).png().toFile(target)
  console.log(`✓ ${path.relative(rootDir, target)}`)
}
console.log(`\nGenerated with ${SERVICE_COUNT} services.`)
