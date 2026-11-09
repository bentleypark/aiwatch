// #918 — server-side rendering. The Worker returns the FINAL statusline string
// (`GET /api/statusline/<preset>` → text/plain, the exact OSC-8 output the bar
// shows), so each snippet is a thin `curl … || true` with NO jq. The old model
// shipped a jq program the user pasted into their config, which FROZE the display
// logic on their machine — a formatting change (e.g. the `+N` overflow marker)
// could never reach an installed statusline. Rendering server-side means every
// future display change ships to all users via a Worker deploy, and drops the jq
// dependency entirely. See worker/src/statusline.ts `renderStatuslinePreset`.
//
// Point snippets at the Worker domain directly, NOT ai-watch.dev (#438): the
// ai-watch.dev path is a Vercel rewrite that *proxies* to the Worker, so
// per-prompt polls counted as Vercel Fast Data Transfer (the #1 bandwidth route).
// Hitting the Worker keeps it on Cloudflare.
export const STATUSLINE_API = 'https://aiwatch-worker.p2c2kbf.workers.dev/api/statusline'

// Per-preset endpoint URL. The preset lives in the PATH (`/api/statusline/<slug>`),
// which the Worker both routes on AND tags in WAE (`statusline-<slug>`) for the #400
// adoption measurement — no query string, no user identifier.
const presetUrl = (slug) => `${STATUSLINE_API}/${slug}`

// Slug constants are the join key between (a) the `/api/statusline/<slug>` request
// PATH the Worker tags adoption on and (b) the GA4 `copy_statusline_snippet`
// event's `preset` parameter. Extracted to single source so a rename can't
// silently desynchronize one side from the other — that drift would invalidate
// the cross-system analytics correlation the gating measurement depends on.
export const SLUG_DEGRADED_ONLY = 'degraded_only'
export const SLUG_COMPACT_BADGE = 'compact_badge'
export const SLUG_FULL_LIST = 'full_list'
export const SLUG_SCOPED = 'scoped'
export const SLUG_CLICKABLE = 'clickable'
export const SLUG_BRANDED = 'branded'

// #918 — every preset is now a thin curl at its server-rendered endpoint (no jq).
// The Worker owns ALL formatting (names, +N overflow, OSC-8 links, severity), so
// these snippets never change again even as the display evolves. Built via a shared
// helper so the shape (2s timeout + fail-silent) can't drift between presets.
const presetSnippet = (slug) => `{
  "statusLine": {
    "type": "command",
    "command": "( curl -sf --max-time 2 ${presetUrl(slug)} ) 2>/dev/null || true"
  }
}`

export const PRESET_DEGRADED_ONLY = presetSnippet(SLUG_DEGRADED_ONLY)
export const PRESET_COMPACT_BADGE = presetSnippet(SLUG_COMPACT_BADGE)
export const PRESET_FULL_LIST = presetSnippet(SLUG_FULL_LIST)
export const PRESET_SCOPED = presetSnippet(SLUG_SCOPED)
export const PRESET_CLICKABLE = presetSnippet(SLUG_CLICKABLE)
// PRESET_BRANDED — the recommended preset. Always-on "AIWatch" label (OSC-8 → dashboard),
// 🟢 when healthy, up to 3 red service names (each an OSC-8 link to its detail page) + a
// `+N` overflow marker when more are down. All rendered server-side (renderStatuslinePreset).
export const PRESET_BRANDED = presetSnippet(SLUG_BRANDED)
