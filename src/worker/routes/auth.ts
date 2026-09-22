import { Hono } from 'hono'
import { z } from 'zod'
import type { AppContext } from '../types'
import { newId } from '../lib/ids'
import { hashPassword, verifyPassword } from '../lib/crypto'
import { createSession, destroyAllSessions, destroySession, requireAuth } from '../lib/auth'
import { badRequest, conflict, unauthorized } from '../lib/http'
import { normalizePhone } from '../lib/phone'
import { nowSec } from '../lib/time'

const auth = new Hono<AppContext>()

const passwordSchema = z.string().min(8, 'Use at least 8 characters.').max(200)

const registerSchema = z.object({
  email: z.string().trim().email('Enter a valid email address.').max(254),
  password: passwordSchema,
  first_name: z.string().trim().min(1, 'First name is required.').max(80),
  last_name: z.string().trim().max(80).default(''),
  phone: z.string().trim().max(32).optional(),
  sms_opt_in: z.boolean().default(true),
})

auth.post('/register', async (c) => {
  const parsed = registerSchema.safeParse(await c.req.json().catch(() => ({})))
  if (!parsed.success) badRequest(firstIssue(parsed.error), 'invalid_input')
  const input = parsed.data

  const phone = normalizePhone(input.phone)
  if (input.phone && !phone) badRequest('That phone number does not look right.', 'invalid_phone')
  // Texting is the whole point of the reminder system; without a number an
  // opt-in would be a lie.
  const optIn = phone ? input.sms_opt_in : false

  const email = input.email.toLowerCase()
  const existing = await c.env.DB.prepare('SELECT id FROM users WHERE email_normalized = ?').bind(email).first()
  if (existing) conflict('An account already exists for that email. Try signing in.', 'email_taken')

  const id = newId('usr')
  const now = nowSec()
  await c.env.DB.prepare(
    `INSERT INTO users (id, email, email_normalized, phone, first_name, last_name,
                        password_hash, role, sms_opt_in, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'client', ?, ?, ?)`,
  ).bind(
    id, input.email.trim(), email, phone, input.first_name, input.last_name,
    await hashPassword(input.password), optIn ? 1 : 0, now, now,
  ).run()

  await createSession(c, id)
  return c.json({ user: await publicUser(c, id) }, 201)
})

const loginSchema = z.object({
  email: z.string().trim().email().max(254),
  password: z.string().min(1).max(200),
})

auth.post('/login', async (c) => {
  const parsed = loginSchema.safeParse(await c.req.json().catch(() => ({})))
  if (!parsed.success) badRequest('Enter your email and password.', 'invalid_input')

  const row = await c.env.DB.prepare(
    'SELECT id, password_hash FROM users WHERE email_normalized = ?',
  ).bind(parsed.data.email.toLowerCase()).first<{ id: string; password_hash: string }>()

  // Same message either way, so the form cannot be used to enumerate clients.
  const ok = row ? await verifyPassword(parsed.data.password, row.password_hash) : false
  if (!row || !ok) unauthorized('Email or password is incorrect.')

  await createSession(c, row.id)
  return c.json({ user: await publicUser(c, row.id) })
})

auth.post('/logout', async (c) => {
  await destroySession(c)
  return c.json({ ok: true })
})

auth.get('/me', async (c) => {
  const user = c.var.user
  if (!user) return c.json({ user: null })
  return c.json({ user: await publicUser(c, user.id) })
})

const profileSchema = z.object({
  first_name: z.string().trim().min(1).max(80).optional(),
  last_name: z.string().trim().max(80).optional(),
  phone: z.string().trim().max(32).nullable().optional(),
  sms_opt_in: z.boolean().optional(),
})

auth.patch('/me', requireAuth, async (c) => {
  const user = c.var.user!
  const parsed = profileSchema.safeParse(await c.req.json().catch(() => ({})))
  if (!parsed.success) badRequest(firstIssue(parsed.error), 'invalid_input')
  const input = parsed.data

  const sets: string[] = []
  const binds: unknown[] = []

  if (input.first_name !== undefined) { sets.push('first_name = ?'); binds.push(input.first_name) }
  if (input.last_name !== undefined) { sets.push('last_name = ?'); binds.push(input.last_name) }

  let phone = user.phone
  if (input.phone !== undefined) {
    phone = input.phone ? normalizePhone(input.phone) : null
    if (input.phone && !phone) badRequest('That phone number does not look right.', 'invalid_phone')
    sets.push('phone = ?'); binds.push(phone)
  }

  if (input.sms_opt_in !== undefined) {
    const optIn = input.sms_opt_in && Boolean(phone)
    sets.push('sms_opt_in = ?'); binds.push(optIn ? 1 : 0)
    // Re-opting in clears the STOP timestamp so the client drops out of the
    // suppression list.
    sets.push('sms_opt_out_at = ?'); binds.push(optIn ? null : nowSec())
  }

  if (sets.length === 0) return c.json({ user: await publicUser(c, user.id) })

  sets.push('updated_at = ?'); binds.push(nowSec())
  binds.push(user.id)
  await c.env.DB.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).bind(...binds).run()

  return c.json({ user: await publicUser(c, user.id) })
})

const passwordChangeSchema = z.object({
  current_password: z.string().min(1).max(200),
  new_password: passwordSchema,
})

auth.post('/password', requireAuth, async (c) => {
  const user = c.var.user!
  const parsed = passwordChangeSchema.safeParse(await c.req.json().catch(() => ({})))
  if (!parsed.success) badRequest(firstIssue(parsed.error), 'invalid_input')

  const row = await c.env.DB.prepare('SELECT password_hash FROM users WHERE id = ?')
    .bind(user.id).first<{ password_hash: string }>()
  if (!row || !(await verifyPassword(parsed.data.current_password, row.password_hash))) {
    unauthorized('Your current password is incorrect.')
  }

  await c.env.DB.prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?')
    .bind(await hashPassword(parsed.data.new_password), nowSec(), user.id).run()

  // Drop every other session, then hand this device a fresh one.
  await destroyAllSessions(c.env, user.id)
  await createSession(c, user.id)
  return c.json({ ok: true })
})

async function publicUser(c: { env: AppContext['Bindings'] }, id: string) {
  return c.env.DB.prepare(
    `SELECT id, email, phone, first_name, last_name, role, sms_opt_in, created_at
       FROM users WHERE id = ?`,
  ).bind(id).first()
}

export function firstIssue(error: z.ZodError): string {
  return error.issues[0]?.message ?? 'That input is not valid.'
}

export default auth
