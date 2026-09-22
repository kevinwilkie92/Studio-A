import { useEffect, useState, type FormEvent } from 'react'
import { api, ApiError, type Payment, type User } from '../lib/api'
import { useAuth } from '../lib/auth'
import { dateOf, money } from '../lib/format'
import { Alert, Button, Card, Field, Input, PageHeading } from '../components/ui'

export default function Account() {
  const { user, setUser } = useAuth()
  const [form, setForm] = useState({
    first_name: user?.first_name ?? '',
    last_name: user?.last_name ?? '',
    phone: user?.phone ?? '',
  })
  const [smsOptIn, setSmsOptIn] = useState(Boolean(user?.sms_opt_in))
  const [status, setStatus] = useState<{ kind: 'error' | 'success'; text: string } | null>(null)
  const [busy, setBusy] = useState(false)

  const [pw, setPw] = useState({ current_password: '', new_password: '' })
  const [pwStatus, setPwStatus] = useState<{ kind: 'error' | 'success'; text: string } | null>(null)

  const [payments, setPayments] = useState<Payment[]>([])
  useEffect(() => {
    void api.get<{ payments: Payment[] }>('/payments').then((r) => setPayments(r.payments)).catch(() => {})
  }, [])

  async function saveProfile(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setStatus(null)
    try {
      const res = await api.patch<{ user: User }>('/auth/me', { ...form, sms_opt_in: smsOptIn })
      setUser(res.user)
      setStatus({ kind: 'success', text: 'Saved.' })
    } catch (err) {
      setStatus({ kind: 'error', text: err instanceof ApiError ? err.message : 'Could not save.' })
    } finally {
      setBusy(false)
    }
  }

  async function changePassword(e: FormEvent) {
    e.preventDefault()
    setPwStatus(null)
    try {
      await api.post('/auth/password', pw)
      setPw({ current_password: '', new_password: '' })
      setPwStatus({ kind: 'success', text: 'Password updated. Other devices were signed out.' })
    } catch (err) {
      setPwStatus({ kind: 'error', text: err instanceof ApiError ? err.message : 'Could not update password.' })
    }
  }

  return (
    <div className="mx-auto max-w-lg space-y-6">
      <PageHeading title="Your account" />

      <Card>
        <form onSubmit={saveProfile} className="space-y-4">
          <h2 className="font-display text-lg text-ink-900">Details</h2>
          {status && <Alert kind={status.kind}>{status.text}</Alert>}

          <div className="grid grid-cols-2 gap-3">
            <Field label="First name" id="first_name">
              <Input id="first_name" value={form.first_name}
                onChange={(e) => setForm({ ...form, first_name: e.target.value })} required />
            </Field>
            <Field label="Last name" id="last_name">
              <Input id="last_name" value={form.last_name}
                onChange={(e) => setForm({ ...form, last_name: e.target.value })} />
            </Field>
          </div>

          <Field label="Email" id="email" hint="Contact the salon to change this.">
            <Input id="email" value={user?.email ?? ''} disabled />
          </Field>

          <Field label="Mobile number" id="phone">
            <Input id="phone" type="tel" value={form.phone}
              onChange={(e) => setForm({ ...form, phone: e.target.value })} />
          </Field>

          <label className="flex items-start gap-2.5 text-sm text-ink-600">
            <input type="checkbox" className="mt-0.5 h-4 w-4 rounded border-ink-200 text-ink-900"
              checked={smsOptIn} disabled={!form.phone}
              onChange={(e) => setSmsOptIn(e.target.checked)} />
            <span>Text me appointment reminders and occasional updates.</span>
          </label>

          <Button type="submit" disabled={busy}>{busy ? 'Saving…' : 'Save changes'}</Button>
        </form>
      </Card>

      <Card>
        <form onSubmit={changePassword} className="space-y-4">
          <h2 className="font-display text-lg text-ink-900">Password</h2>
          {pwStatus && <Alert kind={pwStatus.kind}>{pwStatus.text}</Alert>}
          <Field label="Current password" id="current_password">
            <Input id="current_password" type="password" autoComplete="current-password" required
              value={pw.current_password} onChange={(e) => setPw({ ...pw, current_password: e.target.value })} />
          </Field>
          <Field label="New password" id="new_password" hint="At least 8 characters.">
            <Input id="new_password" type="password" autoComplete="new-password" required minLength={8}
              value={pw.new_password} onChange={(e) => setPw({ ...pw, new_password: e.target.value })} />
          </Field>
          <Button type="submit" variant="secondary">Update password</Button>
        </form>
      </Card>

      {payments.length > 0 && (
        <Card>
          <h2 className="font-display text-lg text-ink-900">Payment history</h2>
          <ul className="mt-3 divide-y divide-ink-200 text-sm">
            {payments.map((p) => (
              <li key={p.id} className="flex items-center justify-between py-2.5">
                <div>
                  <p className="text-ink-900">{money(p.amount_cents + p.tip_cents)}</p>
                  <p className="text-xs text-ink-400">
                    {dateOf(p.created_at)} · {p.method}
                    {p.tip_cents > 0 && ` · includes ${money(p.tip_cents)} tip`}
                  </p>
                </div>
                <span className="text-xs capitalize text-ink-600">{p.status}</span>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  )
}
