const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz'

/**
 * Prefixed, sortable-ish, URL-safe id: `appt_m3k2x9_a7f2c1`.
 * The middle chunk is a base-36 millisecond timestamp, so ids created later
 * sort later as plain strings — handy when reading rows by eye.
 */
export function newId(prefix: string): string {
  const time = Date.now().toString(36)
  const bytes = crypto.getRandomValues(new Uint8Array(8))
  let rand = ''
  for (const b of bytes) rand += ALPHABET[b % ALPHABET.length]
  return `${prefix}_${time}${rand}`
}
