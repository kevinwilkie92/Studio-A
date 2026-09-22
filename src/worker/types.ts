export interface Env {
  DB: D1Database
  ASSETS: Fetcher

  APP_ENV: string

  // Secrets — any of these may be absent, which puts that integration into
  // dry-run mode rather than breaking the request.
  STRIPE_SECRET_KEY?: string
  STRIPE_PUBLISHABLE_KEY?: string
  STRIPE_WEBHOOK_SECRET?: string
  TWILIO_ACCOUNT_SID?: string
  TWILIO_AUTH_TOKEN?: string
  TWILIO_FROM_NUMBER?: string
  TWILIO_MESSAGING_SERVICE_SID?: string
  ADMIN_SETUP_TOKEN?: string
}

export type Role = 'client' | 'staff' | 'admin'

export interface SessionUser {
  id: string
  email: string
  phone: string | null
  first_name: string
  last_name: string
  role: Role
  sms_opt_in: number
}

export interface AppContext {
  Bindings: Env
  Variables: {
    user: SessionUser | null
    sessionId: string | null
  }
}
