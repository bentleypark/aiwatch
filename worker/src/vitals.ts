// Web Vitals aggregation — collects metrics from frontend, stores daily p75 in KV
// Each beacon request writes directly to KV (no in-memory buffer — isolates are ephemeral)
// 10% client-side sampling keeps writes within budget (~30/day)

export interface VitalsPayload {
  metrics: Partial<Record<VitalName, number>>
  ts: number
}

export type VitalName = 'LCP' | 'FCP' | 'TTFB' | 'CLS' | 'INP'
export const VITAL_NAMES: VitalName[] = ['LCP', 'FCP', 'TTFB', 'CLS', 'INP']

export interface VitalsDaily {
  count: number
  p75: Record<VitalName, number>
}

// Max samples per metric to cap KV value size (~50KB)
const MAX_SAMPLES = 2000

/**
 * Validate a vitals payload. Returns extracted metrics or null if invalid.
 */
export function parseVitals(payload: unknown): Partial<Record<VitalName, number>> | null {
  if (!payload || typeof payload !== 'object') return null
  const p = payload as Record<string, unknown>
  const metrics = p.metrics
  if (!metrics || typeof metrics !== 'object') return null

  const m = metrics as Record<string, unknown>
  const result: Partial<Record<VitalName, number>> = {}
  let hasAny = false
  for (const name of VITAL_NAMES) {
    const val = m[name]
    if (typeof val === 'number' && isFinite(val) && val >= 0) {
      result[name] = val
      hasAny = true
    }
  }
  return hasAny ? result : null
}

/** KV storage shape for daily vitals */
interface VitalsKVData {
  count: number
  allValues: Record<VitalName, number[]>
}

function emptyValues(): Record<VitalName, number[]> {
  return { LCP: [], FCP: [], TTFB: [], CLS: [], INP: [] }
}

/**
 * Write vitals directly to KV, merging with existing daily data.
 * Called per-request (not buffered). 10% client sampling keeps writes ~30/day.
 */
export async function writeVitalsToKV(kv: KVNamespace, metrics: Partial<Record<VitalName, number>>): Promise<void> {
  const today = new Date().toISOString().split('T')[0]
  const key = `vitals:${today}`

  // Read existing
  const raw = await kv.get(key)
  let existing: VitalsKVData | null = null
  if (raw) {
    try {
      existing = JSON.parse(raw)
    } catch (err) {
      console.error('[vitals] corrupt KV data, resetting:', key, err instanceof Error ? err.message : err)
    }
  }

  // Merge
  const allValues = existing?.allValues ?? emptyValues()
  for (const name of VITAL_NAMES) {
    const val = metrics[name]
    if (val !== undefined) {
      if (!allValues[name]) allValues[name] = []
      allValues[name].push(val)
      if (allValues[name].length > MAX_SAMPLES) {
        allValues[name] = allValues[name].slice(-MAX_SAMPLES)
      }
    }
  }

  await kv.put(key, JSON.stringify({
    count: (existing?.count ?? 0) + 1,
    allValues,
  }), { expirationTtl: 2 * 86400 })
}

/** Compute p75 from an array of numbers */
export function computeP75(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const idx = Math.ceil(sorted.length * 0.75) - 1
  return sorted[Math.max(0, idx)]
}

/** Read today's vitals from KV and compute p75 summary for Daily Report */
export async function readVitalsSummary(kv: KVNamespace): Promise<VitalsDaily | null> {
  const today = new Date().toISOString().split('T')[0]
  const key = `vitals:${today}`
  const raw = await kv.get(key).catch((err) => {
    console.error('[vitals] KV read failed:', key, err instanceof Error ? err.message : err)
    return null
  })
  if (!raw) return null

  try {
    const data = JSON.parse(raw) as VitalsKVData
    if (!data.count || !data.allValues) return null

    const p75: Record<string, number> = {}
    for (const name of VITAL_NAMES) {
      p75[name] = computeP75(data.allValues[name] ?? [])
    }
    return { count: data.count, p75: p75 as Record<VitalName, number> }
  } catch (err) {
    console.error('[vitals] parse failed:', key, err instanceof Error ? err.message : err)
    return null
  }
}

/** Rate grade based on Web Vitals thresholds (Good / Needs Improvement / Poor) */
export function vitalsGrade(name: VitalName, value: number): 'good' | 'needs-improvement' | 'poor' {
  // CLS is stored as value × 1000 (e.g., 0.1 → 100)
  switch (name) {
    case 'LCP':  return value <= 2500 ? 'good' : value <= 4000 ? 'needs-improvement' : 'poor'
    case 'FCP':  return value <= 1800 ? 'good' : value <= 3000 ? 'needs-improvement' : 'poor'
    case 'TTFB': return value <= 800 ? 'good' : value <= 1800 ? 'needs-improvement' : 'poor'
    case 'CLS':  return value <= 100 ? 'good' : value <= 250 ? 'needs-improvement' : 'poor'  // ×1000 scale
    case 'INP':  return value <= 200 ? 'good' : value <= 500 ? 'needs-improvement' : 'poor'
  }
}

export function vitalsEmoji(grade: 'good' | 'needs-improvement' | 'poor'): string {
  return grade === 'good' ? '🟢' : grade === 'needs-improvement' ? '🟡' : '🔴'
}

const VITAL_DESC: Record<VitalName, string> = {
  LCP: '최대 요소 렌더링',
  FCP: '첫 콘텐츠 표시',
  TTFB: '서버 응답 시간',
  CLS: '레이아웃 흔들림',
  INP: '인터랙션 반응',
}

/** Format vitals for Discord daily summary */
export function formatVitalsSection(vitals: VitalsDaily): string {
  const lines: string[] = []
  lines.push(`\n📊 **Web Vitals** (p75, n=${vitals.count})`)
  for (const name of VITAL_NAMES) {
    const val = vitals.p75[name]
    if (!val && val !== 0) continue
    const grade = vitalsGrade(name, val)
    const emoji = vitalsEmoji(grade)
    const display = name === 'CLS'
      ? (val / 1000).toFixed(3)  // convert back to decimal
      : name === 'INP' ? `${val}ms` : `${(val / 1000).toFixed(2)}s`
    const label = grade === 'good' ? 'Good' : grade === 'needs-improvement' ? 'Needs Improvement' : 'Poor'
    lines.push(`   ${name.padEnd(5)} ${display.padStart(7)} ${emoji} ${label} — ${VITAL_DESC[name]}`)
  }
  lines.push(`   _p75 = 사용자 75%가 이 값 이하를 경험_`)
  return lines.join('\n')
}
