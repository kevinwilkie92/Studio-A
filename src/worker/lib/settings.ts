import type { Env } from '../types'

export interface SalonSettings {
  salon_name: string
  timezone: string
  currency: string
  slot_interval_min: number
  buffer_min: number
  booking_lead_hours: number
  booking_horizon_days: number
  cancel_window_hours: number
  /** Hours before the appointment to text a reminder, largest first. */
  reminder_offsets_hours: number[]
  /** Local hour after which reminders hold until morning (24h clock). */
  reminder_quiet_start: number
  reminder_quiet_end: number
  booking_confirmation_sms: boolean
  sms_footer: string
  address: string
  phone: string
}

const DEFAULTS: SalonSettings = {
  salon_name: 'Studio A',
  timezone: 'America/New_York',
  currency: 'usd',
  slot_interval_min: 15,
  buffer_min: 0,
  booking_lead_hours: 2,
  booking_horizon_days: 60,
  cancel_window_hours: 24,
  reminder_offsets_hours: [24, 2],
  reminder_quiet_start: 21,
  reminder_quiet_end: 9,
  booking_confirmation_sms: true,
  sms_footer: 'Reply STOP to opt out.',
  address: '',
  phone: '',
}

/** Keys an admin may write through the settings API. */
export const EDITABLE_SETTINGS = Object.keys(DEFAULTS) as (keyof SalonSettings)[]

function coerce(key: keyof SalonSettings, raw: string): unknown {
  const fallback = DEFAULTS[key]
  if (key === 'reminder_offsets_hours') {
    const list = raw.split(',').map((s) => Number(s.trim())).filter((n) => Number.isFinite(n) && n > 0)
    return list.length ? [...new Set(list)].sort((a, b) => b - a) : fallback
  }
  if (typeof fallback === 'number') {
    const n = Number(raw)
    return Number.isFinite(n) ? n : fallback
  }
  if (typeof fallback === 'boolean') return raw === '1' || raw === 'true'
  return raw
}

export function serializeSetting(key: keyof SalonSettings, value: unknown): string {
  if (key === 'reminder_offsets_hours') {
    return Array.isArray(value) ? value.join(',') : String(value)
  }
  if (typeof DEFAULTS[key] === 'boolean') return value ? '1' : '0'
  return String(value)
}

/**
 * Settings live in D1 but are read on nearly every request, so each isolate
 * caches them briefly. A save bumps the version, and other isolates pick the
 * change up within the TTL.
 */
const CACHE_TTL_MS = 30_000
let cached: { at: number; value: SalonSettings } | null = null

export async function getSettings(env: Env): Promise<SalonSettings> {
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.value

  const { results } = await env.DB.prepare('SELECT key, value FROM settings').all<{ key: string; value: string }>()
  const merged = { ...DEFAULTS }
  for (const row of results) {
    if (row.key in DEFAULTS) {
      // Each key's type is pinned by DEFAULTS; coerce returns that type.
      ;(merged as Record<string, unknown>)[row.key] = coerce(row.key as keyof SalonSettings, row.value)
    }
  }
  cached = { at: Date.now(), value: merged }
  return merged
}

export function invalidateSettingsCache(): void {
  cached = null
}
