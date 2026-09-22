import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { api, type Appointment } from '../../lib/api'
import { money, phoneDisplay, timeOf } from '../../lib/format'
import { Badge, Card, EmptyState, LinkButton, PageHeading, Spinner } from '../../components/ui'

interface Stats {
  clients: number
  textable: number
  upcoming_week: number
  revenue_30d: number
}

interface Unpaid {
  id: string
  starts_at: number
  total_cents: number
  paid_cents: number
  client_first_name: string
  client_last_name: string
}

interface DashboardData {
  date: string
  today: Appointment[]
  stats: Stats
  unpaid: Unpaid[]
}

export default function Dashboard() {
  const [data, setData] = useState<DashboardData | null>(null)

  useEffect(() => {
    void api.get<DashboardData>('/admin/dashboard').then(setData).catch(() => setData(null))
  }, [])

  if (!data) return <Spinner label="Loading today" />

  const tiles = [
    { label: 'Booked this week', value: String(data.stats.upcoming_week) },
    { label: 'Clients', value: String(data.stats.clients) },
    { label: 'Reachable by text', value: String(data.stats.textable) },
    { label: 'Collected, 30 days', value: money(data.stats.revenue_30d) },
  ]

  return (
    <div className="space-y-6">
      <PageHeading
        title="Today"
        subtitle={new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}
        action={<LinkButton to="/admin/texts" variant="secondary">Send a text</LinkButton>}
      />

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {tiles.map((t) => (
          <Card key={t.label} className="p-4">
            <p className="text-xs uppercase tracking-wide text-ink-400">{t.label}</p>
            <p className="mt-1 font-display text-2xl text-ink-900">{t.value}</p>
          </Card>
        ))}
      </div>

      <section>
        <h2 className="mb-3 font-display text-xl text-ink-900">On the books</h2>
        {data.today.length === 0 ? (
          <EmptyState title="Nothing scheduled today">Enjoy the quiet.</EmptyState>
        ) : (
          <ul className="space-y-2">
            {data.today.map((appt) => (
              <li key={appt.id}>
                <Card className="p-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="flex gap-4">
                      <p className="w-20 shrink-0 font-display text-lg text-ink-900">{timeOf(appt.starts_at)}</p>
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
                        {appt.client_phone && (
                          <a href={`tel:${appt.client_phone}`} className="text-xs text-ink-400 hover:underline">
                            {phoneDisplay(appt.client_phone)}
                          </a>
                        )}
                        {appt.client_request && (
                          <p className="mt-1.5 rounded bg-ink-100 px-2 py-1 text-xs text-ink-600">
                            {appt.client_request}
                          </p>
                        )}
                      </div>
                    </div>
                    <div className="text-right">
                      <Badge tone={appt.status}>{appt.status.replace('_', ' ')}</Badge>
                      <p className="mt-1 text-sm text-ink-800">{money(appt.total_cents)}</p>
                      {appt.paid_cents < appt.total_cents && (
                        <p className="text-xs text-accent-600">{money(appt.total_cents - appt.paid_cents)} due</p>
                      )}
                    </div>
                  </div>
                </Card>
              </li>
            ))}
          </ul>
        )}
      </section>

      {data.unpaid.length > 0 && (
        <section>
          <h2 className="mb-3 font-display text-xl text-ink-900">Outstanding balances</h2>
          <Card className="p-0">
            <ul className="divide-y divide-ink-200 text-sm">
              {data.unpaid.map((u) => (
                <li key={u.id} className="flex items-center justify-between px-5 py-3">
                  <span className="text-ink-900">{u.client_first_name} {u.client_last_name}</span>
                  <span className="text-accent-600">{money(u.total_cents - u.paid_cents)}</span>
                </li>
              ))}
            </ul>
          </Card>
        </section>
      )}
    </div>
  )
}
