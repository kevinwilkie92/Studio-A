import { Hono } from 'hono'
import { z } from 'zod'
import type { AppContext } from '../types'
import { newId } from '../lib/ids'
import { hashPassword } from '../lib/crypto'
import { createSession, requireAdmin, requireStaff } from '../lib/auth'
import { badRequest, conflict, forbidden, notFound } from '../lib/http'
import { EDITABLE_SETTINGS, getSettings, invalidateSettingsCache, serializeSetting } from '../lib/settings'
import { dayBounds, dateKey, nowSec } from '../lib/time'
import { normalizePhone } from '../lib/phone'
import { withServices } from './booking'
import { firstIssue } from './auth'

const admin = new Hono<AppContext>()

// -------------------------------------------------------------- bootstrap --

/**
 * Creates the very first admin. Requires ADMIN_SETUP_TOKEN and refuses once
 * any admin exists, so the endpoint closes itself after first use.
 */
admin.post('/bootstrap', async (c) => {
  const token = c.env.ADMIN_SETUP_TOKEN
  if (!token) forbidden('Admin setup is disabled. Set the ADMIN_SETUP_TOKEN secret first.')

  const body = await c.req.json().catch(() => ({})) as Record<string, unknown>
  if (typeof body.setup_token !== 'string' || body.setup_token !== token) forbidden('Setup token is incorrect.')

  const existing = await c.env.DB.prepare("SELECT id FROM users WHERE role = 'admin' LIMIT 1").first()
  if (existing) conflict('An admin already exists. Sign in instead.', 'admin_exists')

  const schema = z.object({
    email: z.string().trim().email().max(254),
    password: z.string().min(10, 'Use at least 10 characters for the owner account.').max(200),
    first_name: z.string().trim().min(1).max(80),
    last_name: z.string().trim().max(80).default(''),
    phone: z.string().trim().max(32).optional(),
  })
  const parsed = schema.safeParse(body)
  if (!parsed.success) badRequest(firstIssue(parsed.error), 'invalid_input')

  const id = newId('usr')
  const now = nowSec()
  await c.env.DB.prepare(
    `INSERT INTO users (id, email, email_normalized, phone, first_name, last_name,
                        password_hash, role, sms_opt_in, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'admin', 0, ?, ?)`,
  ).bind(
    id, parsed.data.email.trim(), parsed.data.email.toLowerCase(), normalizePhone(parsed.data.phone),
    parsed.data.first_name, parsed.data.last_name, await hashPassword(parsed.data.password), now, now,
  ).run()

  await createSession(c, id)
  return c.json({ ok: true, user_id: id }, 201)
})

// Everything below is staff-only.
admin.use('/*', async (c, next) => {
  if (c.req.path.endsWith('/bootstrap')) return next()
  return requireStaff(c, next)
})

// -------------------------------------------------------------- dashboard --

admin.get('/dashboard', async (c) => {
  const settings = await getSettings(c.env)
  const today = dateKey(nowSec(), settings.timezone)
  const bounds = dayBounds(today, settings.timezone)!
  const weekAhead = bounds.start + 7 * 86400

  const [todayAppts, stats, unpaid] = await Promise.all([
    c.env.DB.prepare(
      `SELECT a.id, a.starts_at, a.ends_at, a.status, a.total_cents, a.paid_cents, a.client_request,
              a.client_id, s.display_name AS staff_name,
              u.first_name AS client_first_name, u.last_name AS client_last_name, u.phone AS client_phone
         FROM appointments a
         LEFT JOIN staff s ON s.id = a.staff_id
         JOIN users u ON u.id = a.client_id
        WHERE a.starts_at >= ? AND a.starts_at < ? AND a.status != 'cancelled'
        ORDER BY a.starts_at`,
    ).bind(bounds.start, bounds.end).all(),

    c.env.DB.prepare(
      `SELECT
         (SELECT COUNT(*) FROM users WHERE role = 'client') AS clients,
         (SELECT COUNT(*) FROM users WHERE role = 'client' AND sms_opt_in = 1 AND phone IS NOT NULL) AS textable,
         (SELECT COUNT(*) FROM appointments
           WHERE starts_at >= ? AND starts_at < ? AND status IN ('booked','confirmed')) AS upcoming_week,
         (SELECT COALESCE(SUM(amount_cents + tip_cents), 0) FROM payments
           WHERE status = 'succeeded' AND created_at >= ?) AS revenue_30d`,
    ).bind(bounds.start, weekAhead, nowSec() - 30 * 86400).first(),

    c.env.DB.prepare(
      `SELECT a.id, a.starts_at, a.total_cents, a.paid_cents,
              u.first_name AS client_first_name, u.last_name AS client_last_name
         FROM appointments a JOIN users u ON u.id = a.client_id
        WHERE a.status IN ('completed', 'booked', 'confirmed')
          AND a.total_cents > a.paid_cents
          AND a.starts_at < ?
        ORDER BY a.starts_at DESC LIMIT 20`,
    ).bind(nowSec()).all(),
  ])

  return c.json({
    date: today,
    timezone: settings.timezone,
    today: await withServices(c.env, todayAppts.results ?? []),
    stats: stats ?? {},
    unpaid: unpaid.results ?? [],
  })
})

// ---------------------------------------------------------------- clients --

admin.get('/clients', async (c) => {
  const q = (c.req.query('q') ?? '').trim()
  const limit = Math.min(100, Math.max(1, Number(c.req.query('limit') ?? 50)))
  const like = `%${q.toLowerCase()}%`

  const { results } = await c.env.DB.prepare(
    `SELECT u.id, u.first_name, u.last_name, u.email, u.phone, u.sms_opt_in, u.created_at, u.role,
            (SELECT COUNT(*) FROM appointments a
              WHERE a.client_id = u.id AND a.status = 'completed') AS visits,
            (SELECT MAX(a.starts_at) FROM appointments a
              WHERE a.client_id = u.id AND a.status = 'completed') AS last_visit,
            (SELECT MIN(a.starts_at) FROM appointments a
              WHERE a.client_id = u.id AND a.starts_at >= ?
                AND a.status IN ('booked','confirmed')) AS next_visit,
            (SELECT COUNT(*) FROM client_notes n WHERE n.client_id = u.id) AS note_count
       FROM users u
      WHERE u.role = 'client'
        AND (? = '' OR LOWER(u.first_name) LIKE ? OR LOWER(u.last_name) LIKE ?
             OR LOWER(u.email) LIKE ? OR u.phone LIKE ?)
      ORDER BY u.first_name, u.last_name
      LIMIT ?`,
  ).bind(nowSec(), q, like, like, like, like, limit).all()

  return c.json({ clients: results ?? [] })
})

admin.get('/clients/:id', async (c) => {
  const id = c.req.param('id')
  const client = await c.env.DB.prepare(
    `SELECT id, first_name, last_name, email, phone, sms_opt_in, sms_opt_out_at, created_at, role
       FROM users WHERE id = ?`,
  ).bind(id).first()
  if (!client) notFound('No such client.')

  const [appts, notes, pays] = await Promise.all([
    c.env.DB.prepare(
      `SELECT a.id, a.starts_at, a.ends_at, a.status, a.total_cents, a.paid_cents, a.client_request,
              s.display_name AS staff_name
         FROM appointments a LEFT JOIN staff s ON s.id = a.staff_id
        WHERE a.client_id = ? ORDER BY a.starts_at DESC LIMIT 50`,
    ).bind(id).all(),
    c.env.DB.prepare(
      `SELECT n.id, n.body, n.category, n.pinned, n.created_at, n.updated_at, n.appointment_id,
              u.first_name AS author_first_name, u.last_name AS author_last_name
         FROM client_notes n LEFT JOIN users u ON u.id = n.author_id
        WHERE n.client_id = ?
        ORDER BY n.pinned DESC, n.created_at DESC LIMIT 200`,
    ).bind(id).all(),
    c.env.DB.prepare(
      `SELECT id, appointment_id, amount_cents, tip_cents, method, status, created_at
         FROM payments WHERE client_id = ? ORDER BY created_at DESC LIMIT 50`,
    ).bind(id).all(),
  ])

  return c.json({
    client,
    appointments: await withServices(c.env, appts.results ?? []),
    notes: notes.results ?? [],
    payments: pays.results ?? [],
  })
})

// ------------------------------------------------------------ client notes -

const noteSchema = z.object({
  body: z.string().trim().min(1, 'Write something first.').max(4000),
  category: z.enum(['general', 'formula', 'allergy', 'preference']).default('general'),
  pinned: z.boolean().default(false),
  appointment_id: z.string().min(1).nullable().optional(),
})

admin.post('/clients/:id/notes', async (c) => {
  const actor = c.var.user!
  const clientId = c.req.param('id')

  const parsed = noteSchema.safeParse(await c.req.json().catch(() => ({})))
  if (!parsed.success) badRequest(firstIssue(parsed.error), 'invalid_input')

  const client = await c.env.DB.prepare('SELECT id FROM users WHERE id = ?').bind(clientId).first()
  if (!client) notFound('No such client.')

  const id = newId('note')
  const now = nowSec()
  await c.env.DB.prepare(
    `INSERT INTO client_notes
       (id, client_id, author_id, appointment_id, category, body, pinned, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    id, clientId, actor.id, parsed.data.appointment_id ?? null, parsed.data.category,
    parsed.data.body, parsed.data.pinned ? 1 : 0, now, now,
  ).run()

  const note = await c.env.DB.prepare('SELECT * FROM client_notes WHERE id = ?').bind(id).first()
  return c.json({ note }, 201)
})

admin.patch('/notes/:noteId', async (c) => {
  const actor = c.var.user!
  const noteId = c.req.param('noteId')

  const parsed = noteSchema.partial().safeParse(await c.req.json().catch(() => ({})))
  if (!parsed.success) badRequest(firstIssue(parsed.error), 'invalid_input')

  const note = await c.env.DB.prepare('SELECT id, author_id FROM client_notes WHERE id = ?')
    .bind(noteId).first<{ id: string; author_id: string | null }>()
  if (!note) notFound('That note no longer exists.')
  // Stylists edit their own notes; an admin can tidy up anyone's.
  if (note.author_id !== actor.id && actor.role !== 'admin') forbidden('You can only edit your own notes.')

  const sets: string[] = []
  const binds: unknown[] = []
  if (parsed.data.body !== undefined) { sets.push('body = ?'); binds.push(parsed.data.body) }
  if (parsed.data.category !== undefined) { sets.push('category = ?'); binds.push(parsed.data.category) }
  if (parsed.data.pinned !== undefined) { sets.push('pinned = ?'); binds.push(parsed.data.pinned ? 1 : 0) }
  if (sets.length === 0) badRequest('Nothing to change.', 'no_changes')

  sets.push('updated_at = ?'); binds.push(nowSec())
  binds.push(noteId)
  await c.env.DB.prepare(`UPDATE client_notes SET ${sets.join(', ')} WHERE id = ?`).bind(...binds).run()

  const updated = await c.env.DB.prepare('SELECT * FROM client_notes WHERE id = ?').bind(noteId).first()
  return c.json({ note: updated })
})

admin.delete('/notes/:noteId', async (c) => {
  const actor = c.var.user!
  const note = await c.env.DB.prepare('SELECT id, author_id FROM client_notes WHERE id = ?')
    .bind(c.req.param('noteId')).first<{ id: string; author_id: string | null }>()
  if (!note) return c.json({ ok: true })
  if (note.author_id !== actor.id && actor.role !== 'admin') forbidden('You can only delete your own notes.')

  await c.env.DB.prepare('DELETE FROM client_notes WHERE id = ?').bind(note.id).run()
  return c.json({ ok: true })
})

// ----------------------------------------------------------- appointments --

admin.get('/appointments', async (c) => {
  const settings = await getSettings(c.env)
  const from = c.req.query('from')
  const to = c.req.query('to')
  const status = c.req.query('status')

  const start = from ? dayBounds(from, settings.timezone)?.start : undefined
  const end = to ? dayBounds(to, settings.timezone)?.end : undefined
  if ((from && start === undefined) || (to && end === undefined)) badRequest('Dates must be YYYY-MM-DD.', 'invalid_date')

  const { results } = await c.env.DB.prepare(
    `SELECT a.id, a.client_id, a.staff_id, a.starts_at, a.ends_at, a.status, a.client_request,
            a.total_cents, a.paid_cents, s.display_name AS staff_name,
            u.first_name AS client_first_name, u.last_name AS client_last_name, u.phone AS client_phone
       FROM appointments a
       LEFT JOIN staff s ON s.id = a.staff_id
       JOIN users u ON u.id = a.client_id
      WHERE (? IS NULL OR a.starts_at >= ?)
        AND (? IS NULL OR a.starts_at < ?)
        AND (? IS NULL OR a.status = ?)
      ORDER BY a.starts_at LIMIT 300`,
  ).bind(
    start ?? null, start ?? null, end ?? null, end ?? null, status ?? null, status ?? null,
  ).all()

  return c.json({ appointments: await withServices(c.env, results ?? []) })
})

const statusSchema = z.object({
  status: z.enum(['booked', 'confirmed', 'completed', 'cancelled', 'no_show']),
})

admin.patch('/appointments/:id/status', async (c) => {
  const parsed = statusSchema.safeParse(await c.req.json().catch(() => ({})))
  if (!parsed.success) badRequest('Pick a valid status.', 'invalid_input')

  const id = c.req.param('id')
  const now = nowSec()
  const res = await c.env.DB.prepare(
    `UPDATE appointments
        SET status = ?, updated_at = ?,
            cancelled_at = CASE WHEN ? = 'cancelled' THEN ? ELSE cancelled_at END
      WHERE id = ?`,
  ).bind(parsed.data.status, now, parsed.data.status, now, id).run()
  if (!res.meta.changes) notFound('That appointment does not exist.')

  // A cancelled or completed appointment should not text a reminder.
  if (parsed.data.status === 'cancelled' || parsed.data.status === 'no_show') {
    await c.env.DB.prepare(
      `UPDATE messages SET status = 'skipped', error = 'appointment ' || ?
         WHERE appointment_id = ? AND status = 'queued'`,
    ).bind(parsed.data.status, id).run()
  }

  return c.json({ ok: true })
})

// --------------------------------------------------------------- services --

const serviceSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(1000).default(''),
  category: z.string().trim().max(60).default('General'),
  duration_min: z.number().int().min(5).max(600),
  price_cents: z.number().int().min(0).max(2_000_000),
  deposit_cents: z.number().int().min(0).max(2_000_000).default(0),
  active: z.boolean().default(true),
  sort_order: z.number().int().min(0).max(10_000).default(0),
})

admin.post('/services', requireAdmin, async (c) => {
  const parsed = serviceSchema.safeParse(await c.req.json().catch(() => ({})))
  if (!parsed.success) badRequest(firstIssue(parsed.error), 'invalid_input')
  const s = parsed.data
  if (s.deposit_cents > s.price_cents) badRequest('A deposit cannot exceed the price.', 'deposit_too_large')

  const id = newId('svc')
  const now = nowSec()
  await c.env.DB.prepare(
    `INSERT INTO services
       (id, name, description, category, duration_min, price_cents, deposit_cents, active, sort_order, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(id, s.name, s.description, s.category, s.duration_min, s.price_cents, s.deposit_cents,
    s.active ? 1 : 0, s.sort_order, now, now).run()

  return c.json({ service: await c.env.DB.prepare('SELECT * FROM services WHERE id = ?').bind(id).first() }, 201)
})

admin.patch('/services/:id', requireAdmin, async (c) => {
  const parsed = serviceSchema.partial().safeParse(await c.req.json().catch(() => ({})))
  if (!parsed.success) badRequest(firstIssue(parsed.error), 'invalid_input')

  const id = c.req.param('id')
  const sets: string[] = []
  const binds: unknown[] = []
  for (const [key, value] of Object.entries(parsed.data)) {
    if (value === undefined) continue
    sets.push(`${key} = ?`)
    binds.push(typeof value === 'boolean' ? (value ? 1 : 0) : value)
  }
  if (sets.length === 0) badRequest('Nothing to change.', 'no_changes')

  sets.push('updated_at = ?'); binds.push(nowSec())
  binds.push(id)
  const res = await c.env.DB.prepare(`UPDATE services SET ${sets.join(', ')} WHERE id = ?`).bind(...binds).run()
  if (!res.meta.changes) notFound('That service does not exist.')

  return c.json({ service: await c.env.DB.prepare('SELECT * FROM services WHERE id = ?').bind(id).first() })
})

/**
 * Retires a service rather than deleting it, so past appointments keep their
 * history. Line items are snapshots, but the link is still worth preserving.
 */
admin.delete('/services/:id', requireAdmin, async (c) => {
  await c.env.DB.prepare('UPDATE services SET active = 0, updated_at = ? WHERE id = ?')
    .bind(nowSec(), c.req.param('id')).run()
  return c.json({ ok: true })
})

// ------------------------------------------------------------------ staff --

admin.get('/staff', async (c) => {
  const [staff, hours] = await Promise.all([
    c.env.DB.prepare(
      `SELECT s.id, s.user_id, s.display_name, s.title, s.bio, s.active, s.sort_order,
              u.email AS user_email
         FROM staff s LEFT JOIN users u ON u.id = s.user_id
        ORDER BY s.sort_order, s.display_name`,
    ).all(),
    c.env.DB.prepare('SELECT id, staff_id, weekday, start_min, end_min FROM staff_hours ORDER BY weekday, start_min').all(),
  ])
  return c.json({ staff: staff.results ?? [], hours: hours.results ?? [] })
})

const staffSchema = z.object({
  display_name: z.string().trim().min(1).max(80),
  title: z.string().trim().max(80).default('Stylist'),
  bio: z.string().trim().max(2000).default(''),
  active: z.boolean().default(true),
  sort_order: z.number().int().min(0).max(10_000).default(0),
  user_id: z.string().min(1).nullable().optional(),
})

admin.post('/staff', requireAdmin, async (c) => {
  const parsed = staffSchema.safeParse(await c.req.json().catch(() => ({})))
  if (!parsed.success) badRequest(firstIssue(parsed.error), 'invalid_input')
  const s = parsed.data

  const id = newId('stf')
  await c.env.DB.prepare(
    'INSERT INTO staff (id, user_id, display_name, title, bio, active, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).bind(id, s.user_id ?? null, s.display_name, s.title, s.bio, s.active ? 1 : 0, s.sort_order).run()

  return c.json({ staff: await c.env.DB.prepare('SELECT * FROM staff WHERE id = ?').bind(id).first() }, 201)
})

admin.patch('/staff/:id', requireAdmin, async (c) => {
  const parsed = staffSchema.partial().safeParse(await c.req.json().catch(() => ({})))
  if (!parsed.success) badRequest(firstIssue(parsed.error), 'invalid_input')

  const sets: string[] = []
  const binds: unknown[] = []
  for (const [key, value] of Object.entries(parsed.data)) {
    if (value === undefined) continue
    sets.push(`${key} = ?`)
    binds.push(typeof value === 'boolean' ? (value ? 1 : 0) : value)
  }
  if (sets.length === 0) badRequest('Nothing to change.', 'no_changes')

  binds.push(c.req.param('id'))
  const res = await c.env.DB.prepare(`UPDATE staff SET ${sets.join(', ')} WHERE id = ?`).bind(...binds).run()
  if (!res.meta.changes) notFound('That stylist does not exist.')

  return c.json({ staff: await c.env.DB.prepare('SELECT * FROM staff WHERE id = ?').bind(c.req.param('id')).first() })
})

const hoursSchema = z.object({
  hours: z.array(z.object({
    weekday: z.number().int().min(0).max(6),
    start_min: z.number().int().min(0).max(1440),
    end_min: z.number().int().min(0).max(1440),
  })).max(30),
})

/** Replaces a stylist's whole weekly schedule in one write. */
admin.put('/staff/:id/hours', requireAdmin, async (c) => {
  const staffId = c.req.param('id')
  const parsed = hoursSchema.safeParse(await c.req.json().catch(() => ({})))
  if (!parsed.success) badRequest('Check the hours you entered.', 'invalid_input')

  for (const h of parsed.data.hours) {
    if (h.end_min <= h.start_min) badRequest('Each shift must end after it starts.', 'invalid_hours')
  }

  await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM staff_hours WHERE staff_id = ?').bind(staffId),
    ...parsed.data.hours.map((h) =>
      c.env.DB.prepare(
        'INSERT INTO staff_hours (id, staff_id, weekday, start_min, end_min) VALUES (?, ?, ?, ?, ?)',
      ).bind(newId('sh'), staffId, h.weekday, h.start_min, h.end_min),
    ),
  ])

  const { results } = await c.env.DB.prepare(
    'SELECT id, staff_id, weekday, start_min, end_min FROM staff_hours WHERE staff_id = ? ORDER BY weekday, start_min',
  ).bind(staffId).all()
  return c.json({ hours: results ?? [] })
})

const timeOffSchema = z.object({
  staff_id: z.string().min(1),
  starts_at: z.number().int().positive(),
  ends_at: z.number().int().positive(),
  reason: z.string().trim().max(200).default(''),
})

admin.post('/time-off', async (c) => {
  const parsed = timeOffSchema.safeParse(await c.req.json().catch(() => ({})))
  if (!parsed.success) badRequest(firstIssue(parsed.error), 'invalid_input')
  if (parsed.data.ends_at <= parsed.data.starts_at) badRequest('Time off must end after it starts.', 'invalid_range')

  const id = newId('off')
  await c.env.DB.prepare(
    'INSERT INTO time_off (id, staff_id, starts_at, ends_at, reason) VALUES (?, ?, ?, ?, ?)',
  ).bind(id, parsed.data.staff_id, parsed.data.starts_at, parsed.data.ends_at, parsed.data.reason).run()

  return c.json({ time_off: await c.env.DB.prepare('SELECT * FROM time_off WHERE id = ?').bind(id).first() }, 201)
})

admin.delete('/time-off/:id', async (c) => {
  await c.env.DB.prepare('DELETE FROM time_off WHERE id = ?').bind(c.req.param('id')).run()
  return c.json({ ok: true })
})

// --------------------------------------------------------------- settings --

admin.get('/settings', requireAdmin, async (c) => {
  const settings = await getSettings(c.env)
  return c.json({
    settings,
    integrations: {
      // Never echo the secrets themselves — only whether they are present.
      stripe: Boolean(c.env.STRIPE_SECRET_KEY),
      stripe_webhook: Boolean(c.env.STRIPE_WEBHOOK_SECRET),
      twilio: Boolean(c.env.TWILIO_ACCOUNT_SID && c.env.TWILIO_AUTH_TOKEN &&
        (c.env.TWILIO_FROM_NUMBER || c.env.TWILIO_MESSAGING_SERVICE_SID)),
    },
  })
})

admin.patch('/settings', requireAdmin, async (c) => {
  const body = await c.req.json().catch(() => ({})) as Record<string, unknown>
  const now = nowSec()
  const writes = []

  for (const key of EDITABLE_SETTINGS) {
    if (!(key in body)) continue
    writes.push(
      c.env.DB.prepare(
        `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      ).bind(key, serializeSetting(key, body[key]), now),
    )
  }
  if (writes.length === 0) badRequest('Nothing to change.', 'no_changes')

  await c.env.DB.batch(writes)
  invalidateSettingsCache()
  return c.json({ settings: await getSettings(c.env) })
})

// ------------------------------------------------------------ staff users --

/**
 * Everyone with back-office access. Separate from GET /clients, which only
 * returns role = 'client' — once someone is promoted they'd otherwise vanish
 * from every list in the app.
 */
admin.get('/team', requireAdmin, async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT id, first_name, last_name, email, phone, role, created_at
       FROM users WHERE role IN ('staff', 'admin')
      ORDER BY role, first_name, last_name`,
  ).all()
  return c.json({ team: results ?? [] })
})

const roleSchema = z.object({ role: z.enum(['client', 'staff', 'admin']) })

admin.patch('/users/:id/role', requireAdmin, async (c) => {
  const actor = c.var.user!
  const id = c.req.param('id')
  const parsed = roleSchema.safeParse(await c.req.json().catch(() => ({})))
  if (!parsed.success) badRequest('Pick a valid role.', 'invalid_input')

  // Guard against the last admin demoting themselves out of the back office.
  if (id === actor.id && parsed.data.role !== 'admin') {
    const others = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND id != ?")
      .bind(id).first<{ n: number }>()
    if ((others?.n ?? 0) === 0) conflict('You are the only admin. Promote someone else first.', 'last_admin')
  }

  const res = await c.env.DB.prepare('UPDATE users SET role = ?, updated_at = ? WHERE id = ?')
    .bind(parsed.data.role, nowSec(), id).run()
  if (!res.meta.changes) notFound('No such user.')
  return c.json({ ok: true })
})

export default admin
