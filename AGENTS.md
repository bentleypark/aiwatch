# AGENTS.md

This repository supports multiple coding agents. Keep this file short and use it as the neutral,
agent-agnostic entrypoint.

If you are using Claude Code, also read [CLAUDE.md](./CLAUDE.md) for Claude-specific workflow and
project automation details.

## Project Overview

- AIWatch is a React + Vite frontend with Vercel Edge Functions and a Cloudflare Worker backend.
- The repo is TypeScript/JavaScript, with tests in Vitest and Playwright.
- The worker code lives under `worker/`; the main frontend lives under `src/`.

## Setup

- Install root dependencies with `npm install`.
- Install worker dependencies with `cd worker && npm install`.
- Use Node.js 20+.

## Common Commands

- `npm run dev` for the frontend dev server.
- `npm run dev:worker` for the worker dev server.
- `npm run dev:all` to run both locally.
- `npm run build` for the production frontend build.
- `npm run lint` for ESLint.
- `npm run test:src` for frontend unit tests.
- `npm run test:worker` for worker unit tests.
- `npm test` for Playwright end-to-end tests.

## Working Rules

- Keep changes small and focused.
- Prefer existing project patterns over new abstractions.
- Update tests when behavior changes.
- Do not introduce unrelated refactors.
- For UI changes, verify both desktop and mobile behavior.
- For worker or external API changes, check the relevant runtime and test coverage.

## Code Style

- Follow the existing file conventions in the touched area.
- Keep markdown concise and factual.
- Use the project’s existing design tokens and utilities instead of ad hoc styling.
- Add comments only when the code would otherwise be hard to follow.

## Environment Notes

- Frontend environment variables live in `.env.example`.
- Worker local variables live in `worker/.dev.vars.example`.
- Do not commit secrets or local machine configuration.

## If You Need More Detail

- Read `README.md` for setup and commands.
- Read `CONTRIBUTING.md` for contribution workflow.
- Read the relevant `docs/reference/*` file for subsystem-specific rules.
