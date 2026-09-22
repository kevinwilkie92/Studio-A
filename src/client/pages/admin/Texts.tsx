import { useCallback, useEffect, useState } from 'react'
import { api, ApiError, type Campaign } from '../../lib/api'
import { dateTime } from '../../lib/format'
import { Alert, Badge, Button, Card, EmptyState, Field, PageHeading, Select, Spinner, Textarea, Input } from '../../components/ui'

const AUDIENCES = [
  { value: 'all', label: 'Every client', hint: 'Anyone with a mobile number who has not opted out.' },
  { value: 'upcoming', label: 'Has an upcoming appointment', hint: 'Good for closures and running-late notices.' },
  { value: 'recent', label: 'Visited recently', hint: 'Clients seen within the window below.' },
  { value: 'lapsed', label: "Hasn't been in a while", hint: 'Win-back offers.' },
] as const

interface Preview {
  recipient_count: number
  sample_recipients: { id: string; name: string; phone: string | null }[]
  preview: string
  segments: number
  encoding: string
  characters: number
  total_segments: number
}

export default function Texts() {
  const [name, setName] = useState('')
  const [body, setBody] = useState('')
  const [audience, setAudience] = useState<(typeof AUDIENCES)[number]['value']>('all')
  const [days, setDays] = useState(90)

  const [preview, setPreview] = useState<Preview | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [sending, setSending] = useState(false)
  const [status, setStatus] = useState<{ kind: 'error' | 'success'; text: string } | null>(null)

  const [campaigns, setCampaigns] = useState<Campaign[] | null>(null)

  const loadCampaigns = useCallback(async () => {
    const res = await api.get<{ campaigns: Campaign[] }>('/messaging/campaigns').catch(() => ({ campaigns: [] }))
    setCampaigns(res.campaigns)
  }, [])

  useEffect(() => { void loadCampaigns() }, [loadCampaigns])

  // Audience size and segment count refresh as the copy is written, so the
  // cost of a blast is visible before anyone commits to it.
  useEffect(() => {
    const timer = setTimeout(() => {
      void api.post<Preview>('/messaging/preview', { audience, days, body })
        .then(setPreview)
        .catch(() => setPreview(null))
    }, 350)
    return () => clearTimeout(timer)
  }, [audience, days, body])

  async function send() {
    setSending(true)
    setStatus(null)
    try {
      await api.post('/messaging/campaigns', {
        name: name || body.slice(0, 40), body, audience, days, confirm: true,
      })
      setStatus({ kind: 'success', text: 'Sending now. Delivery updates appear below.' })
      setName('')
      setBody('')
      setConfirming(false)
      await loadCampaigns()
    } catch (err) {
      setStatus({ kind: 'error', text: err instanceof ApiError ? err.message : 'Could not send that.' })
    } finally {
      setSending(false)
    }
  }

  async function cancelCampaign(id: string) {
    if (!confirm('Stop sending? Messages already delivered cannot be recalled.')) return
    await api.post(`/messaging/campaigns/${id}/cancel`).catch(() => {})
    await loadCampaigns()
  }

  const showDays = audience === 'lapsed' || audience === 'recent'
  const canSend = body.trim().length > 0 && (preview?.recipient_count ?? 0) > 0

  return (
    <div className="space-y-6">
      <PageHeading title="Text your clients" subtitle="One message, everyone who opted in." />

      {status && <Alert kind={status.kind}>{status.text}</Alert>}

      <Card>
        <div className="space-y-4">
          <Field label="Who gets this?" id="audience">
            <Select id="audience" value={audience}
              onChange={(e) => setAudience(e.target.value as typeof audience)}>
              {AUDIENCES.map((a) => <option key={a.value} value={a.value}>{a.label}</option>)}
            </Select>
          </Field>
          <p className="-mt-2 text-xs text-ink-600">
            {AUDIENCES.find((a) => a.value === audience)?.hint}
          </p>

          {showDays && (
            <div className="w-40">
              <Field label={audience === 'lapsed' ? 'Not seen in (days)' : 'Seen within (days)'} id="days">
                <Input id="days" type="number" min={1} max={3650} value={days}
                  onChange={(e) => setDays(Number(e.target.value) || 1)} />
              </Field>
            </div>
          )}

          <Field
            label="Message"
            id="body"
            hint="Use {{first_name}} to personalize. An opt-out line is added automatically."
          >
            <Textarea id="body" rows={4} maxLength={1200} value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder="Hi {{first_name}} — we have a few openings this Friday. Reply or call to grab one!" />
          </Field>

          <Field label="Campaign name" id="name" hint="Just for your records.">
            <Input id="name" value={name} onChange={(e) => setName(e.target.value)}
              placeholder="Friday openings" maxLength={120} />
          </Field>
        </div>

        {preview && (
          <div className="mt-5 rounded-lg bg-ink-100 p-4">
            <p className="text-sm font-medium text-ink-800">
              {preview.recipient_count} recipient{preview.recipient_count === 1 ? '' : 's'}
              {' · '}{preview.segments} segment{preview.segments === 1 ? '' : 's'} each
              {' · '}{preview.total_segments} total
              {preview.encoding === 'UCS-2' && ' · emoji detected, shorter segments'}
            </p>
            {body.trim() && (
              <div className="mt-3 max-w-sm rounded-2xl rounded-bl-sm bg-white px-4 py-3 text-sm text-ink-900 shadow-sm">
                {preview.preview}
              </div>
            )}
            {preview.sample_recipients.length > 0 && (
              <p className="mt-3 text-xs text-ink-600">
                Going to {preview.sample_recipients.map((r) => r.name).join(', ')}
                {preview.recipient_count > preview.sample_recipients.length &&
                  ` and ${preview.recipient_count - preview.sample_recipients.length} more`}.
              </p>
            )}
          </div>
        )}

        <div className="mt-4 flex flex-wrap items-center gap-3">
          {confirming ? (
            <>
              <Button onClick={send} disabled={sending || !canSend}>
                {sending ? 'Sending…' : `Yes, text ${preview?.recipient_count ?? 0} client${preview?.recipient_count === 1 ? '' : 's'}`}
              </Button>
              <Button variant="ghost" onClick={() => setConfirming(false)}>Back</Button>
            </>
          ) : (
            <Button onClick={() => setConfirming(true)} disabled={!canSend}>Review and send</Button>
          )}
          {confirming && (
            <p className="text-sm text-ink-600">This cannot be undone once messages go out.</p>
          )}
        </div>
      </Card>

      <section>
        <h2 className="mb-3 font-display text-xl text-ink-900">Recent campaigns</h2>
        {campaigns === null ? (
          <Spinner />
        ) : campaigns.length === 0 ? (
          <EmptyState title="Nothing sent yet" />
        ) : (
          <ul className="space-y-2">
            {campaigns.map((c) => (
              <li key={c.id}>
                <Card className="p-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="font-medium text-ink-900">{c.name}</p>
                      <p className="mt-0.5 line-clamp-2 text-sm text-ink-600">{c.body}</p>
                      <p className="mt-1 text-xs text-ink-400">{dateTime(c.created_at)} · {c.audience}</p>
                    </div>
                    <div className="text-right">
                      <Badge>{c.status}</Badge>
                      <p className="mt-1 text-sm text-ink-800">
                        {c.sent_count}/{c.recipient_count} sent
                        {c.failed_count > 0 && <span className="text-red-700"> · {c.failed_count} failed</span>}
                      </p>
                      {c.status === 'sending' && (
                        <button onClick={() => void cancelCampaign(c.id)}
                          className="mt-1 text-xs text-red-700 underline">
                          Stop sending
                        </button>
                      )}
                    </div>
                  </div>
                </Card>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}
