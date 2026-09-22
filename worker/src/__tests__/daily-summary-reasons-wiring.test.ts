import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const index = readFileSync(join(__dirname, '..', 'index.ts'), 'utf8')

describe('#1470 daily-summary source-reason wiring', () => {
  it('reads each service reason from today and passes it to the production summary call', () => {
    expect(index).toMatch(/const parseFailDay = parseParseFailDay\(await env\.STATUS_CACHE\.get\(parseFailKey\(today\)\)/)
    expect(index).toMatch(/const reasons = Object\.keys\(parseFailDay\.counts\[svc\.id\] \?\? \{\}\)/)
    expect(index).toMatch(/if \(reasons\.length > 0\) fetchFailureReasons\[svc\.id\] = reasons/)
    expect(index).toMatch(/fetchFailureCounts,\s*fetchFailureReasons,\s*crossValidSuppressed,/)
  })
})
