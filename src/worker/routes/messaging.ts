import { Hono } from 'hono'
import { z } from 'zod'
import type { AppContext } from '../types'
import { newId } from '../lib/ids'
import { requireStaff } from '../lib/auth'
import { badRequest, conflict, notFound } from '../lib/http'
import { getSettings } from '../lib/settings'
import { nowSec } from '../lib/time'
import { segmentCount } from '../lib/sms'
import {
  dispatchQueued, personalize, queueDueReminders, queueMessage,
  refreshCampaignCounts, resolveAudience, type Audience, type AudienceParams,
} from '../lib/messaging'

const messaging = new Hono<AppContext>()
messaging.use('/*', requireStaff)

const audienceSchema = z.object({
  audience: z.enum(['all', 'upcoming', 'lapsed', 'recent', 'custom']).default('all'),
  days: z.number().int().min(1).max(3650).optional(),
  user_ids: z.array(z.string().min(1)).max(2000).optional(),
})

/**
 * Dry run for a mass text: who would receive it, and what it costs in segments.
 * Staff see this before anything is queued — a blast is not undoable.
 */
messaging.post('/preview', async (c) => {
  const settings = await getSettings(c.env)
  const body = await c.req.json().catch(() => ({})) as Record<string, unknown>

  const parsed = audienceSchema.safeParse(body)
  if (!parsed.success) badRequest('Check the audience settings.', 'invalid_input')

  const text = typeof body.body === 'string' ? body.body : ''
  const recipients = await resolveAudience(
    c.env, parsed.data.audience as Audience,
    { days: parsed.data.days, user_ids: parsed.data.user_ids } satisfies AudienceParams,
  )

  const sample = recipients[0]
  const rendered = sample
    ? personalize(text, sample, settings)
    : personalize(text, { id: '', first_name: 'Jamie', last_name: 'Doe', phone: null, sms_opt_in: 1 }, settings)

  const seg = segmentCount(rendered)
  return c.json({
    recipient_count: recipients.length,
    // Enough to eyeball the list without shipping the whole client roster.
    sample_recipients: recipients.slice(0, 12).map((r) => ({
      id: r.id, name: `${r.first_name} ${r.last_name}`.trim(), phone: r.phone,
    })),
    preview: rendered,
    segments: seg.segments,
    encoding: seg.encoding,
    characters: seg.chars,
    total_segments: seg.segments * recipients.length,
  })
})

const campaignSchema = audienceSchema.extend({
  name: z.string().trim().min(1, 'Give the campaign a name.').max(120),
  body: z.string().trim().min(1, 'Write the message first.').max(1200),
  /** Must be true — a deliberate second step before texting every client. */
  confirm: z.literal(true, { message: 'Confirm before sending.' }),
})

messaging.post('/campaigns', async (c) => {
  const actor = c.var.user!
  const settings = await getSettings(c.env)

  const parsed = campaignSchema.safeParse(await c.req.json().catch(() => ({})))
  if (!parsed.success) badRequest(parsed.error.issues[0]?.message ?? 'Check the message.', 'invalid_input')
  const input = parsed.data

  const recipients = await resolveAudience(
    c.env, input.audience as Audience, { days: input.days, user_ids: input.user_ids },
  )
  if (recipients.length === 0) conflict('Nobody in that audience can receive texts.', 'empty_audience')

  const id = newId('camp')
  const now = nowSec()
  await c.env.DB.prepare(
    `INSERT INTO campaigns
       (id, name, body, audience, audience_params, status, recipient_count, created_by, created_at, started_at)
     VALUES (?, ?, ?, ?, ?, 'sending', ?, ?, ?, ?)`,
  ).bind(
    id, input.name, input.body, input.audience,
    JSON.stringify({ days: input.days, user_ids: input.user_ids }),
    recipients.length, actor.id, now, now,
  ).run()

  // Queue every message first; the cron handler and the waitUntil pass below
  // both drain the same queue, so nothing is lost if this request is cut off.
  for (const recipient of recipients) {
    if (!recipient.phone) continue
    await queueMessage(c.env, {
      kind: 'campaign',
      campaignId: id,
      userId: recipient.id,
      toPhone: recipient.phone,
      body: personalize(input.body, recipient, settings),
      dedupeKey: `campaign:${id}:${recipient.id}`,
    })
  }

  c.executionCtx.waitUntil(
    dispatchQueued(c.env, 100).then(() => refreshCampaignCounts(c.env, id)),
  )

  const campaign = await c.env.DB.prepare('SELECT * FROM campaigns WHERE id = ?').bind(id).first()
  return c.json({ campaign }, 201)
})

messaging.get('/campaigns', async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT c.id, c.name, c.body, c.audience, c.status, c.recipient_count, c.sent_count,
            c.failed_count, c.created_at, c.completed_at,
            u.first_name AS created_by_first_name
       FROM campaigns c LEFT JOIN users u ON u.id = c.created_by
      ORDER BY c.created_at DESC LIMIT 50`,
  ).all()
  return c.json({ campaigns: results ?? [] })
})

messaging.get('/campaigns/:id', async (c) => {
  const id = c.req.param('id')
  const campaign = await c.env.DB.prepare('SELECT * FROM campaigns WHERE id = ?').bind(id).first()
  if (!campaign) notFound('That campaign does not exist.')

  const { results } = await c.env.DB.prepare(
    `SELECT m.id, m.to_phone, m.status, m.error, m.sent_at,
            u.first_name, u.last_name
       FROM messages m LEFT JOIN users u ON u.id = m.user_id
      WHERE m.campaign_id = ? ORDER BY m.created_at LIMIT 500`,
  ).bind(id).all()

  return c.json({ campaign, messages: results ?? [] })
})

/** Stops a campaign mid-flight; already-sent messages cannot be recalled. */
messaging.post('/campaigns/:id/cancel', async (c) => {
  const id = c.req.param('id')
  const res = await c.env.DB.batch([
    c.env.DB.prepare(
      `UPDATE messages SET status = 'skipped', error = 'campaign cancelled'
         WHERE campaign_id = ? AND status = 'queued'`,
    ).bind(id),
    c.env.DB.prepare(
      `UPDATE campaigns SET status = 'cancelled', completed_at = ? WHERE id = ? AND status = 'sending'`,
    ).bind(nowSec(), id),
  ])
  const stopped = res[0]?.meta.changes ?? 0
  return c.json({ ok: true, stopped })
})

const directSchema = z.object({
  user_id: z.string().min(1),
  body: z.string().trim().min(1).max(1200),
})

/** One-to-one text from the back office — "running 10 minutes late". */
messaging.post('/send', async (c) => {
  const settings = await getSettings(c.env)
  const parsed = directSchema.safeParse(await c.req.json().catch(() => ({})))
  if (!parsed.success) badRequest('Write a message first.', 'invalid_input')

  const user = await c.env.DB.prepare(
    'SELECT id, first_name, last_name, phone, sms_opt_in FROM users WHERE id = ?',
  ).bind(parsed.data.user_id).first<{
    id: string; first_name: string; last_name: string; phone: string | null; sms_opt_in: number
  }>()
  if (!user) notFound('No such client.')
  if (!user.phone) badRequest('That client has no phone number on file.', 'no_phone')
  if (!user.sms_opt_in) conflict('That client has opted out of texts.', 'opted_out')

  const id = await queueMessage(c.env, {
    kind: 'transactional',
    userId: user.id,
    toPhone: user.phone,
    body: personalize(parsed.data.body, user, settings),
  })
  c.executionCtx.waitUntil(dispatchQueued(c.env, 5))

  return c.json({ ok: true, message_id: id }, 201)
})

messaging.get('/messages', async (c) => {
  const userId = c.req.query('user_id')
  const kind = c.req.query('kind')
  const { results } = await c.env.DB.prepare(
    `SELECT m.id, m.kind, m.to_phone, m.body, m.status, m.error, m.created_at, m.sent_at,
            u.first_name, u.last_name
       FROM messages m LEFT JOIN users u ON u.id = m.user_id
      WHERE (? IS NULL OR m.user_id = ?) AND (? IS NULL OR m.kind = ?)
      ORDER BY m.created_at DESC LIMIT 200`,
  ).bind(userId ?? null, userId ?? null, kind ?? null, kind ?? null).all()
  return c.json({ messages: results ?? [] })
})

/** Manual kick for the reminder sweep — handy for testing without waiting on cron. */
messaging.post('/reminders/run', async (c) => {
  const queued = await queueDueReminders(c.env)
  const sent = await dispatchQueued(c.env, 50)
  return c.json({ queued, ...sent })
})

export default messaging
