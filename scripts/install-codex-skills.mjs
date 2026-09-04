import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.dirname(scriptDir)
const sourceRoot = path.join(repoRoot, '.codex', 'skills')
const codexRoot = process.env.CODEX_HOME || path.join(process.env.HOME || process.env.USERPROFILE, '.codex')
const targetRoot = path.join(codexRoot, 'skills')

if (!fs.existsSync(sourceRoot)) {
  throw new Error(`Codex skill source directory not found: ${sourceRoot}`)
}

for (const entry of fs.readdirSync(sourceRoot, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue
  const source = path.join(sourceRoot, entry.name)
  const target = path.join(targetRoot, entry.name)
  fs.mkdirSync(targetRoot, { recursive: true })
  fs.cpSync(source, target, { recursive: true, force: true })
  console.log(`Installed ${entry.name} -> ${target}`)
}
