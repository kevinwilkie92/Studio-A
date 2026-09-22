import { useCallback, useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { api, ApiError, type Appointment } from '../lib/api'
import { useAuth } from '../lib/auth'
import { duration, longDate, money, timeOf } from '../lib/format'
import PayForm from '../components/PayForm'
import { Alert, Badge, Button, Card, PageHeading, Spinner } from '../components/ui'

export default function AppointmentDetail() {
  const { id = '' } = useParams()
  const { salon, stripeKey } = useAuth()
  const navigate = useNavigate()

  const [appt, setAppt] = useState<Appointment | null>(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [cancelling, setCancelling] = useState(false)

  const load = useCallback(async () => {
    try {
      const res = await api.get<{ appointment: Appointment }>(`/appointments/${id}`)
      setAppt(res.appointment)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load that appointment.')
    }
  }, [id])

  useEffect(() => { void load() }, [load])

  async function cancel() {
    if (!confirm('Cancel this appointment?')) return
    setCancelling(true)
    setError('')
    try {
      await api.post(`/appointments/${id}/cancel`)
      setNotice('Your appointment has been cancelled.')
      await load()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not cancel.')
    } finally {
      setCancelling(false)
    }
  }

  if (error && !appt) return <Alert>{error}</Alert>
  if (!appt) return <Spinner />

  const owed = Math.max(0, appt.total_cents - appt.paid_cents)
  const upcoming = appt.starts_at > Date.now() / 1000
  const active = appt.status === 'booked' || appt.status === 'confirmed'
  const canCancel = active && upcoming &&
    appt.starts_at - Date.now() / 1000 > (salon?.cancel_window_hours ?? 24) * 3600

  return (
    <div className="mx-auto max-w-lg space-y-5">
      <PageHeading
        title={longDate(appt.starts_at)}
        subtitle={`${timeOf(appt.starts_at)} – ${timeOf(appt.ends_at)} · ${duration(Math.round((appt.ends_at - appt.starts_at) / 60))}`}
        action={<Badge tone={appt.status}>{appt.status.replace('_', ' ')}</Badge>}
      />

      {notice && <Alert kind="success">{notice}</Alert>}
      {error && <Alert>{error}</Alert>}

      <Card>
        <h2 className="font-display text-lg text-ink-900">What you're having done</h2>
        <ul className="mt-3 divide-y divide-ink-200 text-sm">
          {appt.services.map((s, i) => (
            <li key={`${s.service_id ?? s.name}-${i}`} className="flex justify-between py-2.5">
              <span>
                <span className="text-ink-900">{s.name}</span>
                <span className="block text-xs text-ink-400">{duration(s.duration_min)}</span>
              </span>
              <span className="text-ink-800">{money(s.price_cents)}</span>
            </li>
          ))}
        </ul>
        <div className="mt-3 space-y-1 border-t border-ink-200 pt-3 text-sm">
          <div className="flex justify-between font-medium">
            <span className="text-ink-800">Total</span>
            <span className="text-ink-900">{money(appt.total_cents)}</span>
          </div>
          {appt.paid_cents > 0 && (
            <div className="flex justify-between text-ink-600">
              <span>Paid</span>
              <span>−{money(appt.paid_cents)}</span>
            </div>
          )}
          {owed > 0 && (
            <div className="flex justify-between font-medium text-accent-600">
              <span>Balance</span>
              <span>{money(owed)}</span>
            </div>
          )}
        </div>
        {appt.staff_name && (
          <p className="mt-3 text-sm text-ink-600">With {appt.staff_name}</p>
        )}
        {appt.client_request && (
          <p className="mt-3 rounded-lg bg-ink-100 px-3 py-2 text-sm text-ink-600">
            <span className="font-medium text-ink-800">Your note: </span>{appt.client_request}
          </p>
        )}
      </Card>

      {owed > 0 && appt.status !== 'cancelled' && (
        <Card>
          <h2 className="font-display text-lg text-ink-900">Pay your balance</h2>
          {stripeKey ? (
            <div className="mt-3">
              <PayForm
                appointmentId={appt.id}
                amountCents={owed}
                publishableKey={stripeKey}
                onPaid={() => void load()}
              />
            </div>
          ) : (
            <p className="mt-2 text-sm text-ink-600">
              Online payment isn't switched on yet — you can settle up at the salon.
            </p>
          )}
        </Card>
      )}

      {active && upcoming && (
        <Card>
          <h2 className="font-display text-lg text-ink-900">Need to change something?</h2>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button variant="secondary" onClick={() => navigate('/book')}>Book another time</Button>
            {canCancel ? (
              <Button variant="danger" onClick={cancel} disabled={cancelling}>
                {cancelling ? 'Cancelling…' : 'Cancel appointment'}
              </Button>
            ) : (
              <p className="self-center text-sm text-ink-600">
                Within {salon?.cancel_window_hours ?? 24} hours — please call
                {salon?.phone ? <> <a className="underline" href={`tel:${salon.phone}`}>{salon.phone}</a></> : ' the salon'}.
              </p>
            )}
          </div>
        </Card>
      )}

      <p className="text-center text-sm">
        <Link to="/appointments" className="text-ink-600 underline">Back to my visits</Link>
      </p>
    </div>
  )
}
