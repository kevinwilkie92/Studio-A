/**
 * Minimal E.164 normalization, biased to North America because that is where
 * the salon is. Anything already in `+<digits>` form is passed through, so
 * international clients still work if they enter the country code.
 */
export function normalizePhone(input: string | null | undefined, defaultCountry = '1'): string | null {
  if (!input) return null
  const trimmed = input.trim()
  if (!trimmed) return null

  const hadPlus = trimmed.startsWith('+')
  const digits = trimmed.replace(/\D/g, '')
  if (!digits) return null

  if (hadPlus) return digits.length >= 8 && digits.length <= 15 ? `+${digits}` : null
  if (digits.length === 10) return `+${defaultCountry}${digits}`
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`
  if (digits.length >= 11 && digits.length <= 15) return `+${digits}`
  return null
}

/** (804) 555-1234 — for the staff-facing UI. */
export function formatPhone(e164: string | null): string {
  if (!e164) return ''
  const m = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(e164)
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : e164
}
