# Studio A

Booking, payments, client notes and text messaging for a hair salon — one
Cloudflare Worker, one D1 database, no servers to keep alive.

| Need | How it works |
| --- | --- |
| Clients create an account | Email + password, sessions in an HttpOnly cookie |
| Clients book appointments | Live availability from real stylist hours, no double-booking |
| Clients choose their services | Multi-select menu; duration and price drive the slot length |
| Clients pay | Stripe Payment Element online, or cash/terminal recorded at the desk |
| You keep notes on clients | Staff-only notes with colour formulas, allergies, preferences |
| You send mass texts | Audience picker, live preview, segment count, one-tap confirm |
| Reminders go out on their own | Cron trigger every 5 minutes, deduplicated per appointment |

---

## Quick start

```bash
npm install

# 1. Create the database, then paste the printed id into wrangler.jsonc
npm run db:create

# 2. Build the schema and load the starter service menu
npm run db:migrate:local
npm run db:seed:local

# 3. Set a one-time token so you can create the owner account
cp .dev.vars.example .dev.vars   # then edit ADMIN_SETUP_TOKEN

# 4. Run it
npm run dev                      # Vite on :5173, Worker on :8787
```

Open http://localhost:5173 and create the owner account:

```bash
curl -X POST http://localhost:8787/api/admin/bootstrap \
  -H 'Content-Type: application/json' \
  -d '{"setup_token":"<your token>","email":"you@example.com",
       "password":"a-long-password","first_name":"Kevin","last_name":"Wilkie"}'
```

That endpoint refuses to run once an admin exists, so it closes itself after
first use. Sign in and the nav switches to the back office.

**Without Stripe or Twilio keys the app still runs end to end.** Texts are
recorded in the `messages` table and logged instead of sent, and the card
payment form reports that payments are switched off. You can walk the whole
flow before spending anything.

---

## Going live

```bash
npm run db:migrate            # schema on the real database
npm run db:seed               # starter services (once)

wrangler secret put STRIPE_SECRET_KEY
wrangler secret put STRIPE_PUBLISHABLE_KEY
wrangler secret put STRIPE_WEBHOOK_SECRET
wrangler secret put TWILIO_ACCOUNT_SID
wrangler secret put TWILIO_AUTH_TOKEN
wrangler secret put TWILIO_FROM_NUMBER
wrangler secret put ADMIN_SETUP_TOKEN        # remove after creating the owner

npm run deploy
```

Then point two webhooks at the deployed Worker:

| Provider | URL | Events |
| --- | --- | --- |
| Stripe | `https://<your-worker>/webhooks/stripe` | `payment_intent.succeeded`, `payment_intent.payment_failed`, `payment_intent.canceled`, `charge.refunded` |
| Twilio | `https://<your-worker>/webhooks/twilio/inbound` | Incoming messages (HTTP POST) |

Both verify signatures before doing anything, so an unsigned request is
rejected rather than trusted.

---

## How it fits together

```
Browser (React SPA, served as static assets)
   │  fetch /api/*  — session cookie, same-origin only
   ▼
Worker (Hono)  ──────────────►  D1 (SQLite)
   │                              users, appointments, services,
   │                              client_notes, payments, messages
   ├──► Stripe REST  (payment intents, refunds)
   ├──► Twilio REST  (outbound SMS)
   └──► cron, every 5 min: queue due reminders, drain the SMS queue
```

`src/worker/` is the API, `src/client/` is the front end, and both are typed
against the same `src/client/lib/api.ts` shapes.

### Things worth knowing

**Times.** Everything is stored as a UTC epoch in seconds. The salon works in
wall-clock time, so conversions go through the IANA timezone in settings.
`9:00 Tuesday` stays 9:00 across daylight saving; the tests pin both boundaries.

**Double-booking.** D1 has no serializable transaction spanning the
availability read and the insert, so `POST /api/appointments` writes the row,
re-checks for a clash, and rolls back if it lost the race. Two people tapping
the same Saturday slot get one booking and one honest error.

**Texts are queued, not sent inline.** A request has a wall-clock budget that
400 sequential Twilio calls do not fit inside. Campaign messages are written to
`messages` as `queued`; the cron handler drains them, and the endpoint kicks
off one pass via `waitUntil` so small blasts still feel instant. Reminders
carry a dedupe key of `reminder:<appointment>:<offset>h`, so an overlapping
cron run, a retry, or a mid-window redeploy cannot text someone twice.

**Opt-outs are enforced at the query.** `resolveAudience` filters on
`sms_opt_in` in SQL, so an accidental "everyone" blast cannot reach a client
who replied STOP. The Twilio webhook flips that flag and skips anything already
queued for them.

**Client notes are staff-only.** No client-facing endpoint reads
`client_notes`. `GET /api/admin/clients/:id` is behind the staff role check,
and the smoke test asserts a client gets a 403 reading notes about themselves.

**Money is integer cents,** never floats. `appointments.paid_cents` is
recomputed from settled payments rather than incremented, so a duplicate
webhook cannot inflate it.

---

## Checks

```bash
npm run typecheck   # worker and client, separate tsconfigs
npm test            # 67 unit tests: timezones, slot math, SMS rules
npm run build       # production bundle
```

There is also an end-to-end smoke test that drives a running dev server through
a full salon day — bootstrap, sign-up, booking, a double-book attempt, notes,
payment, a mass text, the reminder sweep, cancellation:

```bash
npx wrangler dev &
node scripts/smoke.mjs
```

---

## Where to change things

| You want to | Edit |
| --- | --- |
| Change services and prices | Back office → Settings, or `scripts/seed.sql` before seeding |
| Change opening hours | Back office → Settings → Hours |
| Change reminder timing | Back office → Settings → Reminders (default 24h and 2h) |
| Add a stylist | `POST /api/admin/staff`, then set their hours |
| Swap payment or SMS provider | `src/worker/lib/stripe.ts` / `src/worker/lib/sms.ts` — both sit behind a small interface |

### Known gaps

These are deliberate omissions, not oversights — say the word and they're
straightforward to add:

- **No password reset email.** There is no email provider wired up yet; an
  owner can reset a password from the database in the meantime.
- **No deposit enforcement at booking.** `services.deposit_cents` is stored and
  displayed, but booking does not yet require the deposit up front.
- **No rate limiting on login.** Worth adding before the app is public —
  Cloudflare's Rate Limiting rules can do it without code.
- **Service editing is API-only.** Settings can retire and restore services;
  creating and repricing goes through `POST /api/admin/services`.
