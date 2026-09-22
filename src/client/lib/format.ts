/**
 * All server times are UTC epoch seconds. Formatting pins the salon's timezone
 * so a client travelling in another zone still sees salon-local times.
 */
let salonTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone

export function setTimeZone(tz: string): void {
  if (tz) salonTimeZone = tz
}

export function getTimeZone(): string {
  return salonTimeZone
}

function fmt(options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat('en-US', { timeZone: salonTimeZone, ...options })
}

export function money(cents: number, currency = 'usd'): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: currency.toUpperCase(),
    minimumFractionDigits: cents % 100 === 0 ? 0 : 2,
  }).format(cents / 100)
}

export const timeOf = (epochSec: number): string =>
  fmt({ hour: 'numeric', minute: '2-digit' }).format(new Date(epochSec * 1000))

export const dateOf = (epochSec: number): string =>
  fmt({ weekday: 'short', month: 'short', day: 'numeric' }).format(new Date(epochSec * 1000))

export const longDate = (epochSec: number): string =>
  fmt({ weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }).format(new Date(epochSec * 1000))

export const dateTime = (epochSec: number): string => `${dateOf(epochSec)} · ${timeOf(epochSec)}`

/** `YYYY-MM-DD` in the salon's timezone — the key the availability API expects. */
export function dateKey(date: Date): string {
  const parts = fmt({ year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date)
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? ''
  return `${get('year')}-${get('month')}-${get('day')}`
}

export function addDays(key: string, days: number): string {
  const [y, m, d] = key.split('-').map(Number)
  const date = new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1))
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString().slice(0, 10)
}

export function duration(minutes: number): string {
  if (minutes < 60) return `${minutes} min`
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  return m === 0 ? `${h} hr` : `${h} hr ${m} min`
}

export function relativeDay(key: string): string {
  const today = dateKey(new Date())
  if (key === today) return 'Today'
  if (key === addDays(today, 1)) return 'Tomorrow'
  const [y, m, d] = key.split('-').map(Number)
  return new Intl.DateTimeFormat('en-US', {
    weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC',
  }).format(new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1)))
}

export function phoneDisplay(e164: string | null | undefined): string {
  if (!e164) return ''
  const m = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(e164)
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : e164
}

export function initials(first: string, last: string): string {
  return `${first.charAt(0)}${last.charAt(0)}`.toUpperCase() || '?'
}
