import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { api, type Salon, type User } from './api'
import { setTimeZone } from './format'

interface AuthValue {
  user: User | null
  salon: Salon | null
  stripeKey: string | null
  loading: boolean
  isStaff: boolean
  refresh: () => Promise<void>
  signIn: (email: string, password: string) => Promise<void>
  signOut: () => Promise<void>
  setUser: (user: User | null) => void
}

const AuthContext = createContext<AuthValue | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null)
  const [salon, setSalon] = useState<Salon | null>(null)
  const [stripeKey, setStripeKey] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  const refresh = useCallback(async () => {
    const [me, config] = await Promise.all([
      api.get<{ user: User | null }>('/auth/me').catch(() => ({ user: null })),
      api.get<{ salon: Salon; stripe_publishable_key: string | null }>('/salon').catch(() => null),
    ])
    setUser(me.user)
    if (config) {
      setSalon(config.salon)
      setStripeKey(config.stripe_publishable_key)
      // Pin every date the UI renders to the salon's timezone.
      setTimeZone(config.salon.timezone)
    }
  }, [])

  useEffect(() => {
    void refresh().finally(() => setLoading(false))
  }, [refresh])

  const signIn = useCallback(async (email: string, password: string) => {
    const res = await api.post<{ user: User }>('/auth/login', { email, password })
    setUser(res.user)
  }, [])

  const signOut = useCallback(async () => {
    await api.post('/auth/logout')
    setUser(null)
  }, [])

  const value = useMemo<AuthValue>(
    () => ({
      user, salon, stripeKey, loading,
      isStaff: user?.role === 'staff' || user?.role === 'admin',
      refresh, signIn, signOut, setUser,
    }),
    [user, salon, stripeKey, loading, refresh, signIn, signOut],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth(): AuthValue {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>')
  return ctx
}
