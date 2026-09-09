// In-memory localStorage stub for tests. happy-dom doesn't expose a usable Storage API under
// vitest 4's environment integration, so tests that touch localStorage install this via
// `vi.stubGlobal('localStorage', makeLocalStorage())`. Same shape as the browser API.
// (Not a `*.test.js`, so vitest's `src/**/*.test.js` include does not collect it as a suite.)
export function makeLocalStorage() {
  const store = new Map()
  return {
    getItem(k) { return store.has(String(k)) ? store.get(String(k)) : null },
    setItem(k, v) { store.set(String(k), String(v)) },
    removeItem(k) { store.delete(String(k)) },
    clear() { store.clear() },
    get length() { return store.size },
    key(i) { return Array.from(store.keys())[i] ?? null },
  }
}

/** A localStorage whose every access throws — Safari private mode / storage disabled. */
export function makeThrowingLocalStorage() {
  const boom = () => { throw new Error('storage denied') }
  return { getItem: boom, setItem: boom, removeItem: boom, clear: boom, length: 0, key: boom }
}
