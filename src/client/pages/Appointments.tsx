import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { api, type Appointment } from '../lib/api'
import { dateTime, duration, money } from '../lib/format'
import { Badge, Card, EmptyState, LinkButton, PageHeading, Spinner } from '../components/ui'

export default function Appointments() {
  const [scope, setScope] = useState<'upcoming' | 'past'>('upcoming')
  const [list, setList] = useState<Appointment[] | null>(null)

  useEffect(() => {
    setList(null)
    void api.get<{ appointments: Appointment[] }>(`/appointments?scope=${scope}`)
      .then((r) => setList(r.appointments))
      .catch(() => setList([]))
  }, [scope])

  return (
    <div>
      <PageHeading
        title="My visits"
        action={<LinkButton to="/book">Book another</LinkButton>}
      />

      <div className="mb-4 inline-flex rounded-lg bg-ink-100 p-1">
        {(['upcoming', 'past'] as const).map((s) => (
          <button
            key={s}
            onClick={() => setScope(s)}
            className={`rounded-md px-4 py-1.5 text-sm font-medium capitalize transition-colors ${
              scope === s ? 'bg-white text-ink-900 shadow-sm' : 'text-ink-600'
            }`}
          >
            {s}
          </button>
        ))}
      </div>

      {list === null ? (
        <Spinner />
      ) : list.length === 0 ? (
        <EmptyState title={scope === 'upcoming' ? 'Nothing booked yet' : 'No past visits'}>
          {scope === 'upcoming' && <Link to="/book" className="underline">Find a time</Link>}
        </EmptyState>
      ) : (
        <ul className="space-y-3">
          {list.map((appt) => {
            const owed = Math.max(0, appt.total_cents - appt.paid_cents)
            return (
              <li key={appt.id}>
                <Link to={`/appointments/${appt.id}`} className="block">
                  <Card className="transition-shadow hover:shadow-md">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div>
                        <p className="font-medium text-ink-900">{dateTime(appt.starts_at)}</p>
                        <p className="mt-0.5 text-sm text-ink-600">
                          {appt.services.map((s) => s.name).join(', ') || 'Appointment'}
                        </p>
                        <p className="mt-0.5 text-xs text-ink-400">
                          {duration(Math.round((appt.ends_at - appt.starts_at) / 60))}
                          {appt.staff_name ? ` · ${appt.staff_name}` : ''}
                        </p>
                      </div>
                      <div className="text-right">
                        <Badge tone={appt.status}>{appt.status.replace('_', ' ')}</Badge>
                        <p className="mt-1.5 text-sm font-medium text-ink-800">{money(appt.total_cents)}</p>
                        {owed > 0 && appt.status !== 'cancelled' && (
                          <p className="text-xs text-accent-600">{money(owed)} due</p>
                        )}
                      </div>
                    </div>
                  </Card>
                </Link>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
