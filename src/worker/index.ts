import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { secureHeaders } from 'hono/secure-headers'
import type { AppContext, Env } from './types'
import { loadUser } from './lib/auth'
import { dispatchQueued, queueDueReminders } from './lib/messaging'
import { nowSec } from './lib/time'

import authRoutes from './routes/auth'
import bookingRoutes from './routes/booking'
import paymentRoutes from './routes/payments'
import adminRoutes from './routes/admin'
import messagingRoutes from './routes/messaging'
import webhookRoutes from './routes/webhooks'

const app = new Hono<AppContext>()

app.use(
  '*',
  secureHeaders({
    contentSecurityPolicy: {
      defaultSrc: ["'self'"],
      // Stripe.js must load from Stripe and render its card fields in an iframe.
      scriptSrc: ["'self'", 'https://js.stripe.com'],
      frameSrc: ["'self'", 'https://js.stripe.com', 'https://hooks.stripe.com'],
      connectSrc: ["'self'", 'https://api.stripe.com'],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:', 'https:'],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'"],
    },
    referrerPolicy: 'strict-origin-when-cross-origin',
  }),
)

/**
 * Cookie auth plus a same-origin check on writes is this app's CSRF defence:
 * the session cookie is SameSite=Lax, and a cross-site form POST cannot set
 * these headers to a matching origin.
 */
app.use('/api/*', async (c, next) => {
  const method = c.req.method
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return next()

  const origin = c.req.header('origin')
  if (origin) {
    const expected = new URL(c.req.url).origin
    // `wrangler dev` is proxied from the Vite server, so localhost is allowed
    // through in development only.
    const isDev = c.env.APP_ENV !== 'production'
    const devOk = isDev && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)
    if (origin !== expected && !devOk) {
      return c.json({ error: { message: 'Cross-origin request blocked.', code: 'bad_origin' } }, 403)
    }
  }
  return next()
})

app.use('/api/*', loadUser)

app.route('/api/auth', authRoutes)
app.route('/api', bookingRoutes)
app.route('/api/payments', paymentRoutes)
app.route('/api/admin', adminRoutes)
app.route('/api/messaging', messagingRoutes)
app.route('/webhooks', webhookRoutes)

app.get('/api/health', (c) => c.json({ ok: true, ts: nowSec(), env: c.env.APP_ENV }))

app.notFound((c) =>
  c.req.path.startsWith('/api/') || c.req.path.startsWith('/webhooks/')
    ? c.json({ error: { message: 'No such endpoint.', code: 'not_found' } }, 404)
    : c.env.ASSETS.fetch(c.req.raw),
)

app.onError((err, c) => {
  if (err instanceof HTTPException) return err.getResponse()
  // Log the detail, return a generic message — stack traces are not for clients.
  console.error('unhandled error', err)
  return c.json({ error: { message: 'Something went wrong on our end.', code: 'internal_error' } }, 500)
})

export default {
  fetch: app.fetch,

  /**
   * Runs every 5 minutes (see `triggers.crons` in wrangler.jsonc).
   *
   * Queues reminders whose send moment has arrived, drains the outbound SMS
   * queue — which is also where mass texts live — and clears expired sessions.
   * Everything it does is idempotent, so an overlapping or retried run is safe.
   */
  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil((async () => {
      try {
        const queued = await queueDueReminders(env)
        const { sent, failed } = await dispatchQueued(env, 100)

        // Cheap housekeeping; expired rows are dead weight on every login.
        const purged = await env.DB.prepare('DELETE FROM sessions WHERE expires_at < ?').bind(nowSec()).run()

        console.log(
          `cron ${event.cron}: queued ${queued} reminder(s), sent ${sent}, failed ${failed}, ` +
          `purged ${purged.meta.changes} session(s)`,
        )
      } catch (err) {
        console.error('scheduled run failed', err)
      }
    })())
  },
} satisfies ExportedHandler<Env>
