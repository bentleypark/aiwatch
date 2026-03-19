import { useTheme } from './hooks/useTheme'
import { useLang } from './hooks/useLang'
import { VALID_THEMES, VALID_LANGS } from './utils/constants'

function App() {
  const { theme, setTheme } = useTheme()
  const { lang, setLang, t } = useLang()

  return (
    <div className="p-8 text-[var(--text0)]">
      <h1 className="mono text-[var(--green)]">AIWatch</h1>
      <p className="mt-2 text-[var(--text1)]" data-i18n="app.tagline">{t('app.tagline')}</p>
      <div className="mt-4 flex gap-2">
        {VALID_THEMES.map((th) => (
          <button
            key={th}
            onClick={() => setTheme(th)}
            className={`px-3 py-1 rounded text-xs mono border ${
              theme === th
                ? 'bg-[--bg3] text-[--text0] border-[--border-hi]'
                : 'bg-[--bg2] text-[--text2] border-[--border]'
            }`}
          >
            {th}
          </button>
        ))}
      </div>
      <div className="mt-2 flex gap-2">
        {VALID_LANGS.map((l) => (
          <button
            key={l}
            onClick={() => setLang(l)}
            className={`px-3 py-1 rounded text-xs mono border ${
              lang === l
                ? 'bg-[--bg3] text-[--text0] border-[--border-hi]'
                : 'bg-[--bg2] text-[--text2] border-[--border]'
            }`}
          >
            {l}
          </button>
        ))}
      </div>
    </div>
  )
}

export default App
