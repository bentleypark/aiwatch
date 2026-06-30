// One-shot: generate the extension's 16/48/128 PNG icons from the canonical
// public/icon-512.png (sharp). Run after changing the source icon:
//   node scripts/generate-extension-icons.mjs
// The outputs are committed (extension/icons/*) so the unpacked load + Web Store
// build don't depend on a generate step.
import sharp from 'sharp'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { mkdirSync } from 'node:fs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const SRC = join(root, 'public', 'icon-512.png')
const OUT = join(root, 'extension', 'icons')
const SIZES = [16, 48, 128]

mkdirSync(OUT, { recursive: true })

for (const size of SIZES) {
  const dest = join(OUT, `icon-${size}.png`)
  await sharp(SRC).resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toFile(dest)
  console.log(`✓ ${dest} (${size}×${size})`)
}
console.log('done')
