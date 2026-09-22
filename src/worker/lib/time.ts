/**
 * Timezone helpers.
 *
 * Everything is stored as a UTC epoch in seconds. The salon works in wall-clock
 * time ("Tuesdays 9-6"), so every conversion between the two goes through the
 * salon's IANA timezone from settings. Workers ships full ICU, so `Intl` does
 * the DST bookkeeping and we never hand-roll an offset table.
 */

export interface ZonedParts {
  year: number
  month: number // 1-12
  day: number   // 1-31
  hour: number
  minute: number
  weekday: number // 0 = Sunday
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

const partsFormatterCache = new Map<string, Intl.DateTimeFormat>()

function partsFormatter(timeZone: string): Intl.DateTimeFormat {
  let fmt = partsFormatterCache.get(timeZone)
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      weekday: 'short',
    })
    partsFormatterCache.set(timeZone, fmt)
  }
  return fmt
}

/** Wall-clock parts of a UTC instant, as seen in `timeZone`. */
export function toZonedParts(epochSec: number, timeZone: string): ZonedParts {
  const parts = partsFormatter(timeZone).formatToParts(new Date(epochSec * 1000))
  const map: Record<string, string> = {}
  for (const p of parts) if (p.type !== 'literal') map[p.type] = p.value

  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    hour: Number(map.hour) % 24,
    minute: Number(map.minute),
    weekday: Math.max(0, WEEKDAYS.indexOf(map.weekday ?? 'Sun')),
  }
}

/** Offset in seconds that `timeZone` is ahead of UTC at the given instant. */
function offsetSecAt(epochSec: number, timeZone: string): number {
  const p = toZonedParts(epochSec, timeZone)
  const parts = partsFormatter(timeZone).formatToParts(new Date(epochSec * 1000))
  const second = Number(parts.find((x) => x.type === 'second')?.value ?? '0')
  const asIfUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, second) / 1000
  return Math.round(asIfUtc - epochSec)
}

/**
 * Wall-clock time in `timeZone` -> UTC epoch seconds.
 *
 * Resolved in two passes: guess with the offset at the naive instant, then
 * re-check the offset at the candidate. That converges for every real zone,
 * including across a DST boundary. Times inside a spring-forward gap (which
 * do not exist locally) land on the instant just after the jump.
 */
export function zonedToEpoch(
  year: number, month: number, day: number,
  minutesFromMidnight: number, timeZone: string,
): number {
  const naive = Date.UTC(year, month - 1, day, 0, 0, 0) / 1000 + minutesFromMidnight * 60
  let guess = naive - offsetSecAt(naive, timeZone)
  guess = naive - offsetSecAt(guess, timeZone)
  return guess
}

/** Parse `YYYY-MM-DD` into its numeric parts. Returns null when malformed. */
export function parseDateKey(key: string): { year: number; month: number; day: number } | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key)
  if (!m) return null
  const year = Number(m[1]), month = Number(m[2]), day = Number(m[3])
  if (month < 1 || month > 12 || day < 1 || day > 31) return null
  return { year, month, day }
}

/** `YYYY-MM-DD` for a UTC instant as seen in `timeZone`. */
export function dateKey(epochSec: number, timeZone: string): string {
  const p = toZonedParts(epochSec, timeZone)
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`
}

/** Start and end of a local calendar day, as UTC epoch seconds. */
export function dayBounds(dateKeyStr: string, timeZone: string): { start: number; end: number } | null {
  const d = parseDateKey(dateKeyStr)
  if (!d) return null
  return {
    start: zonedToEpoch(d.year, d.month, d.day, 0, timeZone),
    end: zonedToEpoch(d.year, d.month, d.day + 1, 0, timeZone),
  }
}

/** "Tue, Mar 4 at 2:30 PM" — used in reminder and confirmation texts. */
export function formatLocal(epochSec: number, timeZone: string): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(epochSec * 1000)).replace(/,([^,]*)$/, ' at$1')
}

export function nowSec(): number {
  return Math.floor(Date.now() / 1000)
}
