# Contributing to AIWatch

Thank you for your interest in contributing to AIWatch!

## Getting Started

1. Fork the repository
2. Clone your fork: `git clone https://github.com/YOUR_USERNAME/aiwatch.git`
3. Install dependencies:
   ```bash
   npm install
   cd worker && npm install && cd ..
   ```
4. Start dev servers: `npm run dev:all`

## Development Workflow

Use [AGENTS.md](./AGENTS.md) as the shared repository entrypoint.

If you are working with Claude Code, also follow [CLAUDE.md](./CLAUDE.md) for Claude-specific
workflow and automation details.

Shared workflow — especially:

1. **Build + Test** before committing
2. **Code review** before committing
3. **Fix all Critical/Important** review findings
4. Include `closes #N` in commit messages when the work is fully verified

## Code Style

- **CSS**: Use design tokens (`var(--green)`, not `#3fb950`). See `src/index.css`
- **i18n**: Add keys to both `src/locales/ko.js` and `en.js`
- **Components**: Prefer inline styles for values Tailwind v4 doesn't generate reliably
- **Worker**: TypeScript, error logging with `console.error/warn`

## Testing

```bash
npm test             # Playwright E2E tests
npm run test:src     # Frontend unit tests (vitest — incl. the CSP hash drift pin, #877 CI-gated)
npm run test:worker  # Worker unit tests (vitest)
```

All tests must pass before submitting a PR — CI gates `test:src`, `test:worker`, and the E2E suite.

## Pull Request Guidelines

- Keep PRs focused — one feature or fix per PR
- Include screenshots for UI changes
- Fill out the PR template checklist
- Worker deployment: use `npm run deploy:worker` only (never `wrangler deploy` directly)

## Reporting Issues

- Use the Bug Report or Feature Request templates
- Include browser, device, and steps to reproduce
- Screenshots are helpful

## Project Structure

```
src/           # React frontend (pages, components, hooks, utils, locales)
api/           # Vercel Edge Functions — "Is X Down?" SSR pages, landing page, Monthly Reports proxy
public/        # Static assets (manifest.json, sw.js, icons)
scripts/       # Build/asset scripts (OG image generator)
worker/        # Cloudflare Workers backend (parsers, types, utils, vitals)
tests/         # Playwright E2E tests
docs/          # Design mockups
```

## Questions?

Open an issue or contact [contact@ai-watch.dev](mailto:contact@ai-watch.dev).
