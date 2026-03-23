// EmptyState — shown when a section has no content to display
// type: 'good' (no issues), 'neutral' (no filter results), 'error' (API/load failure), 'offline' (network unavailable)

import { useLang } from '../hooks/useLang'

// Each type may define descKey (subtitle) and/or actionKey (button label, rendered only
// when onAction prop is also provided). good has descKey but no actionKey — no user action needed.
const CONFIG = {
  good: {
    icon:      '✓',
    iconClass: 'text-[var(--green)]',
    titleKey:  'empty.issues.title',
    descKey:   'empty.issues.desc',
  },
  neutral: {
    icon:      'ℹ',
    iconClass: 'text-[var(--text2)]',
    titleKey:  'empty.filter.title',
    actionKey: 'empty.filter.action',
  },
  error: {
    icon:      '!',
    iconClass: 'text-[var(--red)]',
    titleKey:  'empty.error.title',
    actionKey: 'empty.error.action',
  },
  offline: {
    icon:      '⚡',
    iconClass: 'text-[var(--green)]',
    titleKey:  'empty.offline.title',
    descKey:   'empty.offline.desc',
    actionKey: 'empty.offline.action',
  },
}

// onAction: callback for the action button (reset filters / retry)
export default function EmptyState({ type = 'neutral', onAction }) {
  const { t } = useLang()
  const cfg = CONFIG[type] ?? CONFIG.neutral

  return (
    <div className="flex flex-col items-center justify-center py-16 gap-3 text-center">
      <span className={`text-4xl mono ${cfg.iconClass}`} aria-hidden="true">
        {cfg.icon}
      </span>
      <p className="text-sm text-[var(--text1)]">{t(cfg.titleKey)}</p>
      {cfg.descKey && (
        <p className="text-xs text-[var(--text2)]">{t(cfg.descKey)}</p>
      )}
      {cfg.actionKey && onAction && (
        <button
          onClick={onAction}
          className="mt-2 px-5 py-2 text-xs mono rounded
                     border border-[var(--border-hi)] text-[var(--text1)]
                     hover:text-[var(--text0)] hover:border-[var(--text2)]
                     transition-colors"
        >
          {t(cfg.actionKey)}
        </button>
      )}
    </div>
  )
}
