import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { api, ApiError, type Service, type StaffMember } from '../../lib/api'
import { useAuth } from '../../lib/auth'
import { dateOf, duration, money, phoneDisplay } from '../../lib/format'
import { Alert, Button, Card, Field, Input, PageHeading, Select, Spinner, Textarea } from '../../components/ui'

interface SalonSettings {
  salon_name: string
  timezone: string
  currency: string
  slot_interval_min: number
  buffer_min: number
  booking_lead_hours: number
  booking_horizon_days: number
  cancel_window_hours: number
  reminder_offsets_hours: number[]
  reminder_quiet_start: number
  reminder_quiet_end: number
  booking_confirmation_sms: boolean
  sms_footer: string
  address: string
  phone: string
}

interface Integrations { stripe: boolean; stripe_webhook: boolean; twilio: boolean }

interface StaffHour { id: string; staff_id: string; weekday: number; start_min: number; end_min: number }

interface TeamMember {
  id: string
  first_name: string
  last_name: string
  email: string
  phone: string | null
  role: 'staff' | 'admin'
  created_at: number
}

interface ClientMatch {
  id: string
  first_name: string
  last_name: string
  email: string
  phone: string | null
}

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

const minutesToTime = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`
const timeToMinutes = (t: string) => {
  const [h, m] = t.split(':').map(Number)
  return (h ?? 0) * 60 + (m ?? 0)
}

export default function Settings() {
  const { user, refresh } = useAuth()
  const isAdmin = user?.role === 'admin'

  const [settings, setSettings] = useState<SalonSettings | null>(null)
  const [integrations, setIntegrations] = useState<Integrations | null>(null)
  const [services, setServices] = useState<Service[]>([])
  const [staff, setStaff] = useState<(StaffMember & { active: number })[]>([])
  const [hours, setHours] = useState<StaffHour[]>([])
  const [status, setStatus] = useState<{ kind: 'error' | 'success'; text: string } | null>(null)

  const [team, setTeam] = useState<TeamMember[]>([])
  const [teamQuery, setTeamQuery] = useState('')
  const [teamMatches, setTeamMatches] = useState<ClientMatch[]>([])
  const [teamStatus, setTeamStatus] = useState<{ kind: 'error' | 'success'; text: string } | null>(null)
  const [teamBusy, setTeamBusy] = useState<string | null>(null)

  const load = useCallback(async () => {
    const [s, svc, st, tm] = await Promise.all([
      isAdmin
        ? api.get<{ settings: SalonSettings; integrations: Integrations }>('/admin/settings').catch(() => null)
        : Promise.resolve(null),
      api.get<{ services: Service[] }>('/services?all=1').catch(() => ({ services: [] })),
      api.get<{ staff: (StaffMember & { active: number })[]; hours: StaffHour[] }>('/admin/staff')
        .catch(() => ({ staff: [], hours: [] })),
      isAdmin
        ? api.get<{ team: TeamMember[] }>('/admin/team').catch(() => ({ team: [] }))
        : Promise.resolve({ team: [] }),
    ])
    if (s) { setSettings(s.settings); setIntegrations(s.integrations) }
    setServices(svc.services)
    setStaff(st.staff)
    setHours(st.hours)
    setTeam(tm.team)
  }, [isAdmin])

  useEffect(() => { void load() }, [load])

  // Live search for a client to promote — mirrors the debounced pattern used
  // on the Clients page. Only role = 'client' accounts show up here; once
  // someone is promoted they move into `team` and drop out of this search.
  useEffect(() => {
    if (!isAdmin || teamQuery.trim().length < 2) {
      setTeamMatches([])
      return
    }
    const timer = setTimeout(() => {
      void api.get<{ clients: ClientMatch[] }>(`/admin/clients?q=${encodeURIComponent(teamQuery)}&limit=5`)
        .then((r) => setTeamMatches(r.clients))
        .catch(() => setTeamMatches([]))
    }, 250)
    return () => clearTimeout(timer)
  }, [isAdmin, teamQuery])

  async function setRole(userId: string, role: 'client' | 'staff' | 'admin') {
    setTeamBusy(userId)
    setTeamStatus(null)
    try {
      await api.patch(`/admin/users/${userId}/role`, { role })
      setTeamStatus({ kind: 'success', text: role === 'client' ? 'Removed from the back office.' : `Now ${role}.` })
      setTeamQuery('')
      setTeamMatches([])
      await load()
    } catch (err) {
      setTeamStatus({ kind: 'error', text: err instanceof ApiError ? err.message : 'Could not update that account.' })
    } finally {
      setTeamBusy(null)
    }
  }

  async function saveSettings(e: FormEvent) {
    e.preventDefault()
    if (!settings) return
    setStatus(null)
    try {
      await api.patch('/admin/settings', settings)
      await refresh()
      setStatus({ kind: 'success', text: 'Settings saved.' })
    } catch (err) {
      setStatus({ kind: 'error', text: err instanceof ApiError ? err.message : 'Could not save settings.' })
    }
  }

  async function saveHours(staffId: string) {
    const rows = hours.filter((h) => h.staff_id === staffId).map(({ weekday, start_min, end_min }) => ({
      weekday, start_min, end_min,
    }))
    setStatus(null)
    try {
      await api.put(`/admin/staff/${staffId}/hours`, { hours: rows })
      setStatus({ kind: 'success', text: 'Hours saved.' })
      await load()
    } catch (err) {
      setStatus({ kind: 'error', text: err instanceof ApiError ? err.message : 'Could not save hours.' })
    }
  }

  function setHour(staffId: string, weekday: number, field: 'start_min' | 'end_min', value: number) {
    setHours((prev) => {
      const existing = prev.find((h) => h.staff_id === staffId && h.weekday === weekday)
      if (existing) {
        return prev.map((h) => (h === existing ? { ...h, [field]: value } : h))
      }
      return [...prev, {
        id: `new-${staffId}-${weekday}`, staff_id: staffId, weekday,
        start_min: field === 'start_min' ? value : 540,
        end_min: field === 'end_min' ? value : 1020,
      }]
    })
  }

  function toggleDay(staffId: string, weekday: number, on: boolean) {
    setHours((prev) => on
      ? [...prev, { id: `new-${staffId}-${weekday}`, staff_id: staffId, weekday, start_min: 540, end_min: 1020 }]
      : prev.filter((h) => !(h.staff_id === staffId && h.weekday === weekday)))
  }

  async function toggleService(service: Service) {
    await api.patch(`/admin/services/${service.id}`, { active: !service.active }).catch(() => {})
    await load()
  }

  if (isAdmin && !settings) return <Spinner />

  return (
    <div className="space-y-6">
      <PageHeading title="Settings" subtitle="Hours, services, reminders and integrations." />

      {status && <Alert kind={status.kind}>{status.text}</Alert>}

      {settings && (
        <Card>
          <form onSubmit={saveSettings} className="space-y-4">
            <h2 className="font-display text-lg text-ink-900">The salon</h2>

            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Name" id="salon_name">
                <Input id="salon_name" value={settings.salon_name}
                  onChange={(e) => setSettings({ ...settings, salon_name: e.target.value })} />
              </Field>
              <Field label="Phone" id="salon_phone" hint="Shown to clients who need to call.">
                <Input id="salon_phone" value={settings.phone}
                  onChange={(e) => setSettings({ ...settings, phone: e.target.value })} />
              </Field>
            </div>

            <Field label="Address" id="address">
              <Input id="address" value={settings.address}
                onChange={(e) => setSettings({ ...settings, address: e.target.value })} />
            </Field>

            <Field label="Timezone" id="timezone" hint="IANA name, e.g. America/New_York. Every time in the app uses this.">
              <Input id="timezone" value={settings.timezone}
                onChange={(e) => setSettings({ ...settings, timezone: e.target.value })} />
            </Field>

            <h3 className="pt-2 font-display text-base text-ink-900">Booking rules</h3>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Slot interval (minutes)" id="slot_interval_min">
                <Input id="slot_interval_min" type="number" min={5} max={60} value={settings.slot_interval_min}
                  onChange={(e) => setSettings({ ...settings, slot_interval_min: Number(e.target.value) })} />
              </Field>
              <Field label="Buffer between clients (minutes)" id="buffer_min">
                <Input id="buffer_min" type="number" min={0} max={120} value={settings.buffer_min}
                  onChange={(e) => setSettings({ ...settings, buffer_min: Number(e.target.value) })} />
              </Field>
              <Field label="Minimum notice (hours)" id="booking_lead_hours">
                <Input id="booking_lead_hours" type="number" min={0} max={168} value={settings.booking_lead_hours}
                  onChange={(e) => setSettings({ ...settings, booking_lead_hours: Number(e.target.value) })} />
              </Field>
              <Field label="Book up to (days ahead)" id="booking_horizon_days">
                <Input id="booking_horizon_days" type="number" min={1} max={365} value={settings.booking_horizon_days}
                  onChange={(e) => setSettings({ ...settings, booking_horizon_days: Number(e.target.value) })} />
              </Field>
              <Field label="Cancellation window (hours)" id="cancel_window_hours">
                <Input id="cancel_window_hours" type="number" min={0} max={168} value={settings.cancel_window_hours}
                  onChange={(e) => setSettings({ ...settings, cancel_window_hours: Number(e.target.value) })} />
              </Field>
            </div>

            <h3 className="pt-2 font-display text-base text-ink-900">Reminders</h3>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field
                label="Send reminders this many hours before"
                id="reminder_offsets"
                hint="Comma separated, e.g. 24, 2"
              >
                <Input id="reminder_offsets" value={settings.reminder_offsets_hours.join(', ')}
                  onChange={(e) => setSettings({
                    ...settings,
                    reminder_offsets_hours: e.target.value.split(',')
                      .map((x) => Number(x.trim())).filter((n) => Number.isFinite(n) && n > 0),
                  })} />
              </Field>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Quiet from (hour)" id="quiet_start">
                  <Input id="quiet_start" type="number" min={0} max={23} value={settings.reminder_quiet_start}
                    onChange={(e) => setSettings({ ...settings, reminder_quiet_start: Number(e.target.value) })} />
                </Field>
                <Field label="Until (hour)" id="quiet_end">
                  <Input id="quiet_end" type="number" min={0} max={23} value={settings.reminder_quiet_end}
                    onChange={(e) => setSettings({ ...settings, reminder_quiet_end: Number(e.target.value) })} />
                </Field>
              </div>
            </div>

            <label className="flex items-center gap-2.5 text-sm text-ink-600">
              <input type="checkbox" className="h-4 w-4 rounded border-ink-200 text-ink-900"
                checked={settings.booking_confirmation_sms}
                onChange={(e) => setSettings({ ...settings, booking_confirmation_sms: e.target.checked })} />
              Text a confirmation the moment someone books.
            </label>

            <Field label="Opt-out footer" id="sms_footer" hint="Appended to campaign and reminder texts.">
              <Textarea id="sms_footer" rows={2} value={settings.sms_footer}
                onChange={(e) => setSettings({ ...settings, sms_footer: e.target.value })} />
            </Field>

            <Button type="submit">Save settings</Button>
          </form>
        </Card>
      )}

      {integrations && (
        <Card>
          <h2 className="font-display text-lg text-ink-900">Integrations</h2>
          <p className="mt-0.5 text-xs text-ink-400">
            Configured with <code>wrangler secret put</code>, never from this screen.
          </p>
          <ul className="mt-3 space-y-2 text-sm">
            {[
              { label: 'Stripe payments', on: integrations.stripe, secret: 'STRIPE_SECRET_KEY' },
              { label: 'Stripe webhook', on: integrations.stripe_webhook, secret: 'STRIPE_WEBHOOK_SECRET' },
              { label: 'Twilio texting', on: integrations.twilio, secret: 'TWILIO_ACCOUNT_SID + TWILIO_AUTH_TOKEN' },
            ].map((row) => (
              <li key={row.label} className="flex items-center justify-between">
                <span className="text-ink-900">{row.label}</span>
                <span className={row.on ? 'text-emerald-700' : 'text-ink-400'}>
                  {row.on ? 'Connected' : `Not set — ${row.secret}`}
                </span>
              </li>
            ))}
          </ul>
          {!integrations.twilio && (
            <p className="mt-3 rounded-lg bg-ink-100 px-3 py-2 text-xs text-ink-600">
              Texts are recorded but not delivered until Twilio is configured, so you can try the
              flow end to end without spending anything.
            </p>
          )}
        </Card>
      )}

      {isAdmin && (
        <Card>
          <h2 className="font-display text-lg text-ink-900">Team</h2>
          <p className="mt-0.5 text-xs text-ink-400">
            Anyone with a client account can be given back-office access. Staff can see the
            calendar, clients and notes, and send texts. Admins can also change settings and
            manage the team.
          </p>

          {teamStatus && <div className="mt-3"><Alert kind={teamStatus.kind}>{teamStatus.text}</Alert></div>}

          {team.length === 0 ? (
            <p className="mt-4 text-sm text-ink-600">Just you, so far.</p>
          ) : (
            <ul className="mt-4 divide-y divide-ink-200 text-sm">
              {team.map((member) => (
                <li key={member.id} className="flex flex-wrap items-center justify-between gap-3 py-2.5">
                  <div>
                    <p className="font-medium text-ink-900">
                      {member.first_name} {member.last_name}
                      {member.id === user?.id && <span className="ml-1.5 text-xs text-ink-400">(you)</span>}
                    </p>
                    <p className="text-xs text-ink-400">
                      {member.email}{member.phone ? ` · ${phoneDisplay(member.phone)}` : ''} · joined {dateOf(member.created_at)}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <Select
                      aria-label={`Role for ${member.first_name}`}
                      className="w-32 py-1.5 text-xs"
                      value={member.role}
                      disabled={teamBusy === member.id}
                      onChange={(e) => void setRole(member.id, e.target.value as 'client' | 'staff' | 'admin')}
                    >
                      <option value="staff">Staff</option>
                      <option value="admin">Admin</option>
                      <option value="client">Remove access</option>
                    </Select>
                  </div>
                </li>
              ))}
            </ul>
          )}

          <div className="mt-5 border-t border-ink-200 pt-4">
            <Field label="Add someone" id="team-search" hint="They need their own account first — have them sign up, then search for their email here.">
              <Input
                id="team-search" type="search" placeholder="Search by name or email…"
                value={teamQuery} onChange={(e) => setTeamQuery(e.target.value)}
              />
            </Field>

            {teamMatches.length > 0 && (
              <ul className="mt-2 divide-y divide-ink-200 rounded-lg bg-ink-100">
                {teamMatches.map((match) => (
                  <li key={match.id} className="flex flex-wrap items-center justify-between gap-3 px-3 py-2.5 text-sm">
                    <div>
                      <p className="text-ink-900">{match.first_name} {match.last_name}</p>
                      <p className="text-xs text-ink-400">{match.email}</p>
                    </div>
                    <div className="flex gap-2">
                      <Button
                        variant="secondary" className="px-3 py-1.5 text-xs"
                        disabled={teamBusy === match.id}
                        onClick={() => void setRole(match.id, 'staff')}
                      >
                        Make staff
                      </Button>
                      <Button
                        variant="secondary" className="px-3 py-1.5 text-xs"
                        disabled={teamBusy === match.id}
                        onClick={() => void setRole(match.id, 'admin')}
                      >
                        Make admin
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
            {teamQuery.trim().length >= 2 && teamMatches.length === 0 && (
              <p className="mt-2 text-xs text-ink-400">
                No client account matches that yet — they need to create one first.
              </p>
            )}
          </div>
        </Card>
      )}

      <Card>
        <h2 className="font-display text-lg text-ink-900">Hours</h2>
        {staff.length === 0 ? (
          <p className="mt-2 text-sm text-ink-600">No stylists set up yet.</p>
        ) : (
          <div className="mt-4 space-y-6">
            {staff.map((person) => (
              <div key={person.id}>
                <h3 className="font-medium text-ink-900">{person.display_name}</h3>
                <div className="mt-2 space-y-2">
                  {WEEKDAYS.map((label, weekday) => {
                    const row = hours.find((h) => h.staff_id === person.id && h.weekday === weekday)
                    return (
                      <div key={weekday} className="flex flex-wrap items-center gap-3 text-sm">
                        <label className="flex w-32 items-center gap-2">
                          <input type="checkbox" className="h-4 w-4 rounded border-ink-200 text-ink-900"
                            checked={Boolean(row)}
                            onChange={(e) => toggleDay(person.id, weekday, e.target.checked)} />
                          <span className="text-ink-800">{label}</span>
                        </label>
                        {row ? (
                          <>
                            <input type="time" value={minutesToTime(row.start_min)}
                              onChange={(e) => setHour(person.id, weekday, 'start_min', timeToMinutes(e.target.value))}
                              className="rounded-lg border-0 bg-white px-2 py-1.5 text-sm shadow-sm ring-1 ring-ink-200" />
                            <span className="text-ink-400">to</span>
                            <input type="time" value={minutesToTime(row.end_min)}
                              onChange={(e) => setHour(person.id, weekday, 'end_min', timeToMinutes(e.target.value))}
                              className="rounded-lg border-0 bg-white px-2 py-1.5 text-sm shadow-sm ring-1 ring-ink-200" />
                          </>
                        ) : (
                          <span className="text-ink-400">Closed</span>
                        )}
                      </div>
                    )
                  })}
                </div>
                {isAdmin && (
                  <Button variant="secondary" className="mt-3" onClick={() => void saveHours(person.id)}>
                    Save {person.display_name}'s hours
                  </Button>
                )}
              </div>
            ))}
          </div>
        )}
      </Card>

      <Card>
        <h2 className="font-display text-lg text-ink-900">Service menu</h2>
        <ul className="mt-3 divide-y divide-ink-200 text-sm">
          {services.map((s) => (
            <li key={s.id} className="flex items-center justify-between gap-4 py-2.5">
              <div className={s.active ? '' : 'opacity-50'}>
                <p className="font-medium text-ink-900">{s.name}</p>
                <p className="text-xs text-ink-400">
                  {s.category} · {duration(s.duration_min)} · {money(s.price_cents)}
                  {s.deposit_cents > 0 && ` · ${money(s.deposit_cents)} deposit`}
                </p>
              </div>
              {isAdmin && (
                <Button variant="ghost" className="px-3 py-1.5 text-xs" onClick={() => void toggleService(s)}>
                  {s.active ? 'Retire' : 'Restore'}
                </Button>
              )}
            </li>
          ))}
        </ul>
        {isAdmin && (
          <p className="mt-3 text-xs text-ink-400">
            Add or reprice services with the API (<code>POST /api/admin/services</code>) or by editing
            <code> migrations/seed.sql</code> before seeding.
          </p>
        )}
      </Card>

      {!isAdmin && (
        <Alert kind="info">Some settings are limited to the salon owner.</Alert>
      )}
    </div>
  )
}
