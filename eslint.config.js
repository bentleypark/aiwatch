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
      // #932 — pin the two classic hook rules explicitly. In react-hooks v7 the
      // `recommended` preset expanded to ~17 rules (the React-Compiler set: static-components,
      // immutability, purity, set-state-in-render, …); adopting those is an app-wide triage
      // deferred to its own task, so this tooling bump keeps the pre-upgrade rule surface.
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      'react-refresh/only-export-components': [
        'warn',
        { allowConstantExport: true },
      ],
    },
  },
]
