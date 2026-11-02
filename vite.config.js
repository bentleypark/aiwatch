import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'fs'
import { resolve } from 'path'
import { createHash } from 'crypto'

import { cloudflare } from "@cloudflare/vite-plugin";

const pkg = JSON.parse(readFileSync('./package.json', 'utf-8'))

function assetManifestPlugin() {
  return {
    name: 'asset-manifest',
    writeBundle(options) {
      const outDir = options.dir || resolve('dist')
      const assetsDir = resolve(outDir, 'assets')
      const files = readdirSync(assetsDir).map((f) => `/assets/${f}`)
      const hash = createHash('md5').update(files.sort().join(',')).digest('hex').slice(0, 8)
      writeFileSync(
        resolve(outDir, 'asset-manifest.json'),
        JSON.stringify({ version: hash, assets: files })
      )
    },
  }
}

// #1886 — Tailwind v4's stated floor (tailwindcss.com/docs/compatibility). Pinned here so a Vite
// default change cannot move it: Vite 8 raised its default from safari14 to safari16.4 with no diff.
export const BROWSER_FLOOR = ['chrome111', 'edge111', 'firefox128', 'safari16.4', 'ios16.4']

// A separate `build()` call does not inherit the SPA config, so the floor is passed here too.
export function serviceWorkerBuildConfig(outDir) {
  return {
    configFile: false,
    logLevel: 'warn',
    build: {
      outDir,
      target: BROWSER_FLOOR,
      emptyOutDir: false,
      copyPublicDir: false,
      lib: {
        entry: resolve('src/sw/index.js'),
        formats: ['iife'],
        name: 'aiwatchServiceWorker',
        fileName: () => 'sw.js',
      },
    },
  }
}

// #1386 — the service worker is built from `src/sw/`, not copied from `public/`, so its caching
// decisions can be imported as pure functions and unit-tested (the SW registers in production only,
// #432, so nothing else can reach them). Emitted unhashed at the dist root: `/sw.js` is the scope
// `src/main.jsx` registers, and IIFE because a classic worker cannot carry import statements.
// Runs on closeBundle — after assetManifestPlugin's writeBundle, and outside `dist/assets/`, so the
// asset-manifest hash that names the cache is unaffected.
function serviceWorkerPlugin() {
  let outDir = 'dist'
  return {
    name: 'service-worker',
    apply: 'build',
    // Taken from the resolved config rather than hardcoded, so this and assetManifestPlugin cannot
    // disagree about where the build is going.
    configResolved(config) {
      outDir = config.build.outDir
    },
    async closeBundle() {
      const { build } = await import('vite')
      await build(serviceWorkerBuildConfig(outDir))

      // The build must fail LOUDLY if the artifact is missing, because nothing downstream would say
      // so: `/sw.js` is not under `/assets/`, so the SPA catch-all answers it with index.html at 200
      // `text/html` and `register()` fails its MIME check into `src/main.jsx`'s empty `.catch` — no
      // red test, and the PWA is simply gone. Before #1386 this could not happen; `sw.js` was a file
      // in `public/`.
      //
      // The second check covers only what it says: a top-level `import`/`export` in the output,
      // which a classic worker cannot load. It is NOT a proof of IIFE format — a self-contained
      // bundle emitted as `formats: ['es']` carries neither statement and passes here.
      const swPath = resolve(outDir, 'sw.js')
      if (!existsSync(swPath)) {
        throw new Error(`service-worker: ${swPath} was not emitted — /sw.js would 404 in production`)
      }
      if (/^\s*(import|export)[\s{*'"]/m.test(readFileSync(swPath, 'utf-8'))) {
        throw new Error(
          `service-worker: ${swPath} carries a top-level import/export — a classic worker cannot load it`
        )
      }
    },
  }
}

// #1881 — React in its own chunk.
export const REACT_CHUNK = { name: 'react', test: /node_modules[\\/](react|react-dom|scheduler)[\\/]/ }

export default defineConfig({
  plugins: [react(), tailwindcss(), cloudflare(), assetManifestPlugin(), serviceWorkerPlugin()],
  build: {
    target: BROWSER_FLOOR,
    cssTarget: BROWSER_FLOOR,
    rolldownOptions: { output: { codeSplitting: { groups: [REACT_CHUNK] } } },
  },
  // Local-only read proxy for the production monthly archive. The production Worker
  // intentionally serves /api/report same-origin; this lets a local source-migration
  // Worker be verified against the already-collected archive without weakening CORS.
  server: {
    proxy: {
      '/__aiwatch_archive': {
        target: 'https://aiwatch-worker.p2c2kbf.workers.dev',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/__aiwatch_archive/, ''),
      },
    },
  },
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
})
