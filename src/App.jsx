import { useTheme } from './hooks/useTheme'
import { VALID_THEMES } from './utils/constants'

function App() {
  const { theme, setTheme } = useTheme()

  return (
    <div className="p-8 text-[var(--text0)]">
      <h1 className="mono text-[var(--green)]">AIWatch</h1>
      <p className="mt-2 text-[var(--text1)]" data-i18n="app.tagline">
        AI API 서비스 실시간 모니터링 대시보드
      </p>
      <div className="mt-4 flex gap-2">
        {VALID_THEMES.map((t) => (
          <button
            key={t}
            onClick={() => setTheme(t)}
            className={`px-3 py-1 rounded text-xs mono border ${
              theme === t
                ? 'bg-[--bg3] text-[--text0] border-[--border-hi]'
                : 'bg-[--bg2] text-[--text2] border-[--border]'
            }`}
          >
            {t}
          </button>
        ))}
      </div>
    </div>
  )
}

export default App
