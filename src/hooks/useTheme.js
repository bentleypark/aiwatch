import { useState, useEffect } from 'react'

const STORAGE_KEY = 'aiwatch-theme'

function applyTheme(theme) {
  const root = document.documentElement
  if (theme === 'system') {
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches
    root.removeAttribute('data-theme')
    if (!prefersDark) root.setAttribute('data-theme', 'light')
  } else {
    theme === 'light'
      ? root.setAttribute('data-theme', 'light')
      : root.removeAttribute('data-theme')
  }
}

export function useTheme() {
  const [theme, setTheme] = useState(() => localStorage.getItem(STORAGE_KEY) ?? 'system')

  useEffect(() => {
    applyTheme(theme)
  }, [theme])

  useEffect(() => {
    if (theme !== 'system') return
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const handler = () => applyTheme('system')
    mq.addEventListener('change', handler)
    return () => mq.removeEventListener('change', handler)
  }, [theme])

  function setAndPersist(next) {
    localStorage.setItem(STORAGE_KEY, next)
    setTheme(next)
  }

  return { theme, setTheme: setAndPersist }
}
