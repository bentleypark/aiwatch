// #1531 — a request the Edge cancels at 5 s never reaches a log line at its end, so the stall has to be
// reported while the request is still running: one line at `afterMs` naming the stages that finished
// (with the ms each took to settle) and the ones still pending.

export interface StageWatchdog {
  track<T>(stage: string, work: Promise<T>): Promise<T>
  stop(): void
}

export function startStageWatchdog(
  route: string,
  afterMs: number,
  log: (line: Record<string, unknown>) => void = (line) => console.warn(line),
): StageWatchdog {
  const t0 = Date.now()
  const done: Record<string, number> = {}
  const pending = new Set<string>()
  const timer = setTimeout(() => {
    log({ event: 'stage-watchdog', route, afterMs, done, pending: [...pending] })
  }, afterMs)
  return {
    track(stage, work) {
      pending.add(stage)
      const settle = () => { pending.delete(stage); done[stage] = Date.now() - t0 }
      work.then(settle, settle)
      return work
    },
    stop() { clearTimeout(timer) },
  }
}
