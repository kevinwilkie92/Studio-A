import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { api, ApiError, type Appointment } from '../../lib/api'
import { addDays, dateKey, money, relativeDay, timeOf } from '../../lib/format'
import { Alert, Badge, Button, Card, EmptyState, PageHeading, Select, Spinner } from '../../components/ui'

const STATUSES = ['booked', 'confirmed', 'completed', 'cancelled', 'no_show'] as const

export default function Calendar() {
  const [day, setDay] = useState(() => dateKey(new Date()))
  const [list, setList] = useState<Appointment[] | null>(null)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    setList(null)
    try {
      const res = await api.get<{ appointments: Appointment[] }>(
        `/admin/appointments?from=${day}&to=${day}`,
      )
      setList(res.appointments)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load the calendar.')
      setList([])
    }
  }, [day])

  useEffect(() => { void load() }, [load])

  async function setStatus(id: string, status: string) {
    setError('')
    try {
      await api.patch(`/admin/appointments/${id}/status`, { status })
      await load()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not update that appointment.')
    }
  }

  async function takePayment(appt: Appointment) {
    const owed = Math.max(0, appt.total_cents - appt.paid_cents)
    const raw = prompt(`Amount collected in the salon (dollars):`, (owed / 100).toFixed(2))
    if (raw === null) return
    const amount = Math.round(Number(raw) * 100)
    if (!Number.isFinite(amount) || amount < 0) {
      setError('Enter a number, like 65 or 65.00.')
      return
    }
    const tipRaw = prompt('Tip (dollars), or leave blank:', '0')
    const tip = tipRaw === null ? 0 : Math.round(Number(tipRaw) * 100)

    try {
      await api.post('/payments/manual', {
        appointment_id: appt.id,
        amount_cents: amount,
        tip_cents: Number.isFinite(tip) && tip > 0 ? tip : 0,
        method: 'cash',
      })
      await load()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not record that payment.')
    }
  }

  return (
    <div className="space-y-5">
      <PageHeading title="Calendar" subtitle="Everything on the books, day by day." />

      {error && <Alert>{error}</Alert>}

      <div className="flex flex-wrap items-center gap-2">
        <Button variant="secondary" onClick={() => setDay(addDays(day, -1))}>← Previous</Button>
        <input
          type="date" value={day} onChange={(e) => setDay(e.target.value)}
          className="rounded-lg border-0 bg-white px-3 py-2.5 text-sm shadow-sm ring-1 ring-ink-200"
        />
        <Button variant="secondary" onClick={() => setDay(addDays(day, 1))}>Next →</Button>
        <Button variant="ghost" onClick={() => setDay(dateKey(new Date()))}>Today</Button>
        <span className="ml-auto text-sm text-ink-600">{relativeDay(day)}</span>
      </div>

      {list === null ? (
        <Spinner />
      ) : list.length === 0 ? (
        <EmptyState title="Nothing booked that day" />
      ) : (
        <ul className="space-y-2">
          {list.map((appt) => {
            const owed = Math.max(0, appt.total_cents - appt.paid_cents)
            return (
              <li key={appt.id}>
                <Card className="p-4">
                  <div className="flex flex-wrap items-start justify-between gap-4">
                    <div className="flex gap-4">
                      <div className="w-20 shrink-0">
                        <p className="font-display text-lg text-ink-900">{timeOf(appt.starts_at)}</p>
                        <p className="text-xs text-ink-400">to {timeOf(appt.ends_at)}</p>
                      </div>
                      <div>
                        <Link
                          to={`/admin/clients/${appt.client_id}`}
                          className="font-medium text-ink-900 underline-offset-2 hover:underline"
                        >
                          {appt.client_first_name} {appt.client_last_name}
                        </Link>
                        <p className="text-sm text-ink-600">
                          {appt.services.map((s) => s.name).join(', ') || 'Appointment'}
                        </p>
                        {appt.staff_name && <p className="text-xs text-ink-400">{appt.staff_name}</p>}
                        {appt.client_request && (
                          <p className="mt-1.5 rounded bg-ink-100 px-2 py-1 text-xs text-ink-600">
                            {appt.client_request}
                          </p>
                        )}
                      </div>
                    </div>

                    <div className="flex flex-col items-end gap-2">
                      <Badge tone={appt.status}>{appt.status.replace('_', ' ')}</Badge>
                      <p className="text-sm text-ink-800">
                        {money(appt.total_cents)}
                        {owed > 0 && <span className="text-accent-600"> · {money(owed)} due</span>}
                      </p>
                      <div className="flex items-center gap-2">
                        <Select
                          aria-label="Status"
                          className="py-1.5 text-xs"
                          value={appt.status}
                          onChange={(e) => void setStatus(appt.id, e.target.value)}
                        >
                          {STATUSES.map((s) => (
                            <option key={s} value={s}>{s.replace('_', ' ')}</option>
                          ))}
                        </Select>
                        {owed > 0 && (
                          <Button variant="secondary" className="px-3 py-1.5 text-xs"
                            onClick={() => void takePayment(appt)}>
                            Record payment
                          </Button>
                        )}
                      </div>
                    </div>
                  </div>
                </Card>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
