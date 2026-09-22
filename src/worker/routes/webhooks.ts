import { Hono } from 'hono'
import type { AppContext } from '../types'
import { parseWebhookEvent, StripeError } from '../lib/stripe'
import { classifyInbound, verifyTwilioSignature } from '../lib/sms'
import { newId } from '../lib/ids'
import { nowSec } from '../lib/time'
import { getSettings } from '../lib/settings'
import { settlePayment } from './payments'

const webhooks = new Hono<AppContext>()

/**
 * Stripe payment events. The signature check is the authentication — there is
 * no session here — so an unverifiable body is rejected before it is parsed.
 */
webhooks.post('/stripe', async (c) => {
  const secret = c.env.STRIPE_WEBHOOK_SECRET
  if (!secret) return c.json({ error: 'Stripe webhooks are not configured.' }, 503)

  const raw = await c.req.text()
  let event
  try {
    event = await parseWebhookEvent(raw, c.req.header('stripe-signature') ?? null, secret)
  } catch (err) {
    const message = err instanceof StripeError ? err.message : 'Invalid webhook'
    return c.json({ error: message }, 400)
  }

  switch (event.type) {
    case 'payment_intent.succeeded':
    case 'payment_intent.payment_failed':
    case 'payment_intent.canceled': {
      const intent = event.data.object as { id?: string; status?: string }
      if (intent.id && intent.status) await settlePayment(c.env, intent.id, intent.status)
      break
    }
    case 'charge.refunded': {
      const charge = event.data.object as { payment_intent?: string }
      if (charge.payment_intent) {
        await c.env.DB.prepare(
          "UPDATE payments SET status = 'refunded', updated_at = ? WHERE provider = 'stripe' AND provider_ref = ?",
        ).bind(nowSec(), charge.payment_intent).run()
      }
      break
    }
    default:
      // Unhandled event types are acknowledged so Stripe stops retrying them.
      break
  }

  return c.json({ received: true })
})

/**
 * Inbound SMS from Twilio. STOP/START are legally required to work, so this
 * endpoint is the opt-out switch: it flips `sms_opt_in`, which every audience
 * query already filters on.
 */
webhooks.post('/twilio/inbound', async (c) => {
  const authToken = c.env.TWILIO_AUTH_TOKEN
  if (!authToken) return c.text('<Response/>', 200, { 'Content-Type': 'text/xml' })

  const form = await c.req.formData()
  const params: Record<string, string> = {}
  for (const [key, value] of form.entries()) params[key] = String(value)

  const signature = c.req.header('x-twilio-signature') ?? ''
  const valid = await verifyTwilioSignature(authToken, c.req.url, params, signature)
  if (!valid) return c.text('Invalid signature', 403)

  const from = params.From ?? ''
  const body = params.Body ?? ''
  if (!from) return c.text('<Response/>', 200, { 'Content-Type': 'text/xml' })

  const settings = await getSettings(c.env)
  const user = await c.env.DB.prepare('SELECT id FROM users WHERE phone = ?').bind(from).first<{ id: string }>()

  await c.env.DB.prepare(
    `INSERT INTO messages (id, kind, user_id, to_phone, body, status, provider, provider_ref, created_at, sent_at)
     VALUES (?, 'inbound', ?, ?, ?, 'received', 'twilio', ?, ?, ?)`,
  ).bind(newId('msg'), user?.id ?? null, from, body, params.MessageSid ?? null, nowSec(), nowSec()).run()

  const intent = classifyInbound(body)
  let reply = ''

  if (intent === 'stop' && user) {
    await c.env.DB.prepare('UPDATE users SET sms_opt_in = 0, sms_opt_out_at = ?, updated_at = ? WHERE id = ?')
      .bind(nowSec(), nowSec(), user.id).run()
    // Drop anything already queued for them.
    await c.env.DB.prepare(
      "UPDATE messages SET status = 'skipped', error = 'recipient opted out' WHERE user_id = ? AND status = 'queued'",
    ).bind(user.id).run()
    // Twilio's Advanced Opt-Out sends the confirmation itself; staying silent
    // here avoids a duplicate.
  } else if (intent === 'start' && user) {
    await c.env.DB.prepare('UPDATE users SET sms_opt_in = 1, sms_opt_out_at = NULL, updated_at = ? WHERE id = ?')
      .bind(nowSec(), user.id).run()
    reply = `${settings.salon_name}: You're subscribed to appointment texts again.`
  } else if (intent === 'help') {
    reply = `${settings.salon_name}: Appointment reminders and updates.` +
      (settings.phone ? ` Call ${settings.phone} for help.` : '') + ' Reply STOP to opt out.'
  }

  const xml = reply
    ? `<?xml version="1.0" encoding="UTF-8"?><Response><Message>${escapeXml(reply)}</Message></Response>`
    : '<?xml version="1.0" encoding="UTF-8"?><Response/>'
  return c.text(xml, 200, { 'Content-Type': 'text/xml' })
})

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;')
}

export default webhooks
