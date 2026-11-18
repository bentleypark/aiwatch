import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createElement, act } from 'react'
import { createRoot } from 'react-dom/client'
import { makeLocalStorage } from '../../utils/__tests__/localStorageStub'
import CookieBanner from '../CookieBanner'

vi.mock('../../hooks/useLang', () => ({ useLang: () => ({ t: (k) => k }) }))

globalThis.IS_REACT_ACT_ENVIRONMENT = true
let root
let host

beforeEach(() => {
  vi.stubGlobal('localStorage', makeLocalStorage())
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.unstubAllGlobals()
})

describe('CookieBanner privacy link (#2024)', () => {
  it('opens the Privacy Policy in place instead of navigating', () => {
    const onOpenPrivacy = vi.fn()
    act(() => root.render(createElement(CookieBanner, { onOpenPrivacy })))
    const link = document.querySelector('a[href="#privacy"]')
    expect(link).not.toBeNull()
    const ev = new MouseEvent('click', { bubbles: true, cancelable: true })
    act(() => { link.dispatchEvent(ev) })
    expect(ev.defaultPrevented).toBe(true)
    expect(onOpenPrivacy).toHaveBeenCalledTimes(1)
  })
})
