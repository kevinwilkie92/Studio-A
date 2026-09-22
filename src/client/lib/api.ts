export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly code: string | null) {
    super(message)
    this.name = 'ApiError'
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, {
    ...init,
    headers: {
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      ...init?.headers,
    },
    // Session lives in an HttpOnly cookie, so every call has to carry it.
    credentials: 'same-origin',
  })

  if (res.status === 204) return undefined as T

  const payload = await res.json().catch(() => null) as
    | (T & { error?: { message: string; code: string | null } })
    | null

  if (!res.ok) {
    throw new ApiError(
      payload?.error?.message ?? 'Something went wrong. Please try again.',
      res.status,
      payload?.error?.code ?? null,
    )
  }
  return payload as T
}

export const api = {
  get: <T,>(path: string) => request<T>(path),
  post: <T,>(path: string, body?: unknown) =>
    request<T>(path, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) }),
  patch: <T,>(path: string, body: unknown) =>
    request<T>(path, { method: 'PATCH', body: JSON.stringify(body) }),
  put: <T,>(path: string, body: unknown) =>
    request<T>(path, { method: 'PUT', body: JSON.stringify(body) }),
  del: <T,>(path: string) => request<T>(path, { method: 'DELETE' }),
}

// ------------------------------------------------------------------ types --

export interface User {
  id: string
  email: string
  phone: string | null
  first_name: string
  last_name: string
  role: 'client' | 'staff' | 'admin'
  sms_opt_in: number
  created_at: number
}

export interface Service {
  id: string
  name: string
  description: string
  category: string
  duration_min: number
  price_cents: number
  deposit_cents: number
  active: number
  sort_order: number
}

export interface StaffMember {
  id: string
  display_name: string
  title: string
  bio: string
  sort_order: number
}

export interface AppointmentService {
  service_id: string | null
  name: string
  duration_min: number
  price_cents: number
}

export interface Appointment {
  id: string
  client_id: string
  staff_id: string | null
  staff_name: string | null
  starts_at: number
  ends_at: number
  status: 'booked' | 'confirmed' | 'completed' | 'cancelled' | 'no_show'
  client_request: string
  total_cents: number
  paid_cents: number
  services: AppointmentService[]
  client_first_name?: string
  client_last_name?: string
  client_phone?: string | null
}

export interface Slot {
  start: number
  end: number
  staff: { id: string; name: string }[]
}

export interface Salon {
  name: string
  timezone: string
  currency: string
  address: string
  phone: string
  cancel_window_hours: number
  booking_lead_hours: number
  booking_horizon_days: number
}

export interface ClientNote {
  id: string
  body: string
  category: 'general' | 'formula' | 'allergy' | 'preference'
  pinned: number
  created_at: number
  updated_at: number
  appointment_id: string | null
  author_first_name?: string | null
  author_last_name?: string | null
}

export interface ClientSummary {
  id: string
  first_name: string
  last_name: string
  email: string
  phone: string | null
  sms_opt_in: number
  created_at: number
  visits: number
  last_visit: number | null
  next_visit: number | null
  note_count: number
}

export interface Payment {
  id: string
  appointment_id: string | null
  amount_cents: number
  tip_cents: number
  currency?: string
  kind?: string
  method: string
  status: string
  created_at: number
  starts_at?: number | null
}

export interface Campaign {
  id: string
  name: string
  body: string
  audience: string
  status: 'draft' | 'sending' | 'sent' | 'cancelled'
  recipient_count: number
  sent_count: number
  failed_count: number
  created_at: number
  completed_at: number | null
}
