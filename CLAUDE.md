# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev        # Start dev server (localhost:5173)
npm run build      # Production build → dist/
npm run preview    # Preview production build
npm run lint       # Run ESLint
```

```bash
npm test           # Run Playwright E2E tests (13 specs)
```

## Development Workflow

> **IMPORTANT**: 모든 작업을 시작하기 전에 이 섹션의 규칙을 반드시 다시 읽고 확인할 것. 특히 코드리뷰(3단계)와 테스트는 절대 생략하지 않는다.

### Per-issue process (follow this order every time)

0. **규칙 확인** — 작업 시작 전 이 Development Workflow 섹션을 다시 읽고 각 단계를 순서대로 따를 것
1. **Design check** (UI issues only) — before coding, compare `docs/AIWatch_화면디자인_초안.html` with the current implementation:
   - Open design mockup in browser and take screenshots of the relevant area
   - Identify **every** difference (spacing, colors, fonts, layout, icons, text)
   - List differences explicitly before writing any code
2. **Code** — implement the feature or fix
3. **Build + Test** — `npm run build` 성공 및 `npm test` 전체 통과 확인. 실패 시 코드 수정 후 재실행
4. **Review** — run PR review **before** committing:
   ```
   /pr-review-toolkit:review-pr
   ```
5. **Fix review issues** — address all **Critical** and **Important** findings. 수정 후 다시 Build + Test 실행
6. **Commit** — only after review issues are fixed and tests pass. Include `closes #N` in the message so GitHub links the commit
7. **Verify checklist** — read the issue (`gh issue view N`) and confirm every checklist item (`- [ ]`) is actually implemented in code before closing
8. **Close** — only close the issue after checklist verification: `gh issue close N`

> Never close an issue immediately after committing. Always re-read the issue checklist and verify each item against the code first.

## Architecture

**AIWatch** is a React SPA that monitors 19 AI services in real time:
- **13 API services**: Claude, OpenAI, Gemini, Mistral, Cohere, Groq, Together, Perplexity, HuggingFace, Replicate, ElevenLabs, xAI, DeepSeek
- **2 AI web apps**: claude.ai, ChatGPT
- **4 coding agents**: Claude Code, GitHub Copilot, Cursor, Windsurf

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
- Status polling proxy: `worker/` directory (monorepo), Cloudflare Workers
  - `cd worker && npm run dev` — local dev (port 8787)
  - `cd worker && npm run deploy` — deploy to Cloudflare
  - Endpoint: `GET /api/status` → ServiceStatus[]
- Deployment: Vercel Hobby (free), domain aiwatch.dev
