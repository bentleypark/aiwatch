# Contributing to AIWatch

Thank you for your interest in contributing to AIWatch!

## Getting Started

1. Fork the repository
2. Clone your fork: `git clone https://github.com/YOUR_USERNAME/aiwatch.git`
3. Install dependencies: `npm install`
4. Start dev server: `npm run dev`

## Development Workflow

Follow the steps in [CLAUDE.md](../CLAUDE.md) — especially:

1. **Build + Test** before committing
2. **Code review** before committing
3. **Fix all Critical/Important** review findings
4. Include `closes #N` in commit messages

## Code Style

- **CSS**: Use design tokens (`var(--green)`, not `#3fb950`). See `src/index.css`
- **i18n**: Add keys to both `src/locales/ko.js` and `en.js`
- **Components**: Prefer inline styles for values Tailwind v4 doesn't generate reliably (padding on buttons, etc.)
- **Worker**: TypeScript, error logging with `console.error/warn`

## Pull Request Guidelines

- Keep PRs focused — one feature or fix per PR
- Include screenshots for UI changes
- Fill out the PR template checklist
- Tests must pass: `npm test` (13 Playwright specs)

## Reporting Issues

- Use the Bug Report or Feature Request templates
- Include browser, device, and steps to reproduce
- Screenshots are helpful

## Project Structure

```
src/           # React frontend
worker/        # Cloudflare Workers backend
tests/         # Playwright E2E tests
docs/          # Design mockups
```

## Questions?

Open an issue or contact [contact@ai-watch.dev](mailto:contact@ai-watch.dev).
