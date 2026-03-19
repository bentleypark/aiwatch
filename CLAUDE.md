# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev        # Start dev server (localhost:5173)
npm run build      # Production build → dist/
npm run preview    # Preview production build
npm run lint       # Run ESLint
```

No test runner is configured yet.

## Development Workflow

### Per-issue process (follow this order every time)

1. **Code** — implement the feature or fix
2. **Review** — run PR review before committing:
   ```
   /pr-review-toolkit:review-pr
   ```
   Address all **Critical** and **Important** findings before committing.
3. **Commit** — include `closes #N` in the message so GitHub links the commit
4. **Verify checklist** — read the issue (`gh issue view N`) and confirm every checklist item (`- [ ]`) is actually implemented in code before closing
5. **Close** — only close the issue after checklist verification: `gh issue close N`

> Never close an issue immediately after committing. Always re-read the issue checklist and verify each item against the code first.

## Architecture

**AIWatch** is a React SPA that monitors 13 AI API services (Claude, OpenAI, Gemini, Mistral, Cohere, Groq, Together, Perplexity, HuggingFace, Replicate, ElevenLabs, xAI, DeepSeek) in real time.

### Tech Stack
- **React 19 + Vite 6** — SPA, no router library
- **TailwindCSS v4** — utility classes + CSS custom properties for design tokens (see below)
- **Chart.js + react-chartjs-2** — latency line charts, uptime bar charts
- **Cloudflare Workers** (planned) — status polling proxy; all 13 status pages are fetched server-side to avoid CORS

### Directory Layout
Directories are scaffolded; files are pending implementation.
```
src/
  components/   # Shared UI: StatusPill, SkeletonUI, EmptyState, Modal, TickerBar
  pages/        # Overview, Latency, Incidents, Uptime, ServiceDetails, Settings
  hooks/        # usePolling, useTheme, useLang, useSettings
  utils/        # Status normalization, time formatting, applyLang
  locales/      # ko.js, en.js — flat key→string maps (default exports)
  assets/
```

### Design System
All colors are CSS custom properties defined in `src/index.css`. **Never use hardcoded hex values** — always reference tokens:

| Token | Purpose |
|---|---|
| `--bg0…--bg4` | Background layers (darkest → lighter) |
| `--green / --amber / --red` | Operational / Degraded / Down |
| `--blue / --teal` | Informational |
| `--text0…--text2` | Primary → muted text |
| `--border / --border-hi` | Subtle / prominent borders |

Theme switching: add `data-theme="light"` to `<html>` — CSS variables remap automatically. Default is dark.

### i18n
`src/locales/ko.js` and `en.js` export flat `{ 'dot.key': 'string' }` maps (default exports). Mark translatable elements with `data-i18n="key"` attributes.

**Planned:** `applyLang(lang)` in `src/utils/` will swap `data-i18n` element text and persist the selection to `localStorage`. Note: the exact implementation may use React state/context instead of direct DOM traversal once components are built.

### Status Data Flow (planned)
```
Browser → Cloudflare Worker (proxy) → AI service status pages
                ↓
        Normalized ServiceStatus[]
        { id, name, status, latency, uptime30d, incidents[] }
                ↓
        React state (usePolling hook) → all pages read from context
```

### SPA Navigation (planned)
No React Router. A top-level `currentPage` state in `App.jsx` will determine which `<Page />` component renders. Sidebar and service-name clicks will update this state. URL hash can optionally mirror the state.

### Key Product Constraints
- Mobile breakpoint: 768px — sidebar hidden (overlay on hamburger), ticker bar hidden, cards go 1-column
- Phase 3 features (AI Analysis via Claude API, Slack Webhook, Cloudflare KV cache) are UI-disabled with "준비 중" labels — do not remove these placeholders
- Status polling proxy lives in a separate Cloudflare Workers project (not this repo)
- Deployment: Vercel Hobby (free), domain aiwatch.dev
