import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { api, type ClientSummary } from '../../lib/api'
import { dateOf, initials, phoneDisplay } from '../../lib/format'
import { Card, EmptyState, Input, PageHeading, Spinner } from '../../components/ui'

export default function Clients() {
  const [query, setQuery] = useState('')
  const [clients, setClients] = useState<ClientSummary[] | null>(null)

  useEffect(() => {
    // Debounced so typing a name does not fire a query per keystroke.
    const timer = setTimeout(() => {
      void api.get<{ clients: ClientSummary[] }>(`/admin/clients?q=${encodeURIComponent(query)}`)
        .then((r) => setClients(r.clients))
        .catch(() => setClients([]))
    }, 200)
    return () => clearTimeout(timer)
  }, [query])

  return (
    <div className="space-y-5">
      <PageHeading title="Clients" subtitle="Search by name, email or phone." />

      <Input
        type="search" placeholder="Search clients…" value={query}
        onChange={(e) => setQuery(e.target.value)} aria-label="Search clients"
      />

      {clients === null ? (
        <Spinner />
      ) : clients.length === 0 ? (
        <EmptyState title={query ? 'No one matches that' : 'No clients yet'} />
      ) : (
        <Card className="p-0">
          <ul className="divide-y divide-ink-200">
            {clients.map((c) => (
              <li key={c.id}>
                <Link to={`/admin/clients/${c.id}`} className="flex items-center gap-4 px-5 py-3 hover:bg-ink-100">
                  <span
                    aria-hidden
                    className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-ink-900 text-xs font-semibold text-ink-50"
                  >
                    {initials(c.first_name, c.last_name)}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium text-ink-900">
                      {c.first_name} {c.last_name}
                    </span>
                    <span className="block truncate text-xs text-ink-400">
                      {phoneDisplay(c.phone) || c.email}
                      {!c.sms_opt_in && c.phone ? ' · texts off' : ''}
                    </span>
                  </span>
                  <span className="hidden text-right text-xs text-ink-600 sm:block">
                    <span className="block">{c.visits} visit{c.visits === 1 ? '' : 's'}</span>
                    {c.next_visit
                      ? <span className="block text-accent-600">next {dateOf(c.next_visit)}</span>
                      : c.last_visit
                        ? <span className="block">last {dateOf(c.last_visit)}</span>
                        : null}
                  </span>
                  {c.note_count > 0 && (
                    <span className="rounded-full bg-ink-100 px-2 py-0.5 text-xs text-ink-600">
                      {c.note_count} note{c.note_count === 1 ? '' : 's'}
                    </span>
                  )}
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  )
}
