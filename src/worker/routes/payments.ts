import { Hono } from 'hono'
import { z } from 'zod'
import type { AppContext, Env } from '../types'
import { newId } from '../lib/ids'
import { requireAuth, requireStaff } from '../lib/auth'
import { badRequest, conflict, forbidden, notFound } from '../lib/http'
import { getSettings } from '../lib/settings'
import { nowSec } from '../lib/time'
import { getStripe, StripeError } from '../lib/stripe'

const payments = new Hono<AppContext>()

const intentSchema = z.object({
  appointment_id: z.string().min(1),
  /** Omit to pay the outstanding balance in full. */
  amount_cents: z.number().int().positive().max(2_000_000).optional(),
  tip_cents: z.number().int().min(0).max(2_000_000).default(0),
  kind: z.enum(['deposit', 'balance', 'full']).default('balance'),
})

/**
 * Creates (or reuses) a Stripe PaymentIntent for an appointment and returns the
 * client secret for Stripe.js to confirm in the browser. The card never touches
 * this Worker.
 */
payments.post('/intent', requireAuth, async (c) => {
  const user = c.var.user!
  const settings = await getSettings(c.env)
  const stripe = getStripe(c.env)
  if (!stripe) badRequest('Card payments are not switched on yet.', 'payments_unconfigured')

  const parsed = intentSchema.safeParse(await c.req.json().catch(() => ({})))
  if (!parsed.success) badRequest(parsed.error.issues[0]?.message ?? 'Check the payment details.', 'invalid_input')
  const input = parsed.data

  const appt = await c.env.DB.prepare(
    `SELECT a.id, a.client_id, a.status, a.total_cents, a.paid_cents, a.starts_at,
            u.email, u.first_name, u.last_name, u.phone, u.stripe_customer_id
       FROM appointments a JOIN users u ON u.id = a.client_id
      WHERE a.id = ?`,
  ).bind(input.appointment_id).first<{
    id: string; client_id: string; status: string; total_cents: number; paid_cents: number; starts_at: number
    email: string; first_name: string; last_name: string; phone: string | null; stripe_customer_id: string | null
  }>()

  if (!appt) notFound('That appointment does not exist.')
  if (appt.client_id !== user.id && !isStaff(c)) forbidden()
  if (appt.status === 'cancelled') badRequest('That appointment was cancelled.', 'appointment_cancelled')

  const outstanding = Math.max(0, appt.total_cents - appt.paid_cents)
  const base = input.amount_cents ?? outstanding
  if (base <= 0 && input.tip_cents <= 0) conflict('This appointment is already paid in full.', 'already_paid')
  if (base > outstanding) badRequest('That is more than the outstanding balance.', 'amount_too_large')

  const chargeCents = base + input.tip_cents
  if (chargeCents < 50) badRequest('Card payments must be at least $0.50.', 'amount_too_small')

  // One Stripe customer per client, so saved cards and receipts line up.
  let customerId = appt.stripe_customer_id
  try {
    if (!customerId) {
      const customer = await stripe.createCustomer({
        email: appt.email,
        name: `${appt.first_name} ${appt.last_name}`.trim(),
        phone: appt.phone,
      })
      customerId = customer.id
      await c.env.DB.prepare('UPDATE users SET stripe_customer_id = ?, updated_at = ? WHERE id = ?')
        .bind(customerId, nowSec(), appt.client_id).run()
    }

    const paymentId = newId('pay')
    const intent = await stripe.createPaymentIntent({
      amountCents: chargeCents,
      currency: settings.currency,
      customerId,
      description: `${settings.salon_name} — appointment ${appt.id}`,
      metadata: {
        appointment_id: appt.id,
        client_id: appt.client_id,
        payment_id: paymentId,
        tip_cents: String(input.tip_cents),
        base_cents: String(base),
      },
      // Keyed on the exact charge, so a double-tapped Pay button reuses the
      // same intent instead of creating a second one.
      idempotencyKey: `pi:${appt.id}:${input.kind}:${chargeCents}:${appt.paid_cents}`,
    })

    const now = nowSec()
    await c.env.DB.prepare(
      `INSERT INTO payments
         (id, appointment_id, client_id, amount_cents, tip_cents, currency, kind, method,
          status, provider, provider_ref, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'card', 'pending', 'stripe', ?, ?, ?)
       ON CONFLICT (provider, provider_ref) DO UPDATE SET
         amount_cents = excluded.amount_cents,
         tip_cents    = excluded.tip_cents,
         updated_at   = excluded.updated_at`,
    ).bind(
      paymentId, appt.id, appt.client_id, base, input.tip_cents,
      settings.currency, input.kind, intent.id, now, now,
    ).run()

    return c.json({
      client_secret: intent.client_secret,
      publishable_key: c.env.STRIPE_PUBLISHABLE_KEY ?? null,
      amount_cents: chargeCents,
      currency: settings.currency,
    })
  } catch (err) {
    if (err instanceof StripeError) badRequest(err.message, err.code ?? 'stripe_error')
    throw err
  }
})

/**
 * Confirms a payment straight from the browser after Stripe.js reports success,
 * so the receipt appears immediately instead of waiting on the webhook. The
 * webhook remains the authority — both paths funnel through `settlePayment`,
 * which is idempotent.
 */
payments.post('/confirm', requireAuth, async (c) => {
  const user = c.var.user!
  const stripe = getStripe(c.env)
  if (!stripe) badRequest('Card payments are not switched on yet.', 'payments_unconfigured')

  const body = await c.req.json().catch(() => ({})) as { payment_intent_id?: string }
  if (!body.payment_intent_id) badRequest('Missing payment_intent_id.', 'invalid_input')

  const row = await c.env.DB.prepare(
    'SELECT id, client_id FROM payments WHERE provider = ? AND provider_ref = ?',
  ).bind('stripe', body.payment_intent_id).first<{ id: string; client_id: string }>()
  if (!row) notFound('We have no record of that payment.')
  if (row.client_id !== user.id && !isStaff(c)) forbidden()

  const intent = await stripe.getPaymentIntent(body.payment_intent_id)
  await settlePayment(c.env, intent.id, intent.status)

  const payment = await c.env.DB.prepare('SELECT * FROM payments WHERE id = ?').bind(row.id).first()
  return c.json({ payment })
})

payments.get('/', requireAuth, async (c) => {
  const user = c.var.user!
  const apptId = c.req.query('appointment_id')

  const where = isStaff(c) && apptId ? 'p.appointment_id = ?' : 'p.client_id = ?'
  const bind = isStaff(c) && apptId ? apptId : user.id

  const { results } = await c.env.DB.prepare(
    `SELECT p.id, p.appointment_id, p.amount_cents, p.tip_cents, p.currency, p.kind,
            p.method, p.status, p.created_at, a.starts_at
       FROM payments p
       LEFT JOIN appointments a ON a.id = p.appointment_id
      WHERE ${where} AND p.status IN ('succeeded', 'refunded', 'pending')
      ORDER BY p.created_at DESC LIMIT 100`,
  ).bind(bind).all()

  return c.json({ payments: results ?? [] })
})

// ------------------------------------------------ in-salon (staff only) ----

const manualSchema = z.object({
  appointment_id: z.string().min(1),
  amount_cents: z.number().int().min(0).max(2_000_000),
  tip_cents: z.number().int().min(0).max(2_000_000).default(0),
  method: z.enum(['cash', 'card', 'other']).default('cash'),
  note: z.string().trim().max(200).optional(),
})

/** Records a payment taken at the front desk — cash, or a card on the salon's own terminal. */
payments.post('/manual', requireStaff, async (c) => {
  const actor = c.var.user!
  const settings = await getSettings(c.env)

  const parsed = manualSchema.safeParse(await c.req.json().catch(() => ({})))
  if (!parsed.success) badRequest(parsed.error.issues[0]?.message ?? 'Check the payment details.', 'invalid_input')
  const input = parsed.data
  if (input.amount_cents + input.tip_cents <= 0) badRequest('Enter an amount.', 'invalid_amount')

  const appt = await c.env.DB.prepare(
    'SELECT id, client_id, total_cents, paid_cents FROM appointments WHERE id = ?',
  ).bind(input.appointment_id).first<{ id: string; client_id: string; total_cents: number; paid_cents: number }>()
  if (!appt) notFound('That appointment does not exist.')

  const now = nowSec()
  const id = newId('pay')
  await c.env.DB.prepare(
    `INSERT INTO payments
       (id, appointment_id, client_id, amount_cents, tip_cents, currency, kind, method,
        status, provider, failure_reason, recorded_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'balance', ?, 'succeeded', 'in_salon', ?, ?, ?, ?)`,
  ).bind(
    id, appt.id, appt.client_id, input.amount_cents, input.tip_cents, settings.currency,
    input.method, input.note ?? null, actor.id, now, now,
  ).run()

  await recomputePaid(c.env, appt.id)
  const payment = await c.env.DB.prepare('SELECT * FROM payments WHERE id = ?').bind(id).first()
  return c.json({ payment }, 201)
})

const refundSchema = z.object({ amount_cents: z.number().int().positive().optional() })

payments.post('/:id/refund', requireStaff, async (c) => {
  const id = c.req.param('id')
  const parsed = refundSchema.safeParse(await c.req.json().catch(() => ({})))
  if (!parsed.success) badRequest('Check the refund amount.', 'invalid_input')

  const payment = await c.env.DB.prepare(
    'SELECT id, appointment_id, provider, provider_ref, status, amount_cents, tip_cents FROM payments WHERE id = ?',
  ).bind(id).first<{
    id: string; appointment_id: string | null; provider: string; provider_ref: string | null
    status: string; amount_cents: number; tip_cents: number
  }>()
  if (!payment) notFound('That payment does not exist.')
  if (payment.status !== 'succeeded') badRequest('Only settled payments can be refunded.', 'not_refundable')

  if (payment.provider === 'stripe' && payment.provider_ref) {
    const stripe = getStripe(c.env)
    if (!stripe) badRequest('Stripe is not configured, so this cannot be refunded here.', 'payments_unconfigured')
    try {
      await stripe.refund(payment.provider_ref, parsed.data.amount_cents)
    } catch (err) {
      if (err instanceof StripeError) badRequest(err.message, err.code ?? 'stripe_error')
      throw err
    }
  }

  await c.env.DB.prepare("UPDATE payments SET status = 'refunded', updated_at = ? WHERE id = ?")
    .bind(nowSec(), id).run()
  if (payment.appointment_id) await recomputePaid(c.env, payment.appointment_id)

  return c.json({ ok: true })
})

// ------------------------------------------------------------- helpers -----

/**
 * Moves a payment to its terminal state and refreshes the appointment total.
 *
 * Called from both the browser confirm and the Stripe webhook; whichever
 * arrives first wins and the other is a no-op, because the update is scoped to
 * rows still in `pending`.
 */
export async function settlePayment(env: Env, paymentIntentId: string, stripeStatus: string): Promise<void> {
  const status = stripeStatus === 'succeeded'
    ? 'succeeded'
    : stripeStatus === 'canceled'
      ? 'cancelled'
      : stripeStatus === 'requires_payment_method' || stripeStatus === 'payment_failed'
        ? 'failed'
        : null
  if (!status) return

  const row = await env.DB.prepare(
    'SELECT id, appointment_id, status FROM payments WHERE provider = ? AND provider_ref = ?',
  ).bind('stripe', paymentIntentId).first<{ id: string; appointment_id: string | null; status: string }>()
  if (!row || row.status === status) return

  await env.DB.prepare("UPDATE payments SET status = ?, updated_at = ? WHERE id = ? AND status = 'pending'")
    .bind(status, nowSec(), row.id).run()

  if (row.appointment_id) await recomputePaid(env, row.appointment_id)
}

/** Recomputes `appointments.paid_cents` from settled payments, tips included. */
export async function recomputePaid(env: Env, appointmentId: string): Promise<void> {
  await env.DB.prepare(
    `UPDATE appointments
        SET paid_cents = COALESCE((
              SELECT SUM(amount_cents + tip_cents) FROM payments
               WHERE appointment_id = ? AND status = 'succeeded'), 0),
            updated_at = ?
      WHERE id = ?`,
  ).bind(appointmentId, nowSec(), appointmentId).run()
}

function isStaff(c: { var: AppContext['Variables'] }): boolean {
  return c.var.user?.role === 'staff' || c.var.user?.role === 'admin'
}

export default payments
