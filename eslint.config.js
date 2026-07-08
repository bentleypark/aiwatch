import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'

export default [
  // ESLint v9 flat config does NOT auto-read .gitignore, so build output + nested git
  // worktrees (Claude Code `--worktree`, gitignored under .claude/worktrees/) must be
  // listed here explicitly — else `eslint .` recurses into stale worktree copies and
  // regenerated coverage, surfacing phantom errors that aren't in the tracked tree (#932).
  { ignores: ['dist', '**/dist/**', '**/coverage/**', '.claude/worktrees/**'] },
  {
    files: ['**/*.{js,jsx}'],
    languageOptions: {
      ecmaVersion: 2020,
      globals: { ...globals.browser, __APP_VERSION__: 'readonly' },
      parserOptions: {
        ecmaVersion: 'latest',
        ecmaFeatures: { jsx: true },
        sourceType: 'module',
      },
    },
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    rules: {
      // #932 — full react-hooks v7 rule set (the React-Compiler lint suite: purity,
      // set-state-in-effect, error-boundaries, immutability, refs, …). The plugin's
      // `recommended-latest` preset ships `plugins` as an array, which ESLint 10 flat config
      // rejects, so the rule map is applied here against our own object-form plugin registration.
      ...reactHooks.configs['recommended-latest'].rules,
      // #932 — keep these two at `warn`, not the preset's `error`. In this polling dashboard they
      // flag intentional, correct patterns: `purity` fires on deliberate render-time `Date.now()`
      // (re-render == 60s poll refresh, so a fresh read each render is desired), and
      // `set-state-in-effect` fires on legitimate external-sync effects (network polling, archive
      // fetch, store→form sync) plus benign reset-on-navigation. Enforcing `error` would require
      // ~13 justified `eslint-disable`s on correct code; `warn` keeps them visible as guidance for
      // NEW code without that noise. The other 15 rules stay at their preset severity (error).
      'react-hooks/purity': 'warn',
      'react-hooks/set-state-in-effect': 'warn',
      'react-refresh/only-export-components': [
        'warn',
        { allowConstantExport: true },
      ],
    },
  },
]
