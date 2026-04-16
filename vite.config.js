import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { readFileSync, readdirSync, writeFileSync } from 'fs'
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

export default defineConfig({
  plugins: [react(), tailwindcss(), cloudflare(), assetManifestPlugin()],
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
})
