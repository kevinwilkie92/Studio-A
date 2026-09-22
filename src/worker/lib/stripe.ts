import type { Env } from '../types'
import { hexToBytes, hmacSha256Hex, timingSafeEqual } from './crypto'

const API = 'https://api.stripe.com/v1'

export interface PaymentIntent {
  id: string
  client_secret: string
  status: string
  amount: number
  currency: string
  metadata?: Record<string, string>
}

export class StripeError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) {
    super(message)
    this.name = 'StripeError'
  }
}

/**
 * Thin Stripe client over fetch. Only the handful of calls this app needs,
 * form-encoded the way the REST API expects (`a[b]=c` for nested values).
 */
export class Stripe {
  constructor(private readonly secretKey: string) {}

  private async request<T>(path: string, body?: Record<string, string>, idempotencyKey?: string): Promise<T> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.secretKey}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    }
    // Stripe replays the original response for a repeated key, so a retried
    // booking can never double-charge a client.
    if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey

    const res = await fetch(`${API}${path}`, {
      method: body ? 'POST' : 'GET',
      headers,
      body: body ? new URLSearchParams(body) : undefined,
    })
    const json = (await res.json().catch(() => ({}))) as { error?: { message?: string; code?: string } }
    if (!res.ok) {
      throw new StripeError(json.error?.message ?? 'Stripe request failed', res.status, json.error?.code)
    }
    return json as T
  }

  async createCustomer(params: { email: string; name: string; phone?: string | null }): Promise<{ id: string }> {
    const body: Record<string, string> = { email: params.email, name: params.name }
    if (params.phone) body.phone = params.phone
    return this.request<{ id: string }>('/customers', body)
  }

  async createPaymentIntent(params: {
    amountCents: number
    currency: string
    customerId?: string | null
    description: string
    metadata: Record<string, string>
    idempotencyKey: string
  }): Promise<PaymentIntent> {
    const body: Record<string, string> = {
      amount: String(params.amountCents),
      currency: params.currency,
      description: params.description,
      'automatic_payment_methods[enabled]': 'true',
    }
    if (params.customerId) body.customer = params.customerId
    for (const [k, v] of Object.entries(params.metadata)) body[`metadata[${k}]`] = v

    return this.request<PaymentIntent>('/payment_intents', body, params.idempotencyKey)
  }

  async getPaymentIntent(id: string): Promise<PaymentIntent> {
    return this.request<PaymentIntent>(`/payment_intents/${encodeURIComponent(id)}`)
  }

  async refund(paymentIntentId: string, amountCents?: number): Promise<{ id: string; status: string }> {
    const body: Record<string, string> = { payment_intent: paymentIntentId }
    if (amountCents != null) body.amount = String(amountCents)
    return this.request<{ id: string; status: string }>('/refunds', body)
  }
}

export function getStripe(env: Env): Stripe | null {
  return env.STRIPE_SECRET_KEY ? new Stripe(env.STRIPE_SECRET_KEY) : null
}

export interface StripeEvent {
  id: string
  type: string
  data: { object: Record<string, unknown> }
}

/**
 * Verifies the `Stripe-Signature` header and parses the event.
 *
 * Checks the timestamp against a tolerance so a captured webhook cannot be
 * replayed days later, and compares signatures in constant time.
 */
export async function parseWebhookEvent(
  rawBody: string, signatureHeader: string | null, secret: string, toleranceSec = 300,
): Promise<StripeEvent> {
  if (!signatureHeader) throw new StripeError('Missing Stripe-Signature header', 400)

  let timestamp = ''
  const signatures: string[] = []
  for (const part of signatureHeader.split(',')) {
    const [key, value] = part.split('=', 2)
    if (key?.trim() === 't' && value) timestamp = value.trim()
    if (key?.trim() === 'v1' && value) signatures.push(value.trim())
  }
  if (!timestamp || signatures.length === 0) throw new StripeError('Malformed Stripe-Signature header', 400)

  const age = Math.abs(Math.floor(Date.now() / 1000) - Number(timestamp))
  if (!Number.isFinite(age) || age > toleranceSec) throw new StripeError('Webhook timestamp outside tolerance', 400)

  const expected = hexToBytes(await hmacSha256Hex(secret, `${timestamp}.${rawBody}`))
  const matched = signatures.some((sig) => timingSafeEqual(hexToBytes(sig), expected))
  if (!matched) throw new StripeError('Webhook signature mismatch', 400)

  return JSON.parse(rawBody) as StripeEvent
}
