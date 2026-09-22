import { useState } from 'react'
import { Link, NavLink, useNavigate } from 'react-router-dom'
import { useAuth } from '../lib/auth'
import { initials } from '../lib/format'

const linkBase = 'rounded-lg px-3 py-2 text-sm font-medium transition-colors'

function navClass({ isActive }: { isActive: boolean }): string {
  return `${linkBase} ${isActive ? 'bg-ink-100 text-ink-900' : 'text-ink-600 hover:bg-ink-100 hover:text-ink-900'}`
}

export default function Layout({ children }: { children: React.ReactNode }) {
  const { user, salon, isStaff, signOut } = useAuth()
  const navigate = useNavigate()
  const [menuOpen, setMenuOpen] = useState(false)

  async function handleSignOut() {
    await signOut()
    setMenuOpen(false)
    navigate('/')
  }

  const clientLinks = [
    { to: '/book', label: 'Book' },
    { to: '/appointments', label: 'My visits' },
    { to: '/account', label: 'Account' },
  ]
  const staffLinks = [
    { to: '/admin', label: 'Today' },
    { to: '/admin/calendar', label: 'Calendar' },
    { to: '/admin/clients', label: 'Clients' },
    { to: '/admin/texts', label: 'Texts' },
    { to: '/admin/settings', label: 'Settings' },
  ]
  const links = isStaff ? staffLinks : clientLinks

  return (
    <div className="flex min-h-screen flex-col">
      <header className="sticky top-0 z-20 border-b border-ink-200/70 bg-ink-50/90 backdrop-blur">
        <div className="mx-auto flex max-w-5xl items-center gap-3 px-4 py-3">
          <Link to={isStaff ? '/admin' : '/'} className="font-display text-lg tracking-tight text-ink-900">
            {salon?.name ?? 'Studio A'}
          </Link>

          {user && (
            <nav className="ml-auto hidden items-center gap-1 sm:flex">
              {links.map((l) => (
                <NavLink key={l.to} to={l.to} end={l.to === '/admin'} className={navClass}>
                  {l.label}
                </NavLink>
              ))}
            </nav>
          )}

          <div className={`flex items-center gap-2 ${user ? 'ml-2' : 'ml-auto'}`}>
            {user ? (
              <>
                <span
                  aria-hidden
                  className="hidden h-8 w-8 items-center justify-center rounded-full bg-ink-900 text-xs font-semibold text-ink-50 sm:flex"
                >
                  {initials(user.first_name, user.last_name)}
                </span>
                <button onClick={handleSignOut} className={`${linkBase} hidden text-ink-600 hover:text-ink-900 sm:block`}>
                  Sign out
                </button>
                <button
                  onClick={() => setMenuOpen((v) => !v)}
                  aria-expanded={menuOpen}
                  aria-label="Menu"
                  className={`${linkBase} sm:hidden`}
                >
                  {menuOpen ? 'Close' : 'Menu'}
                </button>
              </>
            ) : (
              <>
                <NavLink to="/login" className={navClass}>Sign in</NavLink>
                <NavLink
                  to="/register"
                  className={`${linkBase} bg-ink-900 text-ink-50 hover:bg-ink-800`}
                >
                  Create account
                </NavLink>
              </>
            )}
          </div>
        </div>

        {user && menuOpen && (
          <nav className="border-t border-ink-200/70 px-4 py-2 sm:hidden">
            {links.map((l) => (
              <NavLink
                key={l.to}
                to={l.to}
                end={l.to === '/admin'}
                onClick={() => setMenuOpen(false)}
                className={({ isActive }) => `block ${navClass({ isActive })}`}
              >
                {l.label}
              </NavLink>
            ))}
            <button onClick={handleSignOut} className={`block w-full text-left ${linkBase} text-ink-600`}>
              Sign out
            </button>
          </nav>
        )}
      </header>

      <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-8">{children}</main>

      <footer className="border-t border-ink-200/70 px-4 py-6 text-center text-xs text-ink-400">
        {salon?.name ?? 'Studio A'}
        {salon?.phone ? ` · ${salon.phone}` : ''}
        {salon?.address ? ` · ${salon.address}` : ''}
      </footer>
    </div>
  )
}
