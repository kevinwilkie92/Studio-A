import type { Env } from '../types'
import { newId } from './ids'
import { getSmsProvider, renderTemplate } from './sms'
import { getSettings, type SalonSettings } from './settings'
import { formatLocal, nowSec, toZonedParts } from './time'

export interface QueueInput {
  kind: 'campaign' | 'reminder' | 'transactional'
  userId: string | null
  toPhone: string
  body: string
  campaignId?: string | null
  appointmentId?: string | null
  /** Unique per logical message; a repeat insert is silently dropped. */
  dedupeKey?: string | null
}

export interface Recipient {
  id: string
  first_name: string
  last_name: string
  phone: string | null
  sms_opt_in: number
}

/**
 * Writes a message as `queued`. Returns the row id, or null when the unique
 * dedupe index rejected it (meaning it was already queued or sent).
 */
export async function queueMessage(env: Env, input: QueueInput): Promise<string | null> {
  const id = newId('msg')
  try {
    const res = await env.DB.prepare(
      `INSERT INTO messages
         (id, kind, campaign_id, appointment_id, user_id, to_phone, body, status, dedupe_key, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?)`,
    ).bind(
      id, input.kind, input.campaignId ?? null, input.appointmentId ?? null, input.userId,
      input.toPhone, input.body, input.dedupeKey ?? null, nowSec(),
    ).run()
    return res.success ? id : null
  } catch (err) {
    // UNIQUE violation on dedupe_key — the message already exists, which is
    // exactly what the key is for. Anything else is a real failure.
    if (String(err).includes('UNIQUE')) return null
    throw err
  }
}

/**
 * Sends up to `limit` queued messages.
 *
 * Mass texts are drained here rather than inside the request that created them:
 * a Worker request has a wall-clock budget, and 400 sequential Twilio calls do
 * not fit inside it. The cron handler calls this every few minutes, and the
 * campaign endpoint kicks off one pass via waitUntil so small blasts still feel
 * instant.
 */
export async function dispatchQueued(env: Env, limit = 60): Promise<{ sent: number; failed: number }> {
  const { results } = await env.DB.prepare(
    `SELECT id, user_id, to_phone, body, campaign_id, attempts
       FROM messages WHERE status = 'queued' ORDER BY created_at LIMIT ?`,
  ).bind(limit).all<{
    id: string; user_id: string | null; to_phone: string; body: string
    campaign_id: string | null; attempts: number
  }>()

  if (!results || results.length === 0) return { sent: 0, failed: 0 }

  const provider = getSmsProvider(env)
  let sent = 0
  let failed = 0
  const touchedCampaigns = new Set<string>()

  for (const msg of results) {
    const result = await provider.send(msg.to_phone, msg.body)
    const now = nowSec()

    if (result.ok) {
      await env.DB.prepare(
        `UPDATE messages SET status = 'sent', provider = ?, provider_ref = ?, sent_at = ?,
                attempts = attempts + 1, error = NULL
           WHERE id = ?`,
      ).bind(provider.name, result.ref ?? null, now, msg.id).run()
      sent++
    } else {
      // Two tries, then park it as failed so one dead number cannot wedge
      // the queue ahead of everyone else's messages.
      const attempts = msg.attempts + 1
      const status = attempts >= 2 ? 'failed' : 'queued'
      await env.DB.prepare(
        'UPDATE messages SET status = ?, attempts = ?, error = ?, provider = ? WHERE id = ?',
      ).bind(status, attempts, result.error ?? 'unknown error', provider.name, msg.id).run()
      if (status === 'failed') failed++
    }

    if (msg.campaign_id) touchedCampaigns.add(msg.campaign_id)
  }

  for (const campaignId of touchedCampaigns) await refreshCampaignCounts(env, campaignId)
  return { sent, failed }
}

export async function refreshCampaignCounts(env: Env, campaignId: string): Promise<void> {
  const row = await env.DB.prepare(
    `SELECT
        SUM(CASE WHEN status = 'sent'   THEN 1 ELSE 0 END) AS sent,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
        SUM(CASE WHEN status = 'queued' THEN 1 ELSE 0 END) AS pending
       FROM messages WHERE campaign_id = ?`,
  ).bind(campaignId).first<{ sent: number | null; failed: number | null; pending: number | null }>()

  const sent = row?.sent ?? 0
  const failed = row?.failed ?? 0
  const pending = row?.pending ?? 0

  await env.DB.prepare(
    `UPDATE campaigns
        SET sent_count = ?, failed_count = ?,
            status = CASE WHEN ? = 0 THEN 'sent' ELSE 'sending' END,
            completed_at = CASE WHEN ? = 0 THEN COALESCE(completed_at, ?) ELSE NULL END
      WHERE id = ? AND status IN ('sending', 'sent')`,
  ).bind(sent, failed, pending, pending, nowSec(), campaignId).run()
}

/** One-off text sent inline — booking confirmations, cancellations. */
export async function sendTransactional(
  env: Env, userId: string | null, toPhone: string, body: string, appointmentId?: string,
): Promise<void> {
  const id = await queueMessage(env, {
    kind: 'transactional', userId, toPhone, body, appointmentId: appointmentId ?? null,
  })
  if (!id) return

  const provider = getSmsProvider(env)
  const result = await provider.send(toPhone, body)
  await env.DB.prepare(
    `UPDATE messages SET status = ?, provider = ?, provider_ref = ?, error = ?, sent_at = ?, attempts = 1
       WHERE id = ?`,
  ).bind(
    result.ok ? 'sent' : 'failed', provider.name, result.ref ?? null,
    result.ok ? null : (result.error ?? 'unknown error'), result.ok ? nowSec() : null, id,
  ).run()
}

export type Audience = 'all' | 'upcoming' | 'lapsed' | 'recent' | 'custom'

export interface AudienceParams {
  /** `lapsed`: no visit in this many days. `recent`: visited within this many. */
  days?: number
  /** `custom`: explicit client ids. */
  user_ids?: string[]
}

/**
 * Resolves an audience to textable clients.
 *
 * Opted-out and phone-less clients are excluded at the query level, so an
 * accidental "everyone" blast can never reach someone who replied STOP.
 */
export async function resolveAudience(env: Env, audience: Audience, params: AudienceParams): Promise<Recipient[]> {
  const base = `SELECT DISTINCT u.id, u.first_name, u.last_name, u.phone, u.sms_opt_in
                  FROM users u`
  const textable = `u.phone IS NOT NULL AND u.phone != '' AND u.sms_opt_in = 1 AND u.role = 'client'`
  const now = nowSec()

  let sql: string
  let binds: unknown[] = []

  switch (audience) {
    case 'upcoming':
      sql = `${base}
               JOIN appointments a ON a.client_id = u.id
              WHERE ${textable}
                AND a.status IN ('booked', 'confirmed')
                AND a.starts_at >= ?`
      binds = [now]
      break

    case 'lapsed': {
      const cutoff = now - Math.max(1, params.days ?? 90) * 86400
      sql = `${base}
              WHERE ${textable}
                AND NOT EXISTS (
                      SELECT 1 FROM appointments a
                       WHERE a.client_id = u.id
                         AND a.status IN ('completed', 'booked', 'confirmed')
                         AND a.starts_at >= ?)`
      binds = [cutoff]
      break
    }

    case 'recent': {
      const cutoff = now - Math.max(1, params.days ?? 30) * 86400
      sql = `${base}
               JOIN appointments a ON a.client_id = u.id
              WHERE ${textable}
                AND a.status = 'completed'
                AND a.starts_at >= ?`
      binds = [cutoff]
      break
    }

    case 'custom': {
      const ids = (params.user_ids ?? []).filter((id) => typeof id === 'string' && id.length > 0)
      if (ids.length === 0) return []
      sql = `${base} WHERE ${textable} AND u.id IN (${ids.map(() => '?').join(', ')})`
      binds = ids
      break
    }

    case 'all':
    default:
      sql = `${base} WHERE ${textable}`
      break
  }

  const { results } = await env.DB.prepare(`${sql} ORDER BY u.first_name, u.last_name`).bind(...binds).all<Recipient>()
  return results ?? []
}

export function personalize(body: string, recipient: Recipient, settings: SalonSettings): string {
  const rendered = renderTemplate(body, {
    first_name: recipient.first_name,
    last_name: recipient.last_name,
    salon_name: settings.salon_name,
    salon_phone: settings.phone,
  })
  return appendFooter(rendered, settings.sms_footer)
}

/** Adds the opt-out line unless the copy already carries one. */
export function appendFooter(body: string, footer: string): string {
  if (!footer.trim()) return body
  if (/\bstop\b/i.test(body)) return body
  return `${body.trimEnd()}\n${footer.trim()}`
}

// ------------------------------------------------------------- reminders ---

interface DueAppointment {
  id: string
  starts_at: number
  client_id: string
  first_name: string
  phone: string | null
  sms_opt_in: number
  staff_name: string | null
  services: string | null
}

/**
 * Queues reminder texts for appointments crossing a reminder offset.
 *
 * Each (appointment, offset) pair carries a dedupe key, so overlapping cron
 * runs, retries, or a redeploy mid-window cannot text a client twice about the
 * same appointment.
 */
export async function queueDueReminders(env: Env, lookbackSec = 3600): Promise<number> {
  const settings = await getSettings(env)
  const now = nowSec()
  let queued = 0

  for (const offsetHours of settings.reminder_offsets_hours) {
    const offsetSec = offsetHours * 3600
    // Appointments whose reminder moment has arrived within the lookback.
    const windowStart = now + offsetSec - lookbackSec
    const windowEnd = now + offsetSec

    const { results } = await env.DB.prepare(
      `SELECT a.id, a.starts_at, a.client_id,
              u.first_name, u.phone, u.sms_opt_in,
              s.display_name AS staff_name,
              (SELECT GROUP_CONCAT(name, ', ') FROM appointment_services x
                WHERE x.appointment_id = a.id) AS services
         FROM appointments a
         JOIN users u ON u.id = a.client_id
    LEFT JOIN staff s ON s.id = a.staff_id
        WHERE a.status IN ('booked', 'confirmed')
          AND a.starts_at > ? AND a.starts_at <= ?
          AND u.phone IS NOT NULL AND u.phone != '' AND u.sms_opt_in = 1`,
    ).bind(windowStart, windowEnd).all<DueAppointment>()

    for (const appt of results ?? []) {
      if (!appt.phone) continue
      if (inQuietHours(appt.starts_at, now, settings)) continue

      const body = appendFooter(reminderBody(appt, settings, offsetHours), settings.sms_footer)
      const id = await queueMessage(env, {
        kind: 'reminder',
        userId: appt.client_id,
        toPhone: appt.phone,
        body,
        appointmentId: appt.id,
        dedupeKey: `reminder:${appt.id}:${offsetHours}h`,
      })
      if (id) queued++
    }
  }
  return queued
}

function reminderBody(appt: DueAppointment, settings: SalonSettings, offsetHours: number): string {
  const when = formatLocal(appt.starts_at, settings.timezone)
  const services = appt.services ? ` for ${appt.services}` : ''
  const withWho = appt.staff_name ? ` with ${appt.staff_name}` : ''
  const lead = offsetHours >= 12 ? `Reminder: you're booked ${when}` : `See you soon! Your appointment is ${when}`
  const tail = settings.phone ? ` Need to change it? Call ${settings.phone}.` : ''
  return `${settings.salon_name}: ${lead}${withWho}${services}.${tail}`
}

/**
 * Suppresses reminders that would land late at night. A 2-hour reminder for a
 * 9am appointment would otherwise fire at 7am; a 24-hour one for a 9am
 * appointment is fine. Only the send moment matters, not the appointment.
 */
function inQuietHours(_apptStart: number, sendMoment: number, settings: SalonSettings): boolean {
  const { hour } = toZonedParts(sendMoment, settings.timezone)
  const start = settings.reminder_quiet_start
  const end = settings.reminder_quiet_end
  if (start === end) return false
  // Quiet window wraps midnight (e.g. 21 -> 9).
  return start > end ? hour >= start || hour < end : hour >= start && hour < end
}
