import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { Link, useParams } from 'react-router-dom'
import { api, ApiError, type Appointment, type ClientNote, type Payment, type User } from '../../lib/api'
import { dateOf, dateTime, money, phoneDisplay } from '../../lib/format'
import { Alert, Badge, Button, Card, EmptyState, Field, PageHeading, Select, Spinner, Textarea } from '../../components/ui'

const CATEGORIES = [
  { value: 'general', label: 'General' },
  { value: 'formula', label: 'Colour formula' },
  { value: 'allergy', label: 'Allergy / sensitivity' },
  { value: 'preference', label: 'Preference' },
] as const

const CATEGORY_TONE: Record<string, string> = {
  formula: 'bg-accent-100 text-ink-800',
  allergy: 'bg-red-100 text-red-800',
  preference: 'bg-emerald-100 text-emerald-800',
  general: 'bg-ink-100 text-ink-600',
}

interface Data {
  client: User & { sms_opt_out_at: number | null }
  appointments: Appointment[]
  notes: ClientNote[]
  payments: Payment[]
}

export default function ClientDetail() {
  const { id = '' } = useParams()
  const [data, setData] = useState<Data | null>(null)
  const [error, setError] = useState('')

  const [body, setBody] = useState('')
  const [category, setCategory] = useState<(typeof CATEGORIES)[number]['value']>('general')
  const [pinned, setPinned] = useState(false)
  const [saving, setSaving] = useState(false)

  const [text, setText] = useState('')
  const [textStatus, setTextStatus] = useState('')

  const load = useCallback(async () => {
    try {
      setData(await api.get<Data>(`/admin/clients/${id}`))
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load that client.')
    }
  }, [id])

  useEffect(() => { void load() }, [load])

  async function addNote(e: FormEvent) {
    e.preventDefault()
    if (!body.trim()) return
    setSaving(true)
    setError('')
    try {
      await api.post(`/admin/clients/${id}/notes`, { body, category, pinned })
      setBody('')
      setPinned(false)
      setCategory('general')
      await load()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save that note.')
    } finally {
      setSaving(false)
    }
  }

  async function togglePin(note: ClientNote) {
    await api.patch(`/admin/notes/${note.id}`, { pinned: !note.pinned }).catch(() => {})
    await load()
  }

  async function removeNote(note: ClientNote) {
    if (!confirm('Delete this note?')) return
    await api.del(`/admin/notes/${note.id}`).catch(() => {})
    await load()
  }

  async function sendText(e: FormEvent) {
    e.preventDefault()
    if (!text.trim()) return
    setTextStatus('')
    try {
      await api.post('/messaging/send', { user_id: id, body: text })
      setText('')
      setTextStatus('Sent.')
    } catch (err) {
      setTextStatus(err instanceof ApiError ? err.message : 'Could not send that text.')
    }
  }

  if (error && !data) return <Alert>{error}</Alert>
  if (!data) return <Spinner />

  const { client, appointments, notes, payments } = data
  const lifetime = payments
    .filter((p) => p.status === 'succeeded')
    .reduce((sum, p) => sum + p.amount_cents + p.tip_cents, 0)

  return (
    <div className="space-y-5">
      <PageHeading
        title={`${client.first_name} ${client.last_name}`}
        subtitle={[phoneDisplay(client.phone), client.email].filter(Boolean).join(' · ')}
        action={<Link to="/admin/clients" className="text-sm text-ink-600 underline">All clients</Link>}
      />

      {error && <Alert>{error}</Alert>}

      <div className="grid gap-3 sm:grid-cols-3">
        {[
          { label: 'Visits', value: String(appointments.filter((a) => a.status === 'completed').length) },
          { label: 'Lifetime spend', value: money(lifetime) },
          { label: 'Client since', value: dateOf(client.created_at) },
        ].map((t) => (
          <Card key={t.label} className="p-4">
            <p className="text-xs uppercase tracking-wide text-ink-400">{t.label}</p>
            <p className="mt-1 font-display text-xl text-ink-900">{t.value}</p>
          </Card>
        ))}
      </div>

      {client.phone && !client.sms_opt_in && (
        <Alert kind="info">
          This client has opted out of texts{client.sms_opt_out_at ? ` (${dateOf(client.sms_opt_out_at)})` : ''}.
          Reminders and campaigns will skip them.
        </Alert>
      )}

      <Card>
        <h2 className="font-display text-lg text-ink-900">Notes</h2>
        <p className="mt-0.5 text-xs text-ink-400">Staff only. Clients never see these.</p>

        <form onSubmit={addNote} className="mt-4 space-y-3">
          <Field label="Add a note" id="note-body">
            <Textarea
              id="note-body" rows={3} maxLength={4000} value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder="6N + 10 vol, 35 min. Prefers a deep side part. Sensitive scalp — no bleach at the hairline."
            />
          </Field>
          <div className="flex flex-wrap items-end gap-3">
            <div className="w-48">
              <Field label="Category" id="note-category">
                <Select id="note-category" value={category}
                  onChange={(e) => setCategory(e.target.value as typeof category)}>
                  {CATEGORIES.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
                </Select>
              </Field>
            </div>
            <label className="flex items-center gap-2 pb-2.5 text-sm text-ink-600">
              <input type="checkbox" className="h-4 w-4 rounded border-ink-200 text-ink-900"
                checked={pinned} onChange={(e) => setPinned(e.target.checked)} />
              Pin to the top
            </label>
            <Button type="submit" disabled={saving || !body.trim()} className="ml-auto">
              {saving ? 'Saving…' : 'Save note'}
            </Button>
          </div>
        </form>

        {notes.length === 0 ? (
          <p className="mt-4 text-sm text-ink-600">No notes yet.</p>
        ) : (
          <ul className="mt-4 space-y-3">
            {notes.map((note) => (
              <li key={note.id} className={`rounded-lg p-3 ring-1 ${note.pinned ? 'bg-accent-100/50 ring-accent-400' : 'bg-ink-50 ring-ink-200'}`}>
                <div className="flex items-start justify-between gap-3">
                  <p className="whitespace-pre-wrap text-sm text-ink-900">{note.body}</p>
                  <div className="flex shrink-0 gap-1">
                    <button onClick={() => void togglePin(note)}
                      className="rounded px-2 py-1 text-xs text-ink-600 hover:bg-ink-100">
                      {note.pinned ? 'Unpin' : 'Pin'}
                    </button>
                    <button onClick={() => void removeNote(note)}
                      className="rounded px-2 py-1 text-xs text-red-700 hover:bg-red-50">
                      Delete
                    </button>
                  </div>
                </div>
                <p className="mt-2 flex items-center gap-2 text-xs text-ink-400">
                  <span className={`rounded-full px-2 py-0.5 ${CATEGORY_TONE[note.category] ?? ''}`}>
                    {CATEGORIES.find((c) => c.value === note.category)?.label ?? note.category}
                  </span>
                  <span>{dateTime(note.created_at)}</span>
                  {note.author_first_name && <span>· {note.author_first_name}</span>}
                </p>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {client.phone && client.sms_opt_in && (
        <Card>
          <h2 className="font-display text-lg text-ink-900">Send a text</h2>
          <form onSubmit={sendText} className="mt-3 space-y-3">
            <Textarea rows={2} maxLength={1200} value={text} onChange={(e) => setText(e.target.value)}
              placeholder="Running about 10 minutes behind — see you soon!" aria-label="Message" />
            <div className="flex items-center gap-3">
              <Button type="submit" variant="secondary" disabled={!text.trim()}>Send</Button>
              {textStatus && <span className="text-sm text-ink-600">{textStatus}</span>}
            </div>
          </form>
        </Card>
      )}

      <Card>
        <h2 className="font-display text-lg text-ink-900">Visit history</h2>
        {appointments.length === 0 ? (
          <EmptyState title="No appointments yet" />
        ) : (
          <ul className="mt-3 divide-y divide-ink-200">
            {appointments.map((appt) => (
              <li key={appt.id} className="flex flex-wrap items-start justify-between gap-3 py-3">
                <div>
                  <p className="text-sm font-medium text-ink-900">{dateTime(appt.starts_at)}</p>
                  <p className="text-sm text-ink-600">
                    {appt.services.map((s) => s.name).join(', ') || 'Appointment'}
                  </p>
                  {appt.staff_name && <p className="text-xs text-ink-400">{appt.staff_name}</p>}
                </div>
                <div className="text-right">
                  <Badge tone={appt.status}>{appt.status.replace('_', ' ')}</Badge>
                  <p className="mt-1 text-sm text-ink-800">{money(appt.total_cents)}</p>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  )
}
