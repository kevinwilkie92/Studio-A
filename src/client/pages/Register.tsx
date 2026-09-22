import { useState, type FormEvent } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { api, ApiError, type User } from '../lib/api'
import { useAuth } from '../lib/auth'
import { Alert, Button, Card, Field, Input, PageHeading } from '../components/ui'

export default function Register() {
  const { setUser, refresh } = useAuth()
  const navigate = useNavigate()

  const [form, setForm] = useState({
    first_name: '', last_name: '', email: '', phone: '', password: '',
  })
  const [smsOptIn, setSmsOptIn] = useState(true)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const update = (key: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm((f) => ({ ...f, [key]: e.target.value }))

  async function submit(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError('')
    try {
      const res = await api.post<{ user: User }>('/auth/register', { ...form, sms_opt_in: smsOptIn })
      setUser(res.user)
      await refresh()
      navigate('/book', { replace: true })
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not create your account. Try again.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mx-auto max-w-sm">
      <PageHeading title="Create your account" subtitle="It takes about thirty seconds." />
      <Card>
        <form onSubmit={submit} className="space-y-4">
          {error && <Alert>{error}</Alert>}
          <div className="grid grid-cols-2 gap-3">
            <Field label="First name" id="first_name">
              <Input id="first_name" required autoComplete="given-name"
                value={form.first_name} onChange={update('first_name')} />
            </Field>
            <Field label="Last name" id="last_name">
              <Input id="last_name" autoComplete="family-name"
                value={form.last_name} onChange={update('last_name')} />
            </Field>
          </div>
          <Field label="Email" id="email">
            <Input id="email" type="email" required autoComplete="email"
              value={form.email} onChange={update('email')} />
          </Field>
          <Field label="Mobile number" id="phone" hint="Used for appointment reminders. Optional.">
            <Input id="phone" type="tel" autoComplete="tel" placeholder="(804) 555-1234"
              value={form.phone} onChange={update('phone')} />
          </Field>
          <Field label="Password" id="password" hint="At least 8 characters.">
            <Input id="password" type="password" required minLength={8} autoComplete="new-password"
              value={form.password} onChange={update('password')} />
          </Field>

          <label className="flex items-start gap-2.5 text-sm text-ink-600">
            <input
              type="checkbox" className="mt-0.5 h-4 w-4 rounded border-ink-200 text-ink-900"
              checked={smsOptIn} onChange={(e) => setSmsOptIn(e.target.checked)}
              disabled={!form.phone}
            />
            <span>
              Text me appointment reminders and occasional updates.
              {!form.phone && <em className="block text-xs text-ink-400">Add a mobile number to enable this.</em>}
            </span>
          </label>

          <Button type="submit" className="w-full" disabled={busy}>
            {busy ? 'Creating…' : 'Create account'}
          </Button>
        </form>
      </Card>
      <p className="mt-4 text-center text-sm text-ink-600">
        Already have an account? <Link to="/login" className="underline">Sign in</Link>
      </p>
    </div>
  )
}
