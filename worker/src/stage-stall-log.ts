// #1934 — the stage-watchdog line, kept past Workers Logs' 7 days. One Analytics Engine point per fire:
//   index1  = `stage-stall:{route}`
//   blob1   = route
//   blob2   = pending stages, comma-joined
//   blob3   = colo
//   blob4   = `view` query param ('' when absent)
//   blob5   = `id` query param ('' when absent)
//   blob6   = done stages as JSON `{stage: settle ms}`
//   double1 = afterMs

import type { StageWatchdogLine } from './stage-watchdog'

export interface StageStallContext {
  colo: string
  view: string
  id: string
}

export function stageStallPoint(line: StageWatchdogLine, ctx: StageStallContext): AnalyticsEngineDataPoint {
  return {
    indexes: [`stage-stall:${line.route}`],
    blobs: [line.route, line.pending.join(','), ctx.colo, ctx.view, ctx.id, JSON.stringify(line.done)],
    doubles: [line.afterMs],
  }
}

export function recordStageStall(analytics: AnalyticsEngineDataset | undefined, line: StageWatchdogLine, ctx: StageStallContext): void {
  if (!analytics) return
  try {
    analytics.writeDataPoint(stageStallPoint(line, ctx))
  } catch (err) {
    console.warn('[wae] stage-stall writeDataPoint failed:', err instanceof Error ? err.message : err)
  }
}

export function stageStallContext(request: Request, url: URL): StageStallContext {
  const cf = request.cf as { colo?: unknown } | undefined
  return {
    colo: typeof cf?.colo === 'string' ? cf.colo : 'UNK',
    view: url.searchParams.get('view') ?? '',
    id: url.searchParams.get('id') ?? '',
  }
}
