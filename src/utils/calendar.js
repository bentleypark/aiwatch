// Build status calendar from service data
// Uses local dates to match how official status pages display dates to users.
// Returns array of N cell statuses (default 30, incident.io services use 14). The cell keys are
// IMPACT-ALIGNED and frontend-internal (NOT the wire `service.status`) — #663 renamed them from the
// old degraded_perf/degraded/down so the key name matches the incident impact and the severity order
// is self-evident, decoupling the calendar from the 3-state badge that shares the `status.*` i18n:
//   'critical'    — red:    critical impact (major/full outage)
//   'major'       — orange: major impact (partial outage)
//   'minor'       — yellow: minor / null / unknown impact (degraded)
//   'operational' — green:  no incidents
// User-facing labels (#674: Critical / Major / Minor / Operational — the Statuspage impact axis) via the
// `cal.status.*` i18n keys. Index 0 = oldest, last index = today.

const STATUS_RANK = { operational: 0, minor: 1, major: 2, critical: 3 }

function escalate(dayStatus, key, status) {
  if ((STATUS_RANK[status] ?? 0) > (STATUS_RANK[dayStatus[key]] ?? 0)) {
    dayStatus[key] = status
  }
}

// Map an incident impact to a calendar cell status (single source of truth for Phase 1/2/3). The cell
// keys now equal the impact name (critical/major), with minor/null/unknown → 'minor' (yellow).
function impactToCellStatus(impact) {
  if (impact === 'critical') return 'critical'
  if (impact === 'major') return 'major'
  return 'minor'
}

// Convert Date to local YYYY-MM-DD string
function toLocalDateKey(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export function buildCalendarFromIncidents(incidents, dailyImpact, days = 30, currentStatus = undefined, dailyImpactComplete = undefined) {
  const today = new Date()
  const dayStatus = {}
  const todayKey = toLocalDateKey(today)

  // A day with no reliable time-of-day (a bare-UTC-date dailyImpact entry, or a `status_history`-
  // derived incident's `derivedDay` — see `incidentLocalDay` below) is anchored at noon UTC as the
  // best available guess, clamped to local "today": for a viewer west of UTC early in a UTC day, the
  // guessed local day can otherwise land in their future and vanish from the rendered window. Returns
  // null on an unparseable `dateStr` — the caller must skip the entry rather than paint anything: an
  // invalid `Date` stringifies to `"NaN-NaN-NaN"`, which compares as GREATER than any real date key,
  // so an un-nulled clamp would silently redirect a garbled key onto "today" (#1400 review finding).
  function dayOnlyLocalKey(dateStr) {
    const anchor = new Date(`${dateStr}T12:00:00Z`)
    if (isNaN(anchor.getTime())) return null
    const guessed = toLocalDateKey(anchor)
    return guessed > todayKey ? todayKey : guessed
  }

  // The local day a SPECIFIC incident belongs to, or null if it cannot be determined. A
  // `status_history`-derived incident's `startedAt` is a SYNTHETIC anchor timestamp — Better Stack/
  // aiStudio publish only a daily record with no real start/end time, so AIWatch invents one purely
  // to have a sortable field (#1400 — Together AI's "Kimi K3 — recovered", `startedAt: "…19:00:00Z"`,
  // is not when anything actually happened; its real information is `derivedDay`, day-only like a
  // bare dailyImpact entry). A genuine incident's `startedAt` IS a real instant — safe, and in fact
  // more precise than a bare-date dailyImpact entry for the same day (see Phase 1 below).
  function incidentLocalDay(inc) {
    if (inc.derived === 'status_history') return inc.derivedDay ? dayOnlyLocalKey(inc.derivedDay) : null
    const start = new Date(inc.startedAt)
    return isNaN(start.getTime()) ? null : toLocalDateKey(start)
  }

  // A bare-UTC-date dailyImpact entry (statuspage/betterstack/flashduty/rootly) carries no exact
  // instant of its own — Phase 1 below has to GUESS a local day for it (the noon-UTC anchor above).
  // That guess is never needed when a GENUINE incident's precise timestamp is available for the SAME
  // UTC day and every such incident AGREES on which local day it is: an incident's own local time is
  // exact, not a guess, and it is also what the Incident History card already displays — so the
  // calendar should agree with it rather than with a synthetic UTC-noon anchor (#1400 — an incident
  // whose Incident History card read "Sep 11, 01:50 GMT+9" was previously calendar-painted on
  // "Sep 10", the UTC day, purely from the noon-anchor guess). Requiring AGREEMENT (a single-member
  // Set, not just "the first incident found") matters because several unrelated incidents can share
  // one UTC day yet straddle a local midnight between them — picking an arbitrary one previously
  // misattributed Mistral's own 2026-09-04 dailyImpact entry onto 2026-09-05 (#1400 review finding),
  // because the incidents list happened to be ordered with a late-UTC-evening entry first. When they
  // disagree, there is no single incident dailyImpact's day-level aggregate can be said to belong to
  // — the noon-UTC guess is the honest answer, same as when there is no incident at all. Derived
  // incidents never enter this map (their `startedAt` isn't a real instant — see `incidentLocalDay`),
  // which correctly leaves their matching dailyImpact day to the noon-UTC guess, the right treatment
  // for a source that itself only publishes a day-level record.
  const localDaysByUtcDay = new Map()
  for (const inc of incidents ?? []) {
    if (!inc.startedAt || inc.derived === 'status_history') continue
    const start = new Date(inc.startedAt)
    if (isNaN(start.getTime())) continue
    const utcDay = start.toISOString().slice(0, 10)
    if (!localDaysByUtcDay.has(utcDay)) localDaysByUtcDay.set(utcDay, new Set())
    localDaysByUtcDay.get(utcDay).add(toLocalDateKey(start))
  }

  // Phase 1: Apply dailyImpact — bare keys are the SOURCE's own displayed day (Rootly/Flashduty: UTC;
  // Better Stack/aiStudio: whatever day their own API groups by), remapped to local below; full-ISO
  // keys are a real instant (incident.io). dailyImpact values are impact names (critical/major/minor),
  // which now equal the cell keys — so map via the shared impactToCellStatus (skips any unknown impact
  // by returning 'minor', but dailyImpact only emits the three known levels).
  if (dailyImpact) {
    const KNOWN_IMPACT = new Set(['critical', 'major', 'minor'])
    for (const [key, impact] of Object.entries(dailyImpact)) {
      if (!KNOWN_IMPACT.has(impact)) continue
      let localKey
      if (key.includes('T')) {
        // incident.io emits full ISO timestamps → bucket the REAL instant to the viewer's local day
        // (fixes the UTC-vs-local off-by-one, #693 follow-up).
        const d = new Date(key)
        if (isNaN(d.getTime())) continue
        localKey = toLocalDateKey(d)
      } else {
        const agreedDays = localDaysByUtcDay.get(key)
        localKey = agreedDays && agreedDays.size === 1 ? [...agreedDays][0] : dayOnlyLocalKey(key)
        if (localKey === null) continue // unparseable key — drop rather than guess "today"
      }
      escalate(dayStatus, localKey, impactToCellStatus(impact))
    }
  }

  // Phase 2: Apply per-incident data.
  // Skipped only when `dailyImpact` already accounts for EVERY day — which the WORKER states per
  // service (`dailyImpactComplete`), because only it knows which branch built the map. There, Phase 1
  // is complete and adding incidents would introduce noise from unrelated components.
  // Everything else supplements Phase 1 with the service's own incidents.
  //
  // #1390 — this used to read `days === 30`, i.e. a window LENGTH standing in for a provenance fact.
  // That held only while every 30-day service happened to be Atlassian. Giving perplexity a
  // `statusComponentId` flipped its window to 30, and with it this gate — so an incident.io incident
  // that the provider published with NO `component_impacts` row (perplexity's `Computer Tasks
  // Degraded`, 2026-09-01) stopped being painted at all, on a card that lists it one section below.
  // Six services were already in that state (openai/chatgpt/codex/langsmith/langfuse/junie). The
  // worker now states the fact; `days` decides only how many cells to draw.
  //
  // `undefined` falls back to the old derivation so a payload cached before the field existed renders
  // exactly as it did — every fresh payload carries it within one cycle.
  const impactOwnsEveryDay = !!dailyImpact && (dailyImpactComplete ?? days === 30)
  if (!impactOwnsEveryDay) {
    const windowStart = new Date(today.getTime() - (days - 1) * 86_400_000)
    ;(incidents ?? []).forEach((inc) => {
      if (!inc.startedAt) return
      const start = new Date(inc.startedAt)
      if (isNaN(start.getTime())) return
      const status = impactToCellStatus(inc.impact) // same map for ongoing/resolved (minor/null → yellow)
      // dailyImpact services (incident.io 14-day): the official per-day record (Phase 1) owns the
      // days — supplement only the START day to avoid spanning noise across unrelated components.
      // Ongoing incidents likewise paint only the start day here (Phase 3 extends them to today).
      // no-dailyImpact services (RSS/JSON-only: Bedrock/Azure) with a RESOLVED incident have no
      // per-day record, so the incident must span its OWN days startedAt→resolvedAt (window-clamped),
      // else a multi-day outage shows only its start day (#691 — surfaced by #677's real durations).
      if (dailyImpact || !inc.resolvedAt) {
        const localDay = incidentLocalDay(inc)
        if (localDay !== null) escalate(dayStatus, localDay, status)
        return
      }
      const end = new Date(inc.resolvedAt)
      // A malformed OR inverted (resolvedAt < startedAt) range can't be spanned — paint the start
      // day only, never nothing (an inverted range would make the loop run zero times otherwise).
      if (isNaN(end.getTime()) || end.getTime() < start.getTime()) {
        escalate(dayStatus, toLocalDateKey(start), status)
        return
      }
      const from = start < windowStart ? windowStart : start
      const endClamped = end.getTime() > today.getTime() ? today : end // guard a future resolvedAt
      const endKey = toLocalDateKey(endClamped)
      // step day-by-day (noon-anchored, DST-safe) from start → resolved, inclusive
      for (let cur = new Date(from.getFullYear(), from.getMonth(), from.getDate(), 12);
           toLocalDateKey(cur) <= endKey;
           cur.setDate(cur.getDate() + 1)) {
        escalate(dayStatus, toLocalDateKey(cur), status)
      }
    })
  }

  // Phase 3 (#662): extend ONGOING incidents forward to "today" — source-aware, so the official
  // record stays authoritative for finalized past days.
  //   • services WITH an official daily record (dailyImpact: statuspage / incident.io / betterstack /
  //     aistudio / flashduty-DeepSeek): official buckets own past days; fill ONLY today's (local) cell
  //     from the live ongoing status — today's official bucket isn't finalized yet, so this
  //     contradicts nothing. Without this an active incident leaves today green.
  //   • services with NO daily record (no dailyImpact — RSS-only, e.g. Bedrock/Azure): nothing to
  //     contradict → span startedAt→today (clamped to the window), the only multi-day signal.
  // GATED on the live badge: only when the service is actually non-operational. A service can stay
  // `operational` with an open informational/minor incident (e.g. claude); painting the calendar for
  // those is noise (mirrors the old worker-augment `svcStatus !== 'operational'` guard, #662).
  // #1233 — an unreadable source (`unknown`) must not trip this. It is not a verdict about the
  // service, so treating it as one would forward-fill today's calendar cell (and the Overview 30-bar
  // strip) as an outage day, from an incident list we could not refresh.
  if (currentStatus && currentStatus !== 'operational' && currentStatus !== 'unknown') {
    const windowStart = new Date(today.getTime() - (days - 1) * 86_400_000)
    ;(incidents ?? []).forEach((inc) => {
      if (inc.status === 'resolved' || !inc.startedAt) return
      const start = new Date(inc.startedAt)
      if (isNaN(start.getTime())) return // skip a malformed startedAt explicitly (don't rely on key ordering)
      const status = impactToCellStatus(inc.impact)
      if (dailyImpact) {
        escalate(dayStatus, todayKey, status) // today only — defer past days to the official record
      } else {
        const from = start < windowStart ? windowStart : start
        // step day-by-day (noon-anchored, DST-safe) from start → today, inclusive
        for (let cur = new Date(from.getFullYear(), from.getMonth(), from.getDate(), 12);
             toLocalDateKey(cur) <= todayKey;
             cur.setDate(cur.getDate() + 1)) {
          escalate(dayStatus, toLocalDateKey(cur), status)
        }
      }
    })
  }

  return Array.from({ length: days }, (_, i) => {
    const d = new Date(today.getTime() - (days - 1 - i) * 86_400_000)
    return dayStatus[toLocalDateKey(d)] ?? 'operational'
  })
}
