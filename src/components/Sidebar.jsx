// Sidebar — Dashboard menu + 13 AI service list
// Uses usePolling data for live status dots and uptime badges.

import { useMemo } from 'react'
import { usePage } from '../utils/pageContext'
import { useLang } from '../hooks/useLang'
import { usePolling } from '../hooks/usePolling'

const EMPTY = []

// ── Nav icons (14×14 SVGs from design mockup) ───────────

function IconGrid() {
  return (
    <svg className="nav-icon" width="14" height="14" viewBox="0 0 14 14" fill="none">
      <rect x="1" y="1" width="5" height="5" rx="1" stroke="currentColor" strokeWidth="1.2" />
      <rect x="8" y="1" width="5" height="5" rx="1" stroke="currentColor" strokeWidth="1.2" />
      <rect x="1" y="8" width="5" height="5" rx="1" stroke="currentColor" strokeWidth="1.2" />
      <rect x="8" y="8" width="5" height="5" rx="1" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  )
}

function IconChart() {
  return (
    <svg className="nav-icon" width="14" height="14" viewBox="0 0 14 14" fill="none">
      <path d="M2 10L5 7L7 9L10 5L12 7" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function IconClock() {
  return (
    <svg className="nav-icon" width="14" height="14" viewBox="0 0 14 14" fill="none">
      <circle cx="7" cy="7" r="5" stroke="currentColor" strokeWidth="1.2" />
      <path d="M7 4V7L9 9" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  )
}

function IconTarget() {
  return (
    <svg className="nav-icon" width="14" height="14" viewBox="0 0 14 14" fill="none">
      <path d="M7 1v2M7 11v2M1 7h2M11 7h2" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
      <circle cx="7" cy="7" r="3" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  )
}

const NAV_ICONS = {
  overview: IconGrid,
  latency: IconChart,
  incidents: IconClock,
  uptime: IconTarget,
}

const DASHBOARD_ITEMS = [
  { name: 'overview', labelKey: 'nav.overview' },
  { name: 'latency', labelKey: 'nav.latency' },
  { name: 'incidents', labelKey: 'nav.incidents' },
  { name: 'uptime', labelKey: 'nav.uptime' },
]

const STATUS_DOT_CLASS = {
  operational: 'bg-[var(--green)]',
  degraded: 'bg-[var(--amber)]',
  down: 'bg-[var(--red)]',
}

// Uptime badge color: >= 99% green, >= 97% amber, else red
function uptimeBadgeCls(uptime) {
  if (uptime >= 99) return 'bg-[var(--status-bg-green)] text-[var(--green)]'
  if (uptime >= 97) return 'bg-[var(--status-bg-amber)] text-[var(--amber)]'
  return 'bg-[var(--status-bg-red)] text-[var(--red)]'
}

export default function Sidebar({ visibleServiceIds }) {
  const { page, setPage } = usePage()
  const { t } = useLang()
  const { services: rawServices } = usePolling()
  const services = rawServices ?? EMPTY

  const visibleServices = visibleServiceIds
    ? services.filter((s) => visibleServiceIds.includes(s.id))
    : services

  // Count badges for nav items
  const issueCount = useMemo(
    () => services.filter((s) => s.status !== 'operational').length,
    [services]
  )
  const incidentCount = useMemo(
    () => services.reduce((sum, s) => sum + (s.incidents?.length ?? 0), 0),
    [services]
  )

  return (
    <div className="flex flex-col h-full py-4 text-xs mono">
      {/* ── Dashboard section ── */}
      <div className="px-3 mb-2">
        <span className="text-[var(--text2)] uppercase tracking-[0.12em] text-[9px] px-2">
          {t('nav.dashboard')}
        </span>
      </div>
      <nav className="px-3 mb-2">
        {DASHBOARD_ITEMS.map((item) => {
          const active = page.name === item.name
          const Icon = NAV_ICONS[item.name]
          // Badge for overview (issue count) and incidents (incident count)
          const badge =
            item.name === 'overview' && issueCount > 0
              ? { count: issueCount, cls: 'bg-[var(--status-bg-red)] text-[var(--red)]' }
              : item.name === 'incidents' && incidentCount > 0
              ? { count: incidentCount, cls: 'bg-[var(--status-bg-red)] text-[var(--red)]' }
              : null

          return (
            <button
              key={item.name}
              onClick={() => setPage({ name: item.name })}
              aria-current={active ? 'page' : undefined}
              className={`relative w-full text-left px-2 py-[7px] rounded-[6px] flex items-center gap-2 transition-all text-[12px]
                ${active
                  ? 'bg-[var(--bg3)] text-[var(--text0)]'
                  : 'text-[var(--text1)] hover:bg-[var(--bg3)] hover:text-[var(--text0)]'
                }`}
            >
              {/* Active indicator — green left bar */}
              {active && (
                <span className="absolute left-0 top-1 bottom-1 w-0.5 rounded bg-[var(--green)]" />
              )}
              <span className="opacity-60 shrink-0">{Icon && <Icon />}</span>
              {t(item.labelKey)}
              {badge && (
                <span className={`ml-auto text-[9px] px-1.5 py-px rounded ${badge.cls}`}>
                  {badge.count}
                </span>
              )}
            </button>
          )
        })}
      </nav>

      {/* ── Divider ── */}
      <div className="h-px bg-[var(--border)] mx-3 my-2" />

      {/* ── Services section ── */}
      <div className="px-3 mb-2">
        <span className="text-[var(--text2)] uppercase tracking-[0.12em] text-[9px] px-2">
          {t('nav.services')}
        </span>
      </div>
      <nav className="flex-1 overflow-y-auto px-3">
        {visibleServices.map((svc) => {
          const active = page.name === 'service' && page.serviceId === svc.id
          const dotClass = STATUS_DOT_CLASS[svc.status] ?? STATUS_DOT_CLASS.operational
          const badgeCls = uptimeBadgeCls(svc.uptime30d ?? 100)
          return (
            <button
              key={svc.id}
              onClick={() => setPage({ name: 'service', serviceId: svc.id })}
              aria-current={active ? 'page' : undefined}
              className={`relative w-full text-left px-2 py-[7px] flex items-center gap-2 rounded-[6px] transition-all text-[12px]
                ${active
                  ? 'bg-[var(--bg3)] text-[var(--text0)]'
                  : 'text-[var(--text1)] hover:bg-[var(--bg3)] hover:text-[var(--text0)]'
                }`}
            >
              {active && (
                <span className="absolute left-0 top-1 bottom-1 w-0.5 rounded bg-[var(--green)]" />
              )}
              <span
                className={`w-1.5 h-1.5 rounded-full shrink-0 ${dotClass}`}
                aria-hidden="true"
              />
              <span className="truncate">{svc.name}</span>
              <span className={`ml-auto text-[9px] px-1.5 py-px rounded shrink-0 ${badgeCls}`}>
                {(svc.uptime30d ?? 0).toFixed(1)}%
              </span>
            </button>
          )
        })}
      </nav>

      {/* ── Divider + Footer ── */}
      <div className="h-px bg-[var(--border)] mx-3 my-2" />
      <div className="px-5 text-[var(--text2)] text-[9px] tracking-wide">
        {t('sidebar.footer')}
      </div>
    </div>
  )
}
