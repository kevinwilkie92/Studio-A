import { Hono } from 'hono'
import { z } from 'zod'
import type { AppContext, Env } from '../types'
import { newId } from '../lib/ids'
import { requireAuth } from '../lib/auth'
import { badRequest, conflict, forbidden, notFound } from '../lib/http'
import { getSettings } from '../lib/settings'
import { dateKey, formatLocal, nowSec, parseDateKey, zonedToEpoch } from '../lib/time'
import { eligibleStaff, findAvailability, isSlotFree, isWithinHours } from '../lib/availability'
import { appendFooter, sendTransactional } from '../lib/messaging'

const booking = new Hono<AppContext>()

// ------------------------------------------------------------- catalog -----

booking.get('/services', async (c) => {
  const includeInactive = c.req.query('all') === '1' && isStaff(c)
  const { results } = await c.env.DB.prepare(
    `SELECT id, name, description, category, duration_min, price_cents, deposit_cents, active, sort_order
       FROM services ${includeInactive ? '' : 'WHERE active = 1'}
      ORDER BY sort_order, name`,
  ).all()
  return c.json({ services: results ?? [] })
})

booking.get('/staff', async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT id, display_name, title, bio, sort_order
       FROM staff WHERE active = 1 ORDER BY sort_order, display_name`,
  ).all()
  return c.json({ staff: results ?? [] })
})

booking.get('/salon', async (c) => {
  const s = await getSettings(c.env)
  // Only the public-facing settings; nothing operational.
  return c.json({
    salon: {
      name: s.salon_name,
      timezone: s.timezone,
      currency: s.currency,
      address: s.address,
      phone: s.phone,
      cancel_window_hours: s.cancel_window_hours,
      booking_lead_hours: s.booking_lead_hours,
      booking_horizon_days: s.booking_horizon_days,
    },
    stripe_publishable_key: c.env.STRIPE_PUBLISHABLE_KEY ?? null,
  })
})

// -------------------------------------------------------- availability -----

booking.get('/availability', async (c) => {
  const settings = await getSettings(c.env)
  const day = c.req.query('date') ?? ''
  if (!parseDateKey(day)) badRequest('Pass a date as YYYY-MM-DD.', 'invalid_date')

  const serviceIds = (c.req.query('services') ?? '').split(',').map((s) => s.trim()).filter(Boolean)
  if (serviceIds.length === 0) badRequest('Choose at least one service first.', 'no_services')

  const chosen = await loadServices(c.env, serviceIds)
  if (chosen.length !== serviceIds.length) badRequest('One of those services is no longer offered.', 'unknown_service')

  const durationMin = chosen.reduce((sum, s) => sum + s.duration_min, 0)
  const horizonEnd = nowSec() + settings.booking_horizon_days * 86400
  const d = parseDateKey(day)!
  if (zonedToEpoch(d.year, d.month, d.day, 0, settings.timezone) > horizonEnd) {
    badRequest(`Bookings open ${settings.booking_horizon_days} days ahead.`, 'beyond_horizon')
  }

  const slots = await findAvailability({
    env: c.env,
    settings,
    dateKey: day,
    durationMin,
    staffId: c.req.query('staff_id') || null,
    serviceIds,
    excludeAppointmentId: c.req.query('exclude') || null,
  })

  // Collapse to one entry per start time carrying the stylists who are free.
  const byStart = new Map<number, { start: number; end: number; staff: { id: string; name: string }[] }>()
  for (const slot of slots) {
    const entry = byStart.get(slot.start) ?? { start: slot.start, end: slot.end, staff: [] }
    entry.staff.push({ id: slot.staff_id, name: slot.staff_name })
    byStart.set(slot.start, entry)
  }

  return c.json({
    date: day,
    timezone: settings.timezone,
    duration_min: durationMin,
    total_cents: chosen.reduce((sum, s) => sum + s.price_cents, 0),
    deposit_cents: chosen.reduce((sum, s) => sum + s.deposit_cents, 0),
    slots: [...byStart.values()].sort((a, b) => a.start - b.start),
  })
})

// ------------------------------------------------------------ appointments -

const createSchema = z.object({
  service_ids: z.array(z.string().min(1)).min(1, 'Choose at least one service.').max(8),
  starts_at: z.number().int().positive(),
  staff_id: z.string().min(1).nullable().optional(),
  client_request: z.string().trim().max(1000).default(''),
  /** Staff booking on a client's behalf, e.g. over the phone. */
  client_id: z.string().min(1).optional(),
})

booking.post('/appointments', requireAuth, async (c) => {
  const actor = c.var.user!
  const settings = await getSettings(c.env)

  const parsed = createSchema.safeParse(await c.req.json().catch(() => ({})))
  if (!parsed.success) badRequest(parsed.error.issues[0]?.message ?? 'Check the booking details.', 'invalid_input')
  const input = parsed.data

  const clientId = input.client_id && isStaff(c) ? input.client_id : actor.id
  const client = await c.env.DB.prepare(
    'SELECT id, first_name, phone, sms_opt_in FROM users WHERE id = ?',
  ).bind(clientId).first<{ id: string; first_name: string; phone: string | null; sms_opt_in: number }>()
  if (!client) notFound('That client no longer exists.')

  const chosen = await loadServices(c.env, input.service_ids)
  if (chosen.length !== input.service_ids.length) badRequest('One of those services is no longer offered.', 'unknown_service')

  const durationSec = chosen.reduce((sum, s) => sum + s.duration_min, 0) * 60
  const start = input.starts_at
  const end = start + durationSec
  const now = nowSec()

  // Clients book inside the rules; staff can override for phone bookings and
  // squeeze-ins.
  if (!isStaff(c)) {
    if (start < now + settings.booking_lead_hours * 3600) {
      badRequest(`Please book at least ${settings.booking_lead_hours} hours ahead.`, 'too_soon')
    }
    if (start > now + settings.booking_horizon_days * 86400) {
      badRequest(`Bookings open ${settings.booking_horizon_days} days ahead.`, 'beyond_horizon')
    }
  }

  const staffId = await resolveStaff(c.env, input.staff_id ?? null, input.service_ids, start, end, settings.buffer_min * 60)
  if (!staffId) conflict('That time was just taken. Pick another slot.', 'slot_unavailable')

  if (!isStaff(c) && !(await isWithinHours(c.env, staffId, start, end, settings.timezone))) {
    badRequest('That time is outside the stylist’s hours.', 'outside_hours')
  }

  const id = newId('appt')
  const totalCents = chosen.reduce((sum, s) => sum + s.price_cents, 0)

  const statements = [
    c.env.DB.prepare(
      `INSERT INTO appointments
         (id, client_id, staff_id, starts_at, ends_at, status, client_request, total_cents, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'booked', ?, ?, ?, ?)`,
    ).bind(id, clientId, staffId, start, end, input.client_request, totalCents, now, now),
    ...chosen.map((s, i) =>
      c.env.DB.prepare(
        `INSERT INTO appointment_services
           (id, appointment_id, service_id, name, duration_min, price_cents, position)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).bind(newId('as'), id, s.id, s.name, s.duration_min, s.price_cents, i),
    ),
  ]
  await c.env.DB.batch(statements)

  // Re-check after writing: D1 has no serializable transaction across the
  // availability read and this insert, so two simultaneous bookings can both
  // pass the pre-check. The loser is rolled back here.
  if (!(await isSlotFree(c.env, staffId, start, end, settings.buffer_min * 60, id))) {
    await c.env.DB.prepare('DELETE FROM appointments WHERE id = ?').bind(id).run()
    conflict('That time was just taken. Pick another slot.', 'slot_unavailable')
  }

  if (settings.booking_confirmation_sms && client.phone && client.sms_opt_in) {
    const when = formatLocal(start, settings.timezone)
    const body = appendFooter(
      `${settings.salon_name}: You're booked for ${when} — ${chosen.map((s) => s.name).join(', ')}. See you then!`,
      settings.sms_footer,
    )
    c.executionCtx.waitUntil(sendTransactional(c.env, clientId, client.phone, body, id))
  }

  return c.json({ appointment: await loadAppointment(c.env, id) }, 201)
})

booking.get('/appointments', requireAuth, async (c) => {
  const user = c.var.user!
  const scope = c.req.query('scope') ?? 'upcoming'
  const now = nowSec()

  const where = scope === 'past'
    ? 'a.client_id = ? AND (a.starts_at < ? OR a.status IN (\'completed\', \'cancelled\', \'no_show\'))'
    : 'a.client_id = ? AND a.starts_at >= ? AND a.status IN (\'booked\', \'confirmed\')'

  const { results } = await c.env.DB.prepare(
    `${APPOINTMENT_SELECT} WHERE ${where} ORDER BY a.starts_at ${scope === 'past' ? 'DESC' : 'ASC'} LIMIT 100`,
  ).bind(user.id, now).all()

  return c.json({ appointments: await withServices(c.env, results ?? []) })
})

booking.get('/appointments/:id', requireAuth, async (c) => {
  const user = c.var.user!
  const appt = await loadAppointment(c.env, c.req.param('id'))
  if (!appt) notFound('That appointment does not exist.')
  if (appt.client_id !== user.id && !isStaff(c)) forbidden()
  return c.json({ appointment: appt })
})

booking.post('/appointments/:id/cancel', requireAuth, async (c) => {
  const user = c.var.user!
  const settings = await getSettings(c.env)
  const id = c.req.param('id')

  const appt = await c.env.DB.prepare(
    `SELECT a.id, a.client_id, a.starts_at, a.status, u.phone, u.sms_opt_in
       FROM appointments a JOIN users u ON u.id = a.client_id WHERE a.id = ?`,
  ).bind(id).first<{
    id: string; client_id: string; starts_at: number; status: string
    phone: string | null; sms_opt_in: number
  }>()
  if (!appt) notFound('That appointment does not exist.')

  const staff = isStaff(c)
  if (appt.client_id !== user.id && !staff) forbidden()
  if (appt.status === 'cancelled') return c.json({ appointment: await loadAppointment(c.env, id) })
  if (appt.status === 'completed') badRequest('That appointment is already finished.', 'already_completed')

  // The cancellation window is a client-side rule; staff can always cancel.
  if (!staff && appt.starts_at - nowSec() < settings.cancel_window_hours * 3600) {
    badRequest(
      `Cancellations need ${settings.cancel_window_hours} hours' notice.` +
      (settings.phone ? ` Please call ${settings.phone}.` : ' Please call the salon.'),
      'inside_cancel_window',
    )
  }

  const now = nowSec()
  await c.env.DB.batch([
    c.env.DB.prepare(
      `UPDATE appointments SET status = 'cancelled', cancelled_at = ?, cancelled_by = ?, updated_at = ?
         WHERE id = ?`,
    ).bind(now, user.id, now, id),
    // Pull any reminder that has not gone out yet.
    c.env.DB.prepare(
      `UPDATE messages SET status = 'skipped', error = 'appointment cancelled'
         WHERE appointment_id = ? AND status = 'queued'`,
    ).bind(id),
  ])

  if (staff && appt.phone && appt.sms_opt_in) {
    const body = appendFooter(
      `${settings.salon_name}: Your appointment on ${formatLocal(appt.starts_at, settings.timezone)} has been cancelled.` +
      (settings.phone ? ` Call ${settings.phone} to rebook.` : ''),
      settings.sms_footer,
    )
    c.executionCtx.waitUntil(sendTransactional(c.env, appt.client_id, appt.phone, body, id))
  }

  return c.json({ appointment: await loadAppointment(c.env, id) })
})

const rescheduleSchema = z.object({
  starts_at: z.number().int().positive(),
  staff_id: z.string().min(1).nullable().optional(),
})

booking.post('/appointments/:id/reschedule', requireAuth, async (c) => {
  const user = c.var.user!
  const settings = await getSettings(c.env)
  const id = c.req.param('id')

  const parsed = rescheduleSchema.safeParse(await c.req.json().catch(() => ({})))
  if (!parsed.success) badRequest('Pick a new time.', 'invalid_input')

  const appt = await loadAppointment(c.env, id)
  if (!appt) notFound('That appointment does not exist.')
  if (appt.client_id !== user.id && !isStaff(c)) forbidden()
  if (appt.status === 'cancelled' || appt.status === 'completed') {
    badRequest('That appointment can no longer be moved.', 'not_reschedulable')
  }

  const durationSec = appt.ends_at - appt.starts_at
  const start = parsed.data.starts_at
  const end = start + durationSec

  if (!isStaff(c) && start < nowSec() + settings.booking_lead_hours * 3600) {
    badRequest(`Please book at least ${settings.booking_lead_hours} hours ahead.`, 'too_soon')
  }

  const serviceIds = appt.services.map((s) => s.service_id).filter((x): x is string => Boolean(x))
  const staffId = await resolveStaff(
    c.env, parsed.data.staff_id ?? appt.staff_id, serviceIds, start, end, settings.buffer_min * 60, id,
  )
  if (!staffId) conflict('That time is not open. Pick another slot.', 'slot_unavailable')

  const now = nowSec()
  await c.env.DB.batch([
    c.env.DB.prepare(
      'UPDATE appointments SET starts_at = ?, ends_at = ?, staff_id = ?, updated_at = ? WHERE id = ?',
    ).bind(start, end, staffId, now, id),
    // The old reminders describe the old time; drop them so the cron requeues
    // against the new one.
    c.env.DB.prepare(
      `UPDATE messages SET status = 'skipped', error = 'appointment rescheduled'
         WHERE appointment_id = ? AND status = 'queued' AND kind = 'reminder'`,
    ).bind(id),
    c.env.DB.prepare(
      `DELETE FROM messages WHERE appointment_id = ? AND kind = 'reminder' AND status = 'skipped'`,
    ).bind(id),
  ])

  return c.json({ appointment: await loadAppointment(c.env, id) })
})

// ------------------------------------------------------------- helpers -----

const APPOINTMENT_SELECT = `
  SELECT a.id, a.client_id, a.staff_id, a.starts_at, a.ends_at, a.status,
         a.client_request, a.total_cents, a.paid_cents, a.created_at,
         s.display_name AS staff_name,
         u.first_name AS client_first_name, u.last_name AS client_last_name,
         u.email AS client_email, u.phone AS client_phone
    FROM appointments a
    LEFT JOIN staff s ON s.id = a.staff_id
    JOIN users u ON u.id = a.client_id`

export interface AppointmentRow {
  id: string
  client_id: string
  staff_id: string | null
  starts_at: number
  ends_at: number
  status: string
  client_request: string
  total_cents: number
  paid_cents: number
  staff_name: string | null
  services: { service_id: string | null; name: string; duration_min: number; price_cents: number }[]
}

export async function loadAppointment(env: Env, id: string): Promise<AppointmentRow | null> {
  const row = await env.DB.prepare(`${APPOINTMENT_SELECT} WHERE a.id = ?`).bind(id).first()
  if (!row) return null
  const [withSvc] = await withServices(env, [row])
  return (withSvc as AppointmentRow) ?? null
}

/** Attaches line items to a page of appointments with one extra query. */
export async function withServices(env: Env, rows: Record<string, unknown>[]): Promise<AppointmentRow[]> {
  if (rows.length === 0) return []
  const ids = rows.map((r) => r.id as string)
  const { results } = await env.DB.prepare(
    `SELECT appointment_id, service_id, name, duration_min, price_cents
       FROM appointment_services
      WHERE appointment_id IN (${ids.map(() => '?').join(', ')})
      ORDER BY position`,
  ).bind(...ids).all<{
    appointment_id: string; service_id: string | null; name: string
    duration_min: number; price_cents: number
  }>()

  const byAppt = new Map<string, AppointmentRow['services']>()
  for (const r of results ?? []) {
    const list = byAppt.get(r.appointment_id) ?? []
    list.push({ service_id: r.service_id, name: r.name, duration_min: r.duration_min, price_cents: r.price_cents })
    byAppt.set(r.appointment_id, list)
  }

  return rows.map((r) => ({ ...r, services: byAppt.get(r.id as string) ?? [] })) as AppointmentRow[]
}

export async function loadServices(env: Env, ids: string[]) {
  if (ids.length === 0) return []
  const unique = [...new Set(ids)]
  const { results } = await env.DB.prepare(
    `SELECT id, name, duration_min, price_cents, deposit_cents
       FROM services WHERE active = 1 AND id IN (${unique.map(() => '?').join(', ')})`,
  ).bind(...unique).all<{ id: string; name: string; duration_min: number; price_cents: number; deposit_cents: number }>()

  // Preserve the order the client asked for, and keep duplicates (two of the
  // same add-on is a legitimate booking).
  const byId = new Map((results ?? []).map((s) => [s.id, s]))
  return ids.map((id) => byId.get(id)).filter((s): s is NonNullable<typeof s> => Boolean(s))
}

/**
 * Picks the stylist for a booking. An explicit choice is verified; "anyone"
 * resolves to the first eligible stylist who is actually free.
 */
async function resolveStaff(
  env: Env, requested: string | null, serviceIds: string[],
  start: number, end: number, bufferSec: number, excludeId?: string,
): Promise<string | null> {
  const candidates = await eligibleStaff(env, requested, serviceIds)
  for (const person of candidates) {
    if (await isSlotFree(env, person.id, start, end, bufferSec, excludeId ?? null)) return person.id
  }
  return null
}

function isStaff(c: { var: AppContext['Variables'] }): boolean {
  return c.var.user?.role === 'staff' || c.var.user?.role === 'admin'
}

export { dateKey }
export default booking
