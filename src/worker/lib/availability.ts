import type { Env } from '../types'
import type { SalonSettings } from './settings'
import { dayBounds, nowSec, parseDateKey, toZonedParts, zonedToEpoch } from './time'

export interface Interval { start: number; end: number }

export interface StaffRow {
  id: string
  display_name: string
  title: string
  bio: string
  active: number
  sort_order: number
}

export interface SlotOption {
  /** Appointment start, UTC epoch seconds. */
  start: number
  end: number
  staff_id: string
  staff_name: string
}

/** Two half-open intervals overlap when each starts before the other ends. */
export function overlaps(a: Interval, b: Interval): boolean {
  return a.start < b.end && b.start < a.end
}

/**
 * A stylist's bookable windows on one local day, as UTC intervals.
 *
 * Hours are stored as minutes-from-midnight local, so they are resolved
 * against the actual calendar date — an 09:00 start stays 09:00 through a DST
 * change rather than drifting an hour.
 */
export function workingWindows(
  hours: { weekday: number; start_min: number; end_min: number }[],
  dateKeyStr: string,
  timeZone: string,
): Interval[] {
  const d = parseDateKey(dateKeyStr)
  if (!d) return []

  const bounds = dayBounds(dateKeyStr, timeZone)
  if (!bounds) return []
  const weekday = toZonedParts(bounds.start, timeZone).weekday

  return hours
    .filter((h) => h.weekday === weekday)
    .map((h) => ({
      start: zonedToEpoch(d.year, d.month, d.day, h.start_min, timeZone),
      end: zonedToEpoch(d.year, d.month, d.day, h.end_min, timeZone),
    }))
    .sort((a, b) => a.start - b.start)
}

/**
 * Walks each working window in `slot_interval_min` steps and keeps the starts
 * where the whole appointment fits without touching a busy interval.
 */
export function slotsForWindow(
  windows: Interval[],
  busy: Interval[],
  durationSec: number,
  intervalSec: number,
  bufferSec: number,
  earliest: number,
): number[] {
  const out: number[] = []
  const padded = busy.map((b) => ({ start: b.start - bufferSec, end: b.end + bufferSec }))

  for (const win of windows) {
    // Align the first candidate to the interval grid relative to the window
    // start, so slots read as 9:00 / 9:15 / 9:30 rather than arbitrary times.
    let t = win.start
    if (earliest > t) {
      const steps = Math.ceil((earliest - t) / intervalSec)
      t += steps * intervalSec
    }
    for (; t + durationSec <= win.end; t += intervalSec) {
      const candidate = { start: t, end: t + durationSec }
      if (!padded.some((b) => overlaps(candidate, b))) out.push(t)
    }
  }
  return out
}

interface AvailabilityInput {
  env: Env
  settings: SalonSettings
  dateKey: string
  durationMin: number
  staffId?: string | null
  serviceIds?: string[]
  /** Appointment being rescheduled; its own block is ignored. */
  excludeAppointmentId?: string | null
}

/**
 * Open start times on one local day across every eligible stylist.
 *
 * One query per table rather than per stylist — D1 charges per round trip and
 * a salon's day is small enough to filter in memory.
 */
export async function findAvailability(input: AvailabilityInput): Promise<SlotOption[]> {
  const { env, settings, dateKey: day, durationMin, staffId, serviceIds, excludeAppointmentId } = input

  const bounds = dayBounds(day, settings.timezone)
  if (!bounds) return []

  const staff = await eligibleStaff(env, staffId ?? null, serviceIds ?? [])
  if (staff.length === 0) return []
  const staffIds = staff.map((s) => s.id)

  const [hours, appts, off] = await Promise.all([
    queryAll<{ staff_id: string; weekday: number; start_min: number; end_min: number }>(
      env,
      `SELECT staff_id, weekday, start_min, end_min FROM staff_hours WHERE staff_id IN (${placeholders(staffIds.length)})`,
      staffIds,
    ),
    queryAll<{ staff_id: string | null; starts_at: number; ends_at: number }>(
      env,
      `SELECT staff_id, starts_at, ends_at FROM appointments
        WHERE status NOT IN ('cancelled', 'no_show')
          AND starts_at < ? AND ends_at > ?
          AND (? IS NULL OR id != ?)`,
      [bounds.end, bounds.start, excludeAppointmentId ?? null, excludeAppointmentId ?? null],
    ),
    queryAll<{ staff_id: string; starts_at: number; ends_at: number }>(
      env,
      `SELECT staff_id, starts_at, ends_at FROM time_off
        WHERE starts_at < ? AND ends_at > ? AND staff_id IN (${placeholders(staffIds.length)})`,
      [bounds.end, bounds.start, ...staffIds],
    ),
  ])

  const durationSec = durationMin * 60
  const intervalSec = Math.max(5, settings.slot_interval_min) * 60
  const bufferSec = Math.max(0, settings.buffer_min) * 60
  const earliest = Math.max(bounds.start, nowSec() + settings.booking_lead_hours * 3600)

  const slots: SlotOption[] = []
  for (const person of staff) {
    const windows = workingWindows(
      hours.filter((h) => h.staff_id === person.id),
      day,
      settings.timezone,
    )
    if (windows.length === 0) continue

    const busy: Interval[] = [
      ...appts.filter((a) => a.staff_id === person.id).map((a) => ({ start: a.starts_at, end: a.ends_at })),
      ...off.filter((o) => o.staff_id === person.id).map((o) => ({ start: o.starts_at, end: o.ends_at })),
    ]

    for (const start of slotsForWindow(windows, busy, durationSec, intervalSec, bufferSec, earliest)) {
      slots.push({ start, end: start + durationSec, staff_id: person.id, staff_name: person.display_name })
    }
  }

  // Group by time so the client UI shows each start once, with the stylists
  // who can take it. Earliest stylist in sort order wins the default.
  slots.sort((a, b) => a.start - b.start || a.staff_name.localeCompare(b.staff_name))
  return slots
}

/** Stylists who are active and can perform every requested service. */
export async function eligibleStaff(env: Env, staffId: string | null, serviceIds: string[]): Promise<StaffRow[]> {
  const all = await queryAll<StaffRow>(
    env,
    `SELECT id, display_name, title, bio, active, sort_order
       FROM staff WHERE active = 1 ${staffId ? 'AND id = ?' : ''}
      ORDER BY sort_order, display_name`,
    staffId ? [staffId] : [],
  )
  if (all.length === 0 || serviceIds.length === 0) return all

  const links = await queryAll<{ staff_id: string; service_id: string }>(
    env,
    `SELECT staff_id, service_id FROM staff_services WHERE staff_id IN (${placeholders(all.length)})`,
    all.map((s) => s.id),
  )

  return all.filter((person) => {
    const theirs = links.filter((l) => l.staff_id === person.id)
    // No explicit links means "does everything" — the common case for a
    // small salon that has not bothered to restrict anyone.
    if (theirs.length === 0) return true
    return serviceIds.every((id) => theirs.some((l) => l.service_id === id))
  })
}

/**
 * Last-line double-booking check, run inside the booking request right before
 * the insert. Availability listings go stale the moment two people look at the
 * same Saturday, so the write path re-checks rather than trusting the UI.
 */
export async function isSlotFree(
  env: Env, staffId: string, start: number, end: number, bufferSec: number, excludeAppointmentId?: string | null,
): Promise<boolean> {
  const clash = await env.DB.prepare(
    `SELECT 1 FROM appointments
      WHERE staff_id = ?
        AND status NOT IN ('cancelled', 'no_show')
        AND starts_at < ? AND ends_at > ?
        AND (? IS NULL OR id != ?)
      LIMIT 1`,
  ).bind(staffId, end + bufferSec, start - bufferSec, excludeAppointmentId ?? null, excludeAppointmentId ?? null)
    .first()
  if (clash) return false

  const off = await env.DB.prepare(
    'SELECT 1 FROM time_off WHERE staff_id = ? AND starts_at < ? AND ends_at > ? LIMIT 1',
  ).bind(staffId, end, start).first()
  return !off
}

/** True when `start..end` sits inside the stylist's posted hours that day. */
export async function isWithinHours(
  env: Env, staffId: string, start: number, end: number, timeZone: string,
): Promise<boolean> {
  const hours = await queryAll<{ weekday: number; start_min: number; end_min: number }>(
    env,
    'SELECT weekday, start_min, end_min FROM staff_hours WHERE staff_id = ?',
    [staffId],
  )
  const p = toZonedParts(start, timeZone)
  const day = `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`
  return workingWindows(hours, day, timeZone).some((w) => start >= w.start && end <= w.end)
}

function placeholders(n: number): string {
  return n === 0 ? 'NULL' : new Array(n).fill('?').join(', ')
}

async function queryAll<T>(env: Env, sql: string, binds: unknown[]): Promise<T[]> {
  const { results } = await env.DB.prepare(sql).bind(...binds).all<T>()
  return results ?? []
}
