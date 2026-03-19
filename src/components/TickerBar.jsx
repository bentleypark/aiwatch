// Ticker Bar — auto-scrolling service status strip (desktop only)
// Real status data will be injected via `services` prop from usePolling (Issue #15).
// Until then, placeholder data is used.

const STATUS_COLOR = {
  operational: 'var(--green)',
  degraded: 'var(--amber)',
  down: 'var(--red)',
}

const STATUS_DOT = {
  operational: '●',
  degraded: '◐',
  down: '○',
}

// Placeholder data — replaced by live polling data in Issue #15
const PLACEHOLDER_SERVICES = [
  { id: 'claude',      name: 'Claude',       status: 'operational' },
  { id: 'openai',      name: 'OpenAI',       status: 'operational' },
  { id: 'gemini',      name: 'Gemini',       status: 'operational' },
  { id: 'mistral',     name: 'Mistral',      status: 'operational' },
  { id: 'cohere',      name: 'Cohere',       status: 'operational' },
  { id: 'groq',        name: 'Groq',         status: 'operational' },
  { id: 'together',    name: 'Together',     status: 'operational' },
  { id: 'perplexity',  name: 'Perplexity',   status: 'operational' },
  { id: 'huggingface', name: 'HuggingFace',  status: 'operational' },
  { id: 'replicate',   name: 'Replicate',    status: 'operational' },
  { id: 'elevenlabs',  name: 'ElevenLabs',   status: 'operational' },
  { id: 'xai',         name: 'xAI',          status: 'operational' },
  { id: 'deepseek',    name: 'DeepSeek',     status: 'operational' },
]

function TickerItem({ name, status }) {
  const color = STATUS_COLOR[status] ?? STATUS_COLOR.operational
  const dot = STATUS_DOT[status] ?? STATUS_DOT.operational
  return (
    <span className="inline-flex items-center gap-1 px-4 mono text-xs whitespace-nowrap select-none">
      <span style={{ color }} aria-hidden="true">{dot}</span>
      <span className="text-[var(--text1)]">{name}</span>
    </span>
  )
}

export default function TickerBar({ services = PLACEHOLDER_SERVICES }) {
  return (
    <div className="w-full overflow-hidden h-full flex items-center">
      <div
        className="flex will-change-transform"
        style={{ animation: `ticker-scroll ${services.length * 3}s linear infinite` }}
      >
        {/* First copy — visible to assistive technology */}
        {services.map((svc) => (
          <TickerItem key={svc.id} name={svc.name} status={svc.status} />
        ))}
        {/* Second copy — duplicate for seamless loop, hidden from screen readers */}
        <div aria-hidden="true" className="flex">
          {services.map((svc) => (
            <TickerItem key={`${svc.id}:dup`} name={svc.name} status={svc.status} />
          ))}
        </div>
      </div>
    </div>
  )
}
