// Sidebar — Dashboard menu + 13 AI service list
// `services` prop: provided by the usePolling hook; polling proxy is Issue #15.
// `visibleServiceIds`: filters which services render. Driven by Settings toggles (Issue #14); defaults to all visible.

import { usePage } from '../utils/pageContext'
import { useLang } from '../hooks/useLang'

const VERSION = 'v1.0.0'

const DASHBOARD_ITEMS = [
  { name: 'overview',   labelKey: 'nav.overview' },
  { name: 'latency',    labelKey: 'nav.latency' },
  { name: 'incidents',  labelKey: 'nav.incidents' },
  { name: 'uptime',     labelKey: 'nav.uptime' },
]

const STATUS_DOT_CLASS = {
  operational: 'bg-[var(--green)]',
  degraded:    'bg-[var(--amber)]',
  down:        'bg-[var(--red)]',
}

// Placeholder service list — replaced by live data once usePolling is wired (Issue #15)
const PLACEHOLDER_SERVICES = [
  { id: 'claude',      name: 'Claude API',    status: 'operational' },
  { id: 'openai',      name: 'OpenAI API',    status: 'operational' },
  { id: 'gemini',      name: 'Gemini API',    status: 'operational' },
  { id: 'mistral',     name: 'Mistral API',   status: 'operational' },
  { id: 'cohere',      name: 'Cohere API',    status: 'operational' },
  { id: 'groq',        name: 'Groq Cloud',    status: 'operational' },
  { id: 'together',    name: 'Together AI',   status: 'operational' },
  { id: 'perplexity',  name: 'Perplexity',    status: 'operational' },
  { id: 'huggingface', name: 'Hugging Face',  status: 'operational' },
  { id: 'replicate',   name: 'Replicate',     status: 'operational' },
  { id: 'elevenlabs',  name: 'ElevenLabs',    status: 'operational' },
  { id: 'xai',         name: 'xAI (Grok)',    status: 'operational' },
  { id: 'deepseek',    name: 'DeepSeek API',  status: 'operational' },
]

// Default: all services visible. Overridden by Settings toggles (Issue #14).
const ALL_SERVICE_IDS = PLACEHOLDER_SERVICES.map((s) => s.id)

export default function Sidebar({
  services = PLACEHOLDER_SERVICES,
  visibleServiceIds = ALL_SERVICE_IDS,
}) {
  const { page, setPage } = usePage()
  const { t } = useLang()

  const visibleServices = services.filter((s) => visibleServiceIds.includes(s.id))

  return (
    <div className="flex flex-col h-full py-3 text-xs mono">
      {/* ── Dashboard section ── */}
      <div className="px-3 mb-1">
        <span className="text-[var(--text2)] uppercase tracking-wider text-[10px]">
          {t('nav.dashboard')}
        </span>
      </div>
      <nav className="mb-4">
        {DASHBOARD_ITEMS.map((item) => {
          const active = page.name === item.name
          return (
            <button
              key={item.name}
              onClick={() => setPage({ name: item.name })}
              className={`w-full text-left px-4 py-1.5 rounded-sm transition-colors
                ${active
                  ? 'bg-[var(--bg3)] text-[var(--text0)]'
                  : 'text-[var(--text1)] hover:bg-[var(--bg2)] hover:text-[var(--text0)]'
                }`}
            >
              {t(item.labelKey)}
            </button>
          )
        })}
      </nav>

      {/* ── Services section ── */}
      <div className="px-3 mb-1">
        <span className="text-[var(--text2)] uppercase tracking-wider text-[10px]">
          {t('nav.services')}
        </span>
      </div>
      <nav className="flex-1 overflow-y-auto">
        {visibleServices.map((svc) => {
          const active = page.name === 'service' && page.serviceId === svc.id
          const dotClass = STATUS_DOT_CLASS[svc.status] ?? STATUS_DOT_CLASS.operational
          return (
            <button
              key={svc.id}
              onClick={() => setPage({ name: 'service', serviceId: svc.id })}
              className={`w-full text-left px-4 py-1.5 flex items-center gap-2 rounded-sm transition-colors
                ${active
                  ? 'bg-[var(--bg3)] text-[var(--text0)]'
                  : 'text-[var(--text1)] hover:bg-[var(--bg2)] hover:text-[var(--text0)]'
                }`}
            >
              <span
                className={`w-1.5 h-1.5 rounded-full shrink-0 ${dotClass}`}
                aria-hidden="true"
              />
              {svc.name}
            </button>
          )
        })}
      </nav>

      {/* ── Version ── */}
      <div className="px-4 pt-3 border-t border-[var(--border)] text-[var(--text2)]">
        {VERSION}
      </div>
    </div>
  )
}
