// #1360 — true when the module at `moduleUrl` is the process entry point. Both sides are resolved to
// their real path, so a script run through a symlinked path still runs its `main()`.

import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export function isMain(moduleUrl, argv1 = process.argv[1]) {
  try { return realpathSync(fileURLToPath(moduleUrl)) === realpathSync(argv1) } catch { return false }
}
