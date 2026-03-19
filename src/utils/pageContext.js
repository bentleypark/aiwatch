import { createContext, useContext } from 'react'

// currentPage shape: { name: string, serviceId?: string }
// name: 'overview' | 'latency' | 'incidents' | 'uptime' | 'service' | 'settings'
export const PageContext = createContext(null)

export function usePage() {
  const ctx = useContext(PageContext)
  if (!ctx) throw new Error('usePage must be used inside App (PageContext.Provider)')
  return ctx
}
