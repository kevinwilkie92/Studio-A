/**
 * End-to-end smoke test against a running `wrangler dev`.
 *
 *   npx wrangler dev &
 *   node scripts/smoke.mjs
 *
 * Walks the paths a real salon day takes: an owner bootstraps, a client signs
 * up and books, staff leave a note and take payment, a mass text goes out and
 * the reminder sweep runs. Exits non-zero on the first failure.
 */
const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:8787'
const SETUP_TOKEN = process.env.ADMIN_SETUP_TOKEN ?? 'local-setup-token'

let passed = 0
const jars = new Map()

function jar(name) {
  if (!jars.has(name)) jars.set(name, new Map())
  return jars.get(name)
}

async function call(who, method, path, body) {
  const cookies = jar(who)
  const headers = { Origin: BASE }
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  if (cookies.size) headers.Cookie = [...cookies].map(([k, v]) => `${k}=${v}`).join('; ')

  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  })

  for (const raw of res.headers.getSetCookie?.() ?? []) {
    const [pair] = raw.split(';')
    const idx = pair.indexOf('=')
    cookies.set(pair.slice(0, idx), pair.slice(idx + 1))
  }

  const text = await res.text()
  let json = null
  try { json = JSON.parse(text) } catch { /* non-JSON body */ }
  return { status: res.status, body: json, text }
}

function check(label, condition, detail) {
  if (condition) {
    passed++
    console.log(`  ✓ ${label}`)
  } else {
    console.error(`  ✗ ${label}`)
    if (detail !== undefined) console.error(`    ${JSON.stringify(detail)}`)
    process.exitCode = 1
    throw new Error(`failed: ${label}`)
  }
}

function section(name) {
  console.log(`\n${name}`)
}

const stamp = Date.now()
const owner = { email: `owner+${stamp}@studio-a.test`, password: 'owner-password-123' }
const client = { email: `client+${stamp}@studio-a.test`, password: 'client-password-123' }

async function main() {
  section('Health')
  {
    const res = await call('anon', 'GET', '/api/health')
    check('health responds', res.status === 200 && res.body.ok === true, res.body)
  }

  section('Owner bootstrap')
  {
    const res = await call('owner', 'POST', '/api/admin/bootstrap', {
      setup_token: SETUP_TOKEN, email: owner.email, password: owner.password,
      first_name: 'Kevin', last_name: 'Wilkie',
    })
    // A second run against the same database finds an admin already there.
    check('bootstrap creates or already has an admin', res.status === 201 || res.status === 409, res.body)
    if (res.status === 409) {
      const login = await call('owner', 'POST', '/api/auth/login', owner)
      check('existing owner can sign in', login.status === 200, login.body)
    }
  }

  section('Public catalog')
  let services
  {
    const res = await call('anon', 'GET', '/api/services')
    services = res.body.services
    check('services are listed', res.status === 200 && services.length > 0, res.body)
    check('every service has a price and duration',
      services.every((s) => s.price_cents >= 0 && s.duration_min > 0))
  }

  section('Client account')
  {
    const res = await call('client', 'POST', '/api/auth/register', {
      email: client.email, password: client.password,
      first_name: 'Dana', last_name: 'Reyes', phone: '(804) 555-0117', sms_opt_in: true,
    })
    check('registration succeeds', res.status === 201, res.body)
    check('phone is normalized to E.164', res.body.user.phone === '+18045550117', res.body.user)

    const dup = await call('anon', 'POST', '/api/auth/register', {
      email: client.email, password: 'another-password', first_name: 'Imposter',
    })
    check('duplicate email is rejected', dup.status === 409, dup.body)

    const bad = await call('anon', 'POST', '/api/auth/login', { email: client.email, password: 'wrong' })
    check('wrong password is rejected', bad.status === 401, bad.body)

    const me = await call('client', 'GET', '/api/auth/me')
    check('session cookie identifies the client', me.body.user?.email === client.email, me.body)
  }

  section('Authorization')
  {
    const res = await call('client', 'GET', '/api/admin/clients')
    check('clients cannot reach the back office', res.status === 403, res.body)

    const anon = await call('anon', 'GET', '/api/appointments')
    check('signed-out visitors cannot list appointments', anon.status === 401, anon.body)
  }

  section('Availability and booking')
  const cut = services.find((s) => s.duration_min <= 60) ?? services[0]
  let slot
  let appointmentId
  {
    // Walk forward until a day the salon is actually open.
    let date
    for (let i = 1; i <= 14 && !slot; i++) {
      date = new Date(Date.now() + i * 86400_000).toISOString().slice(0, 10)
      const res = await call('client', 'GET', `/api/availability?date=${date}&services=${cut.id}`)
      check(`availability for ${date} responds`, res.status === 200, res.body)
      slot = res.body.slots[0]
    }
    check('some open slot exists in the next two weeks', Boolean(slot))

    const noServices = await call('client', 'GET', `/api/availability?date=${date}`)
    check('availability requires services', noServices.status === 400, noServices.body)

    const res = await call('client', 'POST', '/api/appointments', {
      service_ids: [cut.id], starts_at: slot.start,
      staff_id: slot.staff[0].id, client_request: 'A little off the ends, please.',
    })
    check('booking succeeds', res.status === 201, res.body)
    appointmentId = res.body.appointment.id
    check('total matches the service price', res.body.appointment.total_cents === cut.price_cents, res.body.appointment)
    check('the line item was snapshotted', res.body.appointment.services[0].name === cut.name)

    const dup = await call('client', 'POST', '/api/appointments', {
      service_ids: [cut.id], starts_at: slot.start, staff_id: slot.staff[0].id,
    })
    check('the same slot cannot be double-booked', dup.status === 409, dup.body)

    const after = await call('client', 'GET', `/api/availability?date=${new Date(slot.start * 1000).toISOString().slice(0, 10)}&services=${cut.id}`)
    check('the booked slot disappears from availability',
      !after.body.slots.some((s) => s.start === slot.start), after.body.slots?.slice(0, 3))

    const past = await call('client', 'POST', '/api/appointments', {
      service_ids: [cut.id], starts_at: Math.floor(Date.now() / 1000) + 60,
    })
    check('booking inside the lead time is refused', past.status === 400, past.body)
  }

  section('Client privacy')
  {
    const other = await call('owner', 'GET', `/api/appointments/${appointmentId}`)
    check('staff can read any appointment', other.status === 200, other.body)

    const mine = await call('client', 'GET', '/api/appointments?scope=upcoming')
    check('the client sees their own booking',
      mine.body.appointments.some((a) => a.id === appointmentId), mine.body)
  }

  section('Client notes (staff only)')
  let clientId
  {
    const list = await call('owner', 'GET', '/api/admin/clients?q=Dana')
    const found = list.body.clients.find((c) => c.email === client.email)
    check('the new client appears in the roster', Boolean(found), list.body)
    clientId = found.id

    const note = await call('owner', 'POST', `/api/admin/clients/${clientId}/notes`, {
      body: '6N + 10 vol, 35 min. Sensitive scalp.', category: 'formula', pinned: true,
    })
    check('a note can be added', note.status === 201, note.body)

    const detail = await call('owner', 'GET', `/api/admin/clients/${clientId}`)
    check('the note is returned with the client', detail.body.notes.length === 1, detail.body.notes)
    check('the note carries its category', detail.body.notes[0].category === 'formula')

    const blocked = await call('client', 'GET', `/api/admin/clients/${clientId}`)
    check('clients cannot read notes about themselves', blocked.status === 403, blocked.body)
  }

  section('Payments')
  {
    const manual = await call('owner', 'POST', '/api/payments/manual', {
      appointment_id: appointmentId, amount_cents: cut.price_cents, tip_cents: 1000, method: 'cash',
    })
    check('an in-salon payment is recorded', manual.status === 201, manual.body)

    const appt = await call('client', 'GET', `/api/appointments/${appointmentId}`)
    check('the appointment shows as paid, tip included',
      appt.body.appointment.paid_cents === cut.price_cents + 1000, appt.body.appointment)

    const history = await call('client', 'GET', '/api/payments')
    check('the client sees the payment', history.body.payments.length === 1, history.body)

    const intent = await call('client', 'POST', '/api/payments/intent', { appointment_id: appointmentId })
    // Stripe is not configured in this environment, so the card path declines
    // cleanly rather than throwing.
    check('the card path reports that Stripe is off', intent.status === 400, intent.body)
  }

  section('Mass texts')
  {
    const preview = await call('owner', 'POST', '/api/messaging/preview', {
      audience: 'all', body: 'Hi {{first_name}}, openings this Friday!',
    })
    check('preview counts recipients', preview.status === 200 && preview.body.recipient_count >= 1, preview.body)
    check('preview personalizes the copy', preview.body.preview.includes('Dana'), preview.body.preview)
    check('preview appends the opt-out footer', /STOP/i.test(preview.body.preview), preview.body.preview)
    check('preview reports segments', preview.body.segments >= 1, preview.body)

    const unconfirmed = await call('owner', 'POST', '/api/messaging/campaigns', {
      name: 'No confirm', body: 'Test', audience: 'all',
    })
    check('sending requires explicit confirmation', unconfirmed.status === 400, unconfirmed.body)

    const send = await call('owner', 'POST', '/api/messaging/campaigns', {
      name: 'Friday openings', body: 'Hi {{first_name}}, openings this Friday!',
      audience: 'all', confirm: true,
    })
    check('the campaign is created', send.status === 201, send.body)

    const campaign = await call('owner', 'GET', `/api/messaging/campaigns/${send.body.campaign.id}`)
    check('every recipient got a message row',
      campaign.body.messages.length === send.body.campaign.recipient_count, campaign.body.messages)

    const blocked = await call('client', 'POST', '/api/messaging/preview', { audience: 'all', body: 'x' })
    check('clients cannot send mass texts', blocked.status === 403, blocked.body)
  }

  section('Opt-out is respected')
  {
    await call('client', 'PATCH', '/api/auth/me', { sms_opt_in: false })
    const preview = await call('owner', 'POST', '/api/messaging/preview', { audience: 'all', body: 'Hello' })
    check('an opted-out client is excluded from the audience',
      !preview.body.sample_recipients.some((r) => r.id === clientId), preview.body.sample_recipients)
    await call('client', 'PATCH', '/api/auth/me', { sms_opt_in: true })
  }

  section('Reminders')
  {
    const res = await call('owner', 'POST', '/api/messaging/reminders/run')
    check('the reminder sweep runs', res.status === 200, res.body)

    const again = await call('owner', 'POST', '/api/messaging/reminders/run')
    check('a second sweep queues no duplicates', again.body.queued === 0, again.body)
  }

  section('Cancellation')
  {
    const res = await call('client', 'POST', `/api/appointments/${appointmentId}/cancel`)
    check('the client can cancel outside the window', res.status === 200, res.body)
    check('the status flips to cancelled', res.body.appointment.status === 'cancelled', res.body.appointment)

    const again = await call('client', 'POST', `/api/appointments/${appointmentId}/cancel`)
    check('cancelling twice is harmless', again.status === 200, again.body)
  }

  section('Settings')
  {
    const res = await call('owner', 'PATCH', '/api/admin/settings', { cancel_window_hours: 48 })
    check('settings save', res.status === 200 && res.body.settings.cancel_window_hours === 48, res.body)

    const salon = await call('anon', 'GET', '/api/salon')
    check('the public config reflects the change', salon.body.salon.cancel_window_hours === 48, salon.body)
    check('no secrets leak through the public config',
      !JSON.stringify(salon.body).includes('sk_') && !('ADMIN_SETUP_TOKEN' in salon.body), salon.body)

    await call('owner', 'PATCH', '/api/admin/settings', { cancel_window_hours: 24 })
  }

  console.log(`\n${passed} checks passed.`)
}

main().catch((err) => {
  console.error(`\n${err.message}`)
  process.exit(1)
})
