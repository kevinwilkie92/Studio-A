import type { Env } from '../types'
import { hmacSha1Base64, timingSafeEqual } from './crypto'

export interface SmsResult {
  ok: boolean
  /** Provider-side message id, when the send was accepted. */
  ref?: string
  error?: string
  /** True when no provider is configured and the send was only recorded. */
  dryRun?: boolean
}

export interface SmsProvider {
  readonly name: string
  readonly configured: boolean
  send(to: string, body: string): Promise<SmsResult>
}

/**
 * Twilio over plain fetch — the official SDK pulls in Node built-ins that are
 * more trouble than a 20-line POST is worth on Workers.
 */
class TwilioProvider implements SmsProvider {
  readonly name = 'twilio'

  constructor(
    private readonly accountSid: string,
    private readonly authToken: string,
    private readonly from: string,
    private readonly messagingServiceSid?: string,
  ) {}

  get configured(): boolean {
    return Boolean(this.accountSid && this.authToken && (this.from || this.messagingServiceSid))
  }

  async send(to: string, body: string): Promise<SmsResult> {
    const form = new URLSearchParams({ To: to, Body: body })
    // A Messaging Service spreads a blast across a pool of numbers, which is
    // what you want once the client list outgrows one sender.
    if (this.messagingServiceSid) form.set('MessagingServiceSid', this.messagingServiceSid)
    else form.set('From', this.from)

    const auth = btoa(`${this.accountSid}:${this.authToken}`)
    let res: Response
    try {
      res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${this.accountSid}/Messages.json`, {
        method: 'POST',
        headers: {
          Authorization: `Basic ${auth}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: form,
      })
    } catch (err) {
      return { ok: false, error: `network: ${err instanceof Error ? err.message : String(err)}` }
    }

    const payload = (await res.json().catch(() => ({}))) as { sid?: string; message?: string; code?: number }
    if (!res.ok) {
      return { ok: false, error: `${payload.code ?? res.status}: ${payload.message ?? 'send failed'}` }
    }
    return { ok: true, ref: payload.sid }
  }
}

/** Records the send without calling anyone. Used when secrets are unset. */
class DryRunProvider implements SmsProvider {
  readonly name = 'dry-run'
  readonly configured = false

  async send(to: string, body: string): Promise<SmsResult> {
    console.log(`[sms dry-run] -> ${to}: ${body.replace(/\s+/g, ' ').slice(0, 120)}`)
    return { ok: true, dryRun: true, ref: `dryrun_${crypto.randomUUID()}` }
  }
}

export function getSmsProvider(env: Env): SmsProvider {
  const twilio = new TwilioProvider(
    env.TWILIO_ACCOUNT_SID ?? '',
    env.TWILIO_AUTH_TOKEN ?? '',
    env.TWILIO_FROM_NUMBER ?? '',
    env.TWILIO_MESSAGING_SERVICE_SID,
  )
  return twilio.configured ? twilio : new DryRunProvider()
}

const STOP_WORDS = new Set(['stop', 'stopall', 'unsubscribe', 'cancel', 'end', 'quit', 'revoke', 'optout'])
const START_WORDS = new Set(['start', 'unstop', 'yes', 'subscribe', 'optin'])

export type InboundIntent = 'stop' | 'start' | 'help' | 'other'

/** Carrier-mandated keywords. Handling these is not optional in the US. */
export function classifyInbound(body: string): InboundIntent {
  const word = body.trim().toLowerCase().replace(/[^a-z]/g, '')
  if (STOP_WORDS.has(word)) return 'stop'
  if (START_WORDS.has(word)) return 'start'
  if (word === 'help' || word === 'info') return 'help'
  return 'other'
}

/**
 * Twilio signs webhooks with HMAC-SHA1 over the URL plus the POST params
 * sorted by key and concatenated. Without this check anyone could POST a STOP
 * for another client's number.
 */
export async function verifyTwilioSignature(
  authToken: string, url: string, params: Record<string, string>, signature: string,
): Promise<boolean> {
  const data = url + Object.keys(params).sort().map((k) => k + params[k]).join('')
  const expected = await hmacSha1Base64(authToken, data)
  const enc = new TextEncoder()
  return timingSafeEqual(enc.encode(expected), enc.encode(signature))
}

/** Substitutes `{{first_name}}`-style placeholders in campaign copy. */
export function renderTemplate(body: string, vars: Record<string, string>): string {
  return body.replace(/\{\{\s*(\w+)\s*\}\}/g, (match, key: string) => vars[key] ?? match)
}

/**
 * GSM-7 fits 160 chars per segment, 153 when concatenated; any non-GSM
 * character forces UCS-2 at 70/67. Staff see this count before they send so a
 * stray emoji does not silently triple the bill.
 */
export function segmentCount(body: string): { segments: number; encoding: 'GSM-7' | 'UCS-2'; chars: number } {
  const gsm = /^[A-Za-z0-9@£$¥èéùìòÇØøÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&'()*+,\-./:;<=>?¡ÄÖÑÜ§¿äöñüà\n\r\f^{}\\[~\]|€]*$/
  const isGsm = gsm.test(body)
  const chars = body.length
  const single = isGsm ? 160 : 70
  const multi = isGsm ? 153 : 67
  const segments = chars === 0 ? 0 : chars <= single ? 1 : Math.ceil(chars / multi)
  return { segments, encoding: isGsm ? 'GSM-7' : 'UCS-2', chars }
}
