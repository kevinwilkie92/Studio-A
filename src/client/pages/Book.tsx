import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api, ApiError, type Appointment, type Service, type Slot, type StaffMember } from '../lib/api'
import { useAuth } from '../lib/auth'
import { addDays, dateKey, duration, money, relativeDay, timeOf } from '../lib/format'
import { Alert, Button, Card, EmptyState, Field, PageHeading, Select, Spinner, Textarea } from '../components/ui'

const DAYS_SHOWN = 14

export default function Book() {
  const { salon } = useAuth()
  const navigate = useNavigate()

  const [services, setServices] = useState<Service[] | null>(null)
  const [staff, setStaff] = useState<StaffMember[]>([])
  const [chosen, setChosen] = useState<string[]>([])
  const [staffId, setStaffId] = useState('')
  const [day, setDay] = useState(() => dateKey(new Date()))
  const [slots, setSlots] = useState<Slot[] | null>(null)
  const [selected, setSelected] = useState<Slot | null>(null)
  const [request, setRequest] = useState('')
  const [error, setError] = useState('')
  const [booking, setBooking] = useState(false)

  useEffect(() => {
    void Promise.all([
      api.get<{ services: Service[] }>('/services'),
      api.get<{ staff: StaffMember[] }>('/staff'),
    ]).then(([s, st]) => {
      setServices(s.services)
      setStaff(st.staff)
    }).catch(() => setServices([]))
  }, [])

  const chosenServices = useMemo(
    () => chosen.map((id) => services?.find((s) => s.id === id)).filter((s): s is Service => Boolean(s)),
    [chosen, services],
  )
  const totalMin = chosenServices.reduce((sum, s) => sum + s.duration_min, 0)
  const totalCents = chosenServices.reduce((sum, s) => sum + s.price_cents, 0)

  const loadSlots = useCallback(async () => {
    if (chosen.length === 0) {
      setSlots(null)
      return
    }
    setSlots(null)
    setError('')
    try {
      const params = new URLSearchParams({ date: day, services: chosen.join(',') })
      if (staffId) params.set('staff_id', staffId)
      const res = await api.get<{ slots: Slot[] }>(`/availability?${params}`)
      setSlots(res.slots)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load times.')
      setSlots([])
    }
  }, [chosen, day, staffId])

  useEffect(() => {
    setSelected(null)
    void loadSlots()
  }, [loadSlots])

  function toggleService(id: string) {
    setChosen((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]))
  }

  async function confirm() {
    if (!selected) return
    setBooking(true)
    setError('')
    try {
      const res = await api.post<{ appointment: Appointment }>('/appointments', {
        service_ids: chosen,
        starts_at: selected.start,
        staff_id: staffId || selected.staff[0]?.id || null,
        client_request: request,
      })
      navigate(`/appointments/${res.appointment.id}`, { replace: true })
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not book that time.')
      // The slot may have just been taken — refresh so the grid is honest.
      void loadSlots()
      setSelected(null)
    } finally {
      setBooking(false)
    }
  }

  const days = useMemo(() => {
    const today = dateKey(new Date())
    return Array.from({ length: DAYS_SHOWN }, (_, i) => addDays(today, i))
  }, [])

  const byCategory = (services ?? []).reduce<Record<string, Service[]>>((acc, s) => {
    ;(acc[s.category] ??= []).push(s)
    return acc
  }, {})

  if (services === null) return <Spinner label="Loading services" />

  return (
    <div className="space-y-6">
      <PageHeading title="Book an appointment" subtitle="Pick your services, then choose a time." />

      {error && <Alert>{error}</Alert>}

      <Card>
        <h2 className="font-display text-lg text-ink-900">1. What are we doing?</h2>
        <div className="mt-4 space-y-5">
          {Object.entries(byCategory).map(([category, list]) => (
            <fieldset key={category}>
              <legend className="text-xs font-semibold uppercase tracking-wide text-ink-400">{category}</legend>
              <div className="mt-2 grid gap-2 sm:grid-cols-2">
                {list.map((s) => {
                  const picked = chosen.includes(s.id)
                  return (
                    <label
                      key={s.id}
                      className={`flex cursor-pointer items-start gap-3 rounded-lg p-3 text-left ring-1 transition-colors ${
                        picked ? 'bg-accent-100 ring-accent-400' : 'bg-white ring-ink-200 hover:bg-ink-100'
                      }`}
                    >
                      <input
                        type="checkbox" className="mt-1 h-4 w-4 rounded border-ink-200 text-ink-900"
                        checked={picked} onChange={() => toggleService(s.id)}
                      />
                      <span className="flex-1">
                        <span className="block text-sm font-medium text-ink-900">{s.name}</span>
                        <span className="block text-xs text-ink-600">
                          {duration(s.duration_min)} · {money(s.price_cents)}
                          {s.deposit_cents > 0 && ` · ${money(s.deposit_cents)} deposit`}
                        </span>
                      </span>
                    </label>
                  )
                })}
              </div>
            </fieldset>
          ))}
        </div>

        {chosen.length > 0 && (
          <p className="mt-4 rounded-lg bg-ink-100 px-4 py-3 text-sm text-ink-800">
            {chosen.length} service{chosen.length > 1 ? 's' : ''} · {duration(totalMin)} · {money(totalCents)}
          </p>
        )}
      </Card>

      {staff.length > 1 && (
        <Card>
          <h2 className="font-display text-lg text-ink-900">2. Anyone in particular?</h2>
          <div className="mt-3 max-w-xs">
            <Field label="Stylist" id="staff">
              <Select id="staff" value={staffId} onChange={(e) => setStaffId(e.target.value)}>
                <option value="">First available</option>
                {staff.map((s) => (
                  <option key={s.id} value={s.id}>{s.display_name}</option>
                ))}
              </Select>
            </Field>
          </div>
        </Card>
      )}

      <Card>
        <h2 className="font-display text-lg text-ink-900">{staff.length > 1 ? '3' : '2'}. When works?</h2>

        {chosen.length === 0 ? (
          <p className="mt-3 text-sm text-ink-600">Choose a service first and open times will appear here.</p>
        ) : (
          <>
            <div className="mt-4 -mx-1 flex gap-2 overflow-x-auto px-1 pb-2">
              {days.map((d) => (
                <button
                  key={d}
                  onClick={() => setDay(d)}
                  className={`shrink-0 rounded-lg px-3 py-2 text-sm font-medium ring-1 transition-colors ${
                    d === day ? 'bg-ink-900 text-ink-50 ring-ink-900' : 'bg-white text-ink-600 ring-ink-200 hover:bg-ink-100'
                  }`}
                >
                  {relativeDay(d)}
                </button>
              ))}
            </div>

            {slots === null ? (
              <Spinner label="Checking the book" />
            ) : slots.length === 0 ? (
              <EmptyState title="Nothing open that day">
                Try another date{salon?.phone ? <> or call <a className="underline" href={`tel:${salon.phone}`}>{salon.phone}</a></> : null}.
              </EmptyState>
            ) : (
              <div className="mt-2 grid grid-cols-3 gap-2 sm:grid-cols-5">
                {slots.map((slot) => (
                  <button
                    key={slot.start}
                    onClick={() => setSelected(slot)}
                    aria-pressed={selected?.start === slot.start}
                    className={`rounded-lg px-2 py-2.5 text-sm font-medium ring-1 transition-colors ${
                      selected?.start === slot.start
                        ? 'bg-ink-900 text-ink-50 ring-ink-900'
                        : 'bg-white text-ink-800 ring-ink-200 hover:bg-ink-100'
                    }`}
                  >
                    {timeOf(slot.start)}
                  </button>
                ))}
              </div>
            )}
          </>
        )}
      </Card>

      {selected && (
        <Card className="ring-accent-400">
          <h2 className="font-display text-lg text-ink-900">Confirm</h2>
          <dl className="mt-3 space-y-1 text-sm">
            <div className="flex justify-between">
              <dt className="text-ink-600">When</dt>
              <dd className="font-medium text-ink-900">{relativeDay(day)} at {timeOf(selected.start)}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-ink-600">Services</dt>
              <dd className="text-right font-medium text-ink-900">
                {chosenServices.map((s) => s.name).join(', ')}
              </dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-ink-600">Stylist</dt>
              <dd className="font-medium text-ink-900">
                {staff.find((s) => s.id === (staffId || selected.staff[0]?.id))?.display_name ?? 'First available'}
              </dd>
            </div>
            <div className="flex justify-between border-t border-ink-200 pt-2">
              <dt className="text-ink-600">Estimated total</dt>
              <dd className="font-medium text-ink-900">{money(totalCents)}</dd>
            </div>
          </dl>

          <div className="mt-4">
            <Field label="Anything we should know?" id="request" hint="Photos, colour history, running late — anything helps.">
              <Textarea id="request" rows={3} maxLength={1000}
                value={request} onChange={(e) => setRequest(e.target.value)} />
            </Field>
          </div>

          <Button className="mt-4 w-full" onClick={confirm} disabled={booking}>
            {booking ? 'Booking…' : `Book ${relativeDay(day)} at ${timeOf(selected.start)}`}
          </Button>
          {salon && (
            <p className="mt-2 text-center text-xs text-ink-400">
              Free to cancel up to {salon.cancel_window_hours} hours beforehand.
            </p>
          )}
        </Card>
      )}
    </div>
  )
}
