// AIWatch Claude Code statusline integration guide (#400 Phase 0).
// Self-hosted surface so Phase 1 acceptance ("snippet documented somewhere
// reachable from ai-watch.dev") doesn't depend on third-party merge timelines.

import { useState } from 'react'
import { useLang } from '../hooks/useLang'
import { trackEvent } from '../utils/analytics'

const API_URL = 'https://ai-watch.dev/api/status/cached'

// Tag each preset's URL so Cloudflare request analytics can separate
// statusline-driven traffic from regular `/api/status/cached` hits and tell us
// which preset users actually run. The Worker matches only on `url.pathname`
// and reads from fixed KV keys (`services:latest`, etc.) — see the
// `url.pathname === '/api/status/cached'` route handler in worker/src/index.ts
// — so the query string is invisible to cache + KV behavior. It exists purely
// for the request-log split. Carries no user identifier; the preset slug is
// the only payload. Measurement framework + baseline-derived distribution
// gating thresholds (Reddit launch, Anthropic Claude Code docs PR) live on
// issue #400.
const taggedUrl = (src) => `${API_URL}?src=statusline-${src}`

// Slug constants are the join key between (a) the URL `?src=statusline-<slug>`
// query tag in Cloudflare request logs and (b) the GA4 `copy_statusline_snippet`
// event's `preset` parameter. Extracted to single source so a rename can't
// silently desynchronize one side from the other — that drift would invalidate
// the cross-system analytics correlation the gating measurement depends on.
const SLUG_DEGRADED_ONLY = 'degraded_only'
const SLUG_COMPACT_BADGE = 'compact_badge'
const SLUG_FULL_LIST = 'full_list'
const SLUG_SCOPED = 'scoped'
const SLUG_CLICKABLE = 'clickable'

function CopyButton({ text, eventLabel }) {
  const [copied, setCopied] = useState(false)
  const onClick = async () => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      trackEvent('copy_statusline_snippet', { preset: eventLabel })
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // Older browsers / restricted contexts — fall back to selection.
      // No prompt() so we don't break flow; user can still select+copy manually.
    }
  }
  return (
    <button
      onClick={onClick}
      className="mono text-[11px] font-medium cursor-pointer transition-colors flex items-center gap-1.5"
      style={{
        padding: '5px 12px',
        borderRadius: '4px',
        border: `1px solid ${copied ? 'var(--green)' : 'var(--border-hi)'}`,
        background: copied ? 'var(--status-bg-green)' : 'var(--bg3)',
        color: copied ? 'var(--green)' : 'var(--text0)',
      }}
      aria-label={copied ? 'Copied to clipboard' : 'Copy snippet to clipboard'}
    >
      {copied ? (
        <>
          <svg width="11" height="11" viewBox="0 0 11 11" fill="none" aria-hidden="true">
            <path d="M2 5.5L4.5 8L9.5 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          Copied
        </>
      ) : (
        <>
          <svg width="11" height="11" viewBox="0 0 11 11" fill="none" aria-hidden="true">
            <rect x="3" y="3" width="6" height="6" rx="1" stroke="currentColor" strokeWidth="1.2" />
            <path d="M3 3V2a1 1 0 011-1h5a1 1 0 011 1v5a1 1 0 01-1 1h-1" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
          </svg>
          Copy
        </>
      )}
    </button>
  )
}

function Snippet({ code, eventLabel }) {
  // Copy button placed FIRST in the header (left side) so it's the first thing
  // a user's left-to-right scan hits. Putting it on the right made it easy to
  // miss when the page chrome shrank the content column or when reviewers
  // assumed it was tied to the code block's horizontal scroll. The
  // settings.json label is now secondary metadata on the right.
  return (
    <div className="bg-[var(--bg0)] border border-[var(--border)] rounded-md overflow-hidden">
      <div className="flex items-center gap-3 border-b border-[var(--border)]" style={{ padding: '8px 12px' }}>
        <CopyButton text={code} eventLabel={eventLabel} />
        <span className="mono text-[10px] text-[var(--text2)] uppercase tracking-wider" style={{ marginLeft: 'auto' }}>settings.json</span>
      </div>
      <pre className="mono text-[11px] text-[var(--text0)]" style={{ padding: '12px', margin: 0, overflowX: 'auto', lineHeight: '1.5' }}>
        <code>{code}</code>
      </pre>
    </div>
  )
}

function Section({ title, children }) {
  return (
    <section className="bg-[var(--bg1)] border border-[var(--border)] rounded-lg overflow-hidden">
      <div className="border-b border-[var(--border)]" style={{ padding: '12px 16px' }}>
        <div className="mono text-[10px] text-[var(--text1)] uppercase tracking-wider flex items-center gap-1.5">
          <span className="rounded-full shrink-0" style={{ width: '5px', height: '5px', background: 'var(--teal)' }} />
          {title}
        </div>
      </div>
      <div style={{ padding: '16px' }}>
        {children}
      </div>
    </section>
  )
}

const PRESET_DEGRADED_ONLY = `{
  "statusLine": {
    "type": "command",
    "command": "( curl -sf --max-time 2 ${taggedUrl(SLUG_DEGRADED_ONLY)} | jq -r '[.services[] | select(.status != \\"operational\\") | \\"🔴 \\" + .name] | .[0:3] | join(\\" \\")' ) 2>/dev/null || true"
  }
}`

const PRESET_COMPACT_BADGE = `{
  "statusLine": {
    "type": "command",
    "command": "( curl -sf --max-time 2 ${taggedUrl(SLUG_COMPACT_BADGE)} | jq -r '([.services[] | select(.status != \\"operational\\")] | length) as $n | if $n == 0 then empty else \\"🔴 \\" + ($n|tostring) + \\" AI services\\" end' ) 2>/dev/null || true"
  }
}`

const PRESET_FULL_LIST = `{
  "statusLine": {
    "type": "command",
    "command": "( curl -sf --max-time 2 ${taggedUrl(SLUG_FULL_LIST)} | jq -r '[.services[] | select(.status != \\"operational\\") | \\"\\(if .status == \\"down\\" then \\"X\\" else \\"!\\" end)\\\\u00b7\\(.name)\\"] | join(\\" | \\")' ) 2>/dev/null || true"
  }
}`

const PRESET_SCOPED = `{
  "statusLine": {
    "type": "command",
    "command": "( curl -sf --max-time 2 ${taggedUrl(SLUG_SCOPED)} | jq -r '[.services[] | select(.id == \\"claude\\" or .id == \\"openai\\" or .id == \\"gemini\\") | select(.status != \\"operational\\") | \\"🔴 \\" + .name] | join(\\" \\")' ) 2>/dev/null || true"
  }
}`

// PRESET_CLICKABLE wraps each service name in an OSC 8 hyperlink so cmd+click
// (macOS) / ctrl+click (Linux) opens the AIWatch service detail page in the
// browser. The escape sequence is "ESC]8;;URL ESC\ TEXT ESC]8;; ESC\". Manual
// JS-string-with-backslash escaping for this is a nightmare to read, so we
// build the object and let JSON.stringify handle the JSON-level encoding for
// us. The inner template literal still has to escape jq-level backslashes
// (\\u001b for ESC, \\\\ for a literal "\" that jq's raw-output then emits).
const PRESET_CLICKABLE = JSON.stringify({
  statusLine: {
    type: 'command',
    command: `( curl -sf --max-time 2 ${taggedUrl(SLUG_CLICKABLE)} | jq -r '[.services[] | select(.status != "operational") | "\\u001b]8;;https://ai-watch.dev/#\\(.id)\\u001b\\\\🔴 \\(.name)\\u001b]8;;\\u001b\\\\"] | .[0:3] | join(" ")' ) 2>/dev/null || true`,
  },
}, null, 2)

export default function Statusline() {
  const { lang } = useLang()
  return (
    <div className="space-y-4">
      {lang === 'ko' && (
        <div
          className="border border-[var(--border)] rounded-md text-[var(--text2)]"
          style={{ padding: '10px 14px', fontSize: '11px', lineHeight: '1.6', background: 'var(--bg2)' }}
        >
          이 페이지는 영문으로만 제공됩니다 — 본문이 jq · curl 명령 위주라 영어로 유지했습니다. 명령어 자체는 한국어 환경에서도 동일하게 동작합니다.
        </div>
      )}
      <div>
        <h1 className="text-[var(--text0)] font-semibold" style={{ fontSize: '20px', marginBottom: '8px' }}>
          AIWatch in your Claude Code statusline
        </h1>
        <p className="text-[var(--text2)] text-[13px]" style={{ lineHeight: '1.6' }}>
          Surface AI service outages — Claude API, OpenAI, Gemini, GitHub Copilot, and 29 more — directly in your{' '}
          <a
            href="https://docs.claude.com/en/docs/claude-code/statusline"
            target="_blank"
            rel="noopener noreferrer"
            className="underline"
            style={{ color: 'var(--blue)' }}
          >
            Claude Code statusline
          </a>
          . When everything is healthy nothing is shown — your statusline real estate is preserved. When a service degrades or goes down, it appears with a red indicator so you can tell upstream issues from local ones at a glance.
        </p>
      </div>

      <Section title="Quick start (recommended preset)">
        <p className="text-[var(--text2)] text-[12px]" style={{ lineHeight: '1.6', marginBottom: '12px' }}>
          Add to <code className="mono text-[var(--text0)]">~/.claude/settings.json</code>. Output stays empty while every monitored service is operational; up to 3 degraded/down services appear with a red dot when something breaks.
        </p>
        <Snippet code={PRESET_DEGRADED_ONLY} eventLabel={SLUG_DEGRADED_ONLY} />
      </Section>

      <Section title="Other presets">
        <div className="space-y-4">
          <div>
            <h3 className="text-[var(--text0)] text-[13px] font-medium" style={{ marginBottom: '6px' }}>Compact badge</h3>
            <p className="text-[var(--text2)] text-[12px]" style={{ lineHeight: '1.6', marginBottom: '8px' }}>
              Shows a single count (e.g. <code className="mono text-[var(--text0)]">🔴 2 AI services</code>) instead of names. Best when statusline space is tight.
            </p>
            <Snippet code={PRESET_COMPACT_BADGE} eventLabel={SLUG_COMPACT_BADGE} />
          </div>

          <div>
            <h3 className="text-[var(--text0)] text-[13px] font-medium" style={{ marginBottom: '6px' }}>Full list with severity</h3>
            <p className="text-[var(--text2)] text-[12px]" style={{ lineHeight: '1.6', marginBottom: '8px' }}>
              Shows every degraded/down service with a one-character severity prefix — <code className="mono text-[var(--text0)]">X</code> for down, <code className="mono text-[var(--text0)]">!</code> for degraded. No emoji, plain text — friendly for Powerline themes that already provide their own iconography.
            </p>
            <Snippet code={PRESET_FULL_LIST} eventLabel={SLUG_FULL_LIST} />
          </div>

          <div>
            <h3 className="text-[var(--text0)] text-[13px] font-medium" style={{ marginBottom: '6px' }}>Scope to specific services</h3>
            <p className="text-[var(--text2)] text-[12px]" style={{ lineHeight: '1.6', marginBottom: '8px' }}>
              Filter to the providers you actually use. Edit the <code className="mono text-[var(--text0)]">.id == "claude"</code> list to match the services that matter for your workflow — see the{' '}
              <a
                href="https://github.com/bentleypark/aiwatch#available-service-ids"
                target="_blank"
                rel="noopener noreferrer"
                className="underline"
                style={{ color: 'var(--blue)' }}
              >
                full service ID table
              </a>{' '}on GitHub.
            </p>
            <Snippet code={PRESET_SCOPED} eventLabel={SLUG_SCOPED} />
          </div>

          <div>
            <h3 className="text-[var(--text0)] text-[13px] font-medium" style={{ marginBottom: '6px' }}>Clickable (OSC 8 hyperlink)</h3>
            <p className="text-[var(--text2)] text-[12px]" style={{ lineHeight: '1.6', marginBottom: '8px' }}>
              Each service name becomes a clickable hyperlink that opens the AIWatch service detail page (<code className="mono text-[var(--text0)]">cmd+click</code> on macOS, <code className="mono text-[var(--text0)]">ctrl+click</code> on Linux). Useful for jumping straight to incident details when the statusline shows something is wrong. Requires an OSC 8-compatible terminal — most modern emulators (iTerm2, Warp, kitty, WezTerm, VS Code integrated terminal, Terminal.app on macOS 12+) support it; tmux and some older shells may render the escape sequence as raw text instead.
            </p>
            <Snippet code={PRESET_CLICKABLE} eventLabel={SLUG_CLICKABLE} />
          </div>
        </div>
      </Section>

      <Section title="How it works">
        <ul className="text-[var(--text2)] text-[12px]" style={{ lineHeight: '1.7', listStyle: 'disc', paddingLeft: '20px' }}>
          <li>Single GET to <code className="mono text-[var(--text0)]">{API_URL}</code> per statusline render. CORS-enabled, no authentication, no client identifier collected.</li>
          <li>The endpoint serves a 5-minute KV-cached payload from Cloudflare's edge network — typical response time is under 100 ms from most regions.</li>
          <li>The shell command sets a 2-second timeout (<code className="mono text-[var(--text0)]">--max-time 2</code>) and fails silent (<code className="mono text-[var(--text0)]">2{'>'}/dev/null || true</code>) so a network hiccup never breaks your statusline.</li>
          <li>Each snippet appends a <code className="mono text-[var(--text0)]">?src=statusline-&lt;preset&gt;</code> query tag so we can split statusline-driven requests from the rest of the cached-endpoint traffic when deciding which presets to keep maintaining. The Worker matches on path only, so the tag has no effect on caching, freshness, or your response — and the only payload is the preset slug, never a user identifier.</li>
          <li>No requests to the Anthropic API. AIWatch operates its own status feed independently.</li>
        </ul>
      </Section>

      <Section title="Compatible with">
        <p className="text-[var(--text2)] text-[12px]" style={{ lineHeight: '1.7', marginBottom: '8px' }}>
          The snippets above use Claude Code's native <code className="mono text-[var(--text0)]">statusLine</code> setting and run through any tool that supports shell-command output. Drop them into:
        </p>
        <ul className="text-[var(--text2)] text-[12px]" style={{ lineHeight: '1.7', listStyle: 'disc', paddingLeft: '20px' }}>
          <li><strong className="text-[var(--text0)]">Native Claude Code</strong> — paste directly into <code className="mono text-[var(--text0)]">~/.claude/settings.json</code> as shown.</li>
          <li>
            <strong className="text-[var(--text0)]">
              <a
                href="https://github.com/sirmalloc/ccstatusline"
                target="_blank"
                rel="noopener noreferrer"
                className="underline"
                style={{ color: 'var(--blue)' }}
              >
                ccstatusline
              </a>
            </strong>
            {' '}— add as a Custom Command widget in the TUI; the command is the part inside the <code className="mono text-[var(--text0)]">"command":</code> field.
          </li>
          <li><strong className="text-[var(--text0)]">Any other statusline tool</strong> that exposes a shell-command output widget (the Custom Command pattern in most popular tools).</li>
        </ul>
      </Section>

      <Section title="Honest caveats">
        <ul className="text-[var(--text2)] text-[12px]" style={{ lineHeight: '1.7', listStyle: 'disc', paddingLeft: '20px' }}>
          <li><strong className="text-[var(--text0)]">5-minute cache lag</strong> — incidents can take up to 5 minutes to appear in the statusline after AIWatch detects them.</li>
          <li><strong className="text-[var(--text0)]">jq + curl required</strong> — pre-installed on macOS &amp; most Linux distros. Windows users: install via WSL or use <code className="mono text-[var(--text0)]">winget install jqlang.jq</code> with curl from Windows 10+.</li>
          <li><strong className="text-[var(--text0)]">Claude Code is Claude-only</strong> — this surface is informational, not a fallback router. When Claude API is down you'll know immediately, but you can't switch providers mid-session.</li>
          <li><strong className="text-[var(--text0)]">Self-hosters</strong> — replace <code className="mono text-[var(--text0)]">{API_URL}</code> with your own AIWatch deployment.</li>
        </ul>
      </Section>

      <div className="text-[var(--text2)] text-[11px]" style={{ lineHeight: '1.6' }}>
        AIWatch is open-source under AGPL-3.0. Source on{' '}
        <a href="https://github.com/bentleypark/aiwatch" target="_blank" rel="noopener noreferrer" className="underline" style={{ color: 'var(--blue)' }}>GitHub</a>.
      </div>
    </div>
  )
}
