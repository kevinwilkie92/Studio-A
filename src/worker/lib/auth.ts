import type { Context, MiddlewareHandler } from 'hono'
import { getCookie, setCookie, deleteCookie } from 'hono/cookie'
import type { AppContext, Env, Role, SessionUser } from '../types'
import { newId } from './ids'
import { randomToken, sha256Hex } from './crypto'
import { nowSec } from './time'
import { forbidden, unauthorized } from './http'

export const SESSION_COOKIE = 'sa_session'
const SESSION_TTL_SEC = 60 * 60 * 24 * 30        // 30 days
const SESSION_REFRESH_AFTER = 60 * 60 * 24 * 7   // slide the expiry once a week

/** Issues a session and sets the cookie. Returns the opaque token. */
export async function createSession(c: Context<AppContext>, userId: string): Promise<string> {
  const token = randomToken(32)
  const id = await sha256Hex(token)
  const now = nowSec()

  await c.env.DB.prepare(
    'INSERT INTO sessions (id, user_id, created_at, expires_at, user_agent) VALUES (?, ?, ?, ?, ?)',
  ).bind(id, userId, now, now + SESSION_TTL_SEC, c.req.header('user-agent')?.slice(0, 255) ?? null).run()

  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    secure: new URL(c.req.url).protocol === 'https:',
    sameSite: 'Lax',
    path: '/',
    maxAge: SESSION_TTL_SEC,
  })
  return token
}

export async function destroySession(c: Context<AppContext>): Promise<void> {
  const token = getCookie(c, SESSION_COOKIE)
  if (token) {
    await c.env.DB.prepare('DELETE FROM sessions WHERE id = ?').bind(await sha256Hex(token)).run()
  }
  deleteCookie(c, SESSION_COOKIE, { path: '/' })
}

/** Ends every session for a user — used after a password change. */
export async function destroyAllSessions(env: Env, userId: string): Promise<void> {
  await env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(userId).run()
}

/**
 * Resolves the session cookie onto `c.var.user`. Never rejects: routes decide
 * what they require via `requireAuth` / `requireStaff`.
 */
export const loadUser: MiddlewareHandler<AppContext> = async (c, next) => {
  c.set('user', null)
  c.set('sessionId', null)

  const token = getCookie(c, SESSION_COOKIE)
  if (!token) return next()

  const id = await sha256Hex(token)
  const row = await c.env.DB.prepare(
    `SELECT s.id AS session_id, s.expires_at,
            u.id, u.email, u.phone, u.first_name, u.last_name, u.role, u.sms_opt_in
       FROM sessions s
       JOIN users u ON u.id = s.user_id
      WHERE s.id = ?`,
  ).bind(id).first<SessionUser & { session_id: string; expires_at: number }>()

  if (!row) return next()

  const now = nowSec()
  if (row.expires_at <= now) {
    await c.env.DB.prepare('DELETE FROM sessions WHERE id = ?').bind(id).run()
    deleteCookie(c, SESSION_COOKIE, { path: '/' })
    return next()
  }

  // Slide the window so active clients are not logged out mid-booking.
  if (row.expires_at - now < SESSION_TTL_SEC - SESSION_REFRESH_AFTER) {
    await c.env.DB.prepare('UPDATE sessions SET expires_at = ? WHERE id = ?')
      .bind(now + SESSION_TTL_SEC, id).run()
    setCookie(c, SESSION_COOKIE, token, {
      httpOnly: true,
      secure: new URL(c.req.url).protocol === 'https:',
      sameSite: 'Lax',
      path: '/',
      maxAge: SESSION_TTL_SEC,
    })
  }

  c.set('user', {
    id: row.id,
    email: row.email,
    phone: row.phone,
    first_name: row.first_name,
    last_name: row.last_name,
    role: row.role,
    sms_opt_in: row.sms_opt_in,
  })
  c.set('sessionId', row.session_id)
  return next()
}

export const requireAuth: MiddlewareHandler<AppContext> = async (c, next) => {
  if (!c.var.user) unauthorized()
  return next()
}

export function requireRole(...roles: Role[]): MiddlewareHandler<AppContext> {
  return async (c, next) => {
    const user = c.var.user
    if (!user) unauthorized()
    if (!roles.includes(user.role)) forbidden()
    return next()
  }
}

/** Staff and admins share the back office; only admins manage settings/staff. */
export const requireStaff = requireRole('staff', 'admin')
export const requireAdmin = requireRole('admin')

export { newId }
