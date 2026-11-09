import { SERVICE_CATEGORIES } from './constants'

// Ticker follows the dev-audience category order (#658): LLM APIs → Coding Agents → Voice →
// Inference & Infra → Video → AI Apps. Flatten SERVICE_CATEGORIES (minus the 'all' meta-bucket)
// into a single id sequence so the strip scrolls in that order — no group dividers (continuous
// stream). A service missing from the map sorts to the end (defensive; the partition test pins
// SERVICE_CATEGORIES to the full service set).
const TICKER_ORDER_INDEX = new Map(
  Object.keys(SERVICE_CATEGORIES)
    .filter((k) => k !== 'all')
    .flatMap((k) => SERVICE_CATEGORIES[k].ids)
    .map((id, i) => [id, i]),
)

// Sort a raw services array into the dev-audience ticker order (#658). Pure + exported so the
// ordering invariant (Coding Agents follow LLM APIs, AI Apps last) is unit-testable without
// rendering the component. Non-mutating; unknown ids sort to the end.
export function orderServicesForTicker(rawServices) {
  return [...(rawServices ?? [])].sort(
    (a, b) =>
      (TICKER_ORDER_INDEX.get(a.id) ?? Number.MAX_SAFE_INTEGER) -
      (TICKER_ORDER_INDEX.get(b.id) ?? Number.MAX_SAFE_INTEGER),
  )
}

// #1233 — `unknown` (AIWatch could not read the source) needs its own entry in BOTH maps. Without one
// it fell through the `?? operational` default below and rendered a GREEN dot on the always-visible
// ticker — asserting health nobody had checked. The neutral tokens match StatusPill's `unknown` pill.
//
// The `??` default is what makes an omission silent here, so these two maps are the shape to check
// whenever the status union grows: the lookup is by key, not a comparison, so it is invisible to both
// the type checker and a `.status === '...'` grep.
const STATUS_DOT_CLASS = {
  operational: 'bg-[var(--green)]',
  degraded: 'bg-[var(--amber)]',
  down: 'bg-[var(--red)]',
  unknown: 'bg-[var(--text2)]',
}

const STATUS_TEXT_CLASS = {
  operational: 'text-[var(--text1)]',
  degraded: 'text-[var(--amber)]',
  down: 'text-[var(--red)]',
  unknown: 'text-[var(--text2)]',
}

/** #1233 — the ticker's classes for a status, exported so the mapping is unit-testable. `TickerItem`
 *  is an internal component, so before this the two maps below had no test at all and an omission was
 *  invisible: a missing key falls through the default, and a LOOKUP is reachable by neither the type
 *  checker nor a `.status === '...'` grep — which is how `unknown` came to render green here.
 *
 *  The default is the NEUTRAL entry, not the operational one. An unrecognised status is a state we
 *  cannot interpret, and painting it green claims health nobody checked — the same fail-safe direction
 *  `statusVerdict` and `badgeStatusColor` take on the worker side. */
export function tickerClassesFor(status) {
  return {
    dot: STATUS_DOT_CLASS[status] ?? STATUS_DOT_CLASS.unknown,
    text: STATUS_TEXT_CLASS[status] ?? STATUS_TEXT_CLASS.unknown,
  }
}
