// #1191 — the worker/ files the Vercel build bundles, read from esbuild's metafile with every non-test
// file under src/ and api/ as an entry point. vercel-should-build.sh must watch each of them.
import { readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { buildSync } from 'esbuild'

const SOURCE = /\.(m?[jt]sx?)$/
const isTest = (path) => /(^|\/)__tests__\/|\.(test|spec)\.[jt]sx?$/.test(path)

function walk(dir) {
  const out = []
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) out.push(...walk(path))
    else if (SOURCE.test(name)) out.push(path)
  }
  return out
}

export function frontendWorkerImports(repoRoot) {
  const entryPoints = ['src', 'api'].flatMap(dir => walk(join(repoRoot, dir)))
    .filter(path => !isTest(relative(repoRoot, path)))
  const { metafile } = buildSync({
    absWorkingDir: repoRoot,
    entryPoints,
    bundle: true,
    write: false,
    metafile: true,
    outdir: 'out',
    packages: 'external',
    format: 'esm',
    jsx: 'automatic',
    loader: { '.js': 'jsx', '.css': 'empty', '.svg': 'empty', '.png': 'empty' },
    logLevel: 'silent',
  })
  return Object.keys(metafile.inputs).filter(path => path.startsWith('worker/')).sort()
}
