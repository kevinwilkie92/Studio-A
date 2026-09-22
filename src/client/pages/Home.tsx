import { useEffect, useState } from 'react'
import { api, type Service } from '../lib/api'
import { useAuth } from '../lib/auth'
import { duration, money } from '../lib/format'
import { Card, LinkButton, Spinner } from '../components/ui'

export default function Home() {
  const { user, salon, isStaff } = useAuth()
  const [services, setServices] = useState<Service[] | null>(null)

  useEffect(() => {
    void api.get<{ services: Service[] }>('/services')
      .then((r) => setServices(r.services))
      .catch(() => setServices([]))
  }, [])

  const byCategory = (services ?? []).reduce<Record<string, Service[]>>((acc, s) => {
    ;(acc[s.category] ??= []).push(s)
    return acc
  }, {})

  return (
    <div className="space-y-10">
      <section className="text-center">
        <h1 className="font-display text-4xl text-ink-900 sm:text-5xl">{salon?.name ?? 'Studio A'}</h1>
        <p className="mx-auto mt-3 max-w-lg text-ink-600">
          Book your next appointment, see what you had done last time, and pay before you
          walk out the door.
        </p>
        <div className="mt-6 flex justify-center gap-3">
          {user ? (
            <LinkButton to={isStaff ? '/admin' : '/book'}>
              {isStaff ? 'Open the back office' : 'Book an appointment'}
            </LinkButton>
          ) : (
            <>
              <LinkButton to="/register">Create an account</LinkButton>
              <LinkButton to="/login" variant="secondary">Sign in</LinkButton>
            </>
          )}
        </div>
        {salon?.phone && (
          <p className="mt-4 text-sm text-ink-600">
            Prefer to call? <a className="underline" href={`tel:${salon.phone}`}>{salon.phone}</a>
          </p>
        )}
      </section>

      <section>
        <h2 className="mb-4 font-display text-2xl text-ink-900">Services</h2>
        {services === null ? (
          <Spinner label="Loading the menu" />
        ) : (
          <div className="grid gap-4 sm:grid-cols-2">
            {Object.entries(byCategory).map(([category, list]) => (
              <Card key={category}>
                <h3 className="font-display text-lg text-ink-900">{category}</h3>
                <ul className="mt-3 space-y-3">
                  {list.map((s) => (
                    <li key={s.id} className="flex items-baseline justify-between gap-4">
                      <div>
                        <p className="text-sm font-medium text-ink-900">{s.name}</p>
                        {s.description && <p className="text-xs text-ink-600">{s.description}</p>}
                        <p className="text-xs text-ink-400">{duration(s.duration_min)}</p>
                      </div>
                      <p className="shrink-0 text-sm font-medium text-ink-800">{money(s.price_cents)}</p>
                    </li>
                  ))}
                </ul>
              </Card>
            ))}
          </div>
        )}
      </section>
    </div>
  )
}
