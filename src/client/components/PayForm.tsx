import { useEffect, useRef, useState } from 'react'
import { api, ApiError } from '../lib/api'
import { getStripe, type StripeElements, type StripeLike } from '../lib/stripe'
import { money } from '../lib/format'
import { Alert, Button } from './ui'

interface Props {
  appointmentId: string
  /** Balance owed, in cents, before any tip. */
  amountCents: number
  publishableKey: string
  onPaid: () => void
}

const TIP_PERCENTS = [0, 15, 18, 20, 25]

export default function PayForm({ appointmentId, amountCents, publishableKey, onPaid }: Props) {
  const [tipPercent, setTipPercent] = useState(20)
  const [stage, setStage] = useState<'choose' | 'card' | 'paying' | 'done'>('choose')
  const [error, setError] = useState('')

  const mountRef = useRef<HTMLDivElement>(null)
  const stripeRef = useRef<StripeLike | null>(null)
  const elementsRef = useRef<StripeElements | null>(null)

  const tipCents = Math.round((amountCents * tipPercent) / 100)
  const chargeCents = amountCents + tipCents

  async function startPayment() {
    setError('')
    setStage('card')
    try {
      const intent = await api.post<{ client_secret: string }>('/payments/intent', {
        appointment_id: appointmentId,
        amount_cents: amountCents,
        tip_cents: tipCents,
        kind: 'balance',
      })

      const stripe = await getStripe(publishableKey)
      stripeRef.current = stripe
      const elements = stripe.elements({
        clientSecret: intent.client_secret,
        appearance: { theme: 'flat', variables: { colorPrimary: '#1c1917', borderRadius: '8px' } },
      })
      elementsRef.current = elements
      elements.create('payment').mount(mountRef.current ?? '#payment-element')
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not start the payment.')
      setStage('choose')
    }
  }

  async function submit() {
    const stripe = stripeRef.current
    const elements = elementsRef.current
    if (!stripe || !elements) return

    setStage('paying')
    setError('')
    const result = await stripe.confirmPayment({ elements, redirect: 'if_required' })

    if (result.error) {
      setError(result.error.message ?? 'That card was declined.')
      setStage('card')
      return
    }

    // Tell the server right away so the receipt is there immediately; the
    // Stripe webhook confirms the same payment independently.
    if (result.paymentIntent) {
      await api.post('/payments/confirm', { payment_intent_id: result.paymentIntent.id }).catch(() => {})
    }
    setStage('done')
    onPaid()
  }

  // Tear the iframe down if the component unmounts mid-payment.
  useEffect(() => () => { elementsRef.current = null }, [])

  if (stage === 'done') return <Alert kind="success">Paid. Thank you!</Alert>

  return (
    <div className="space-y-4">
      {error && <Alert>{error}</Alert>}

      {stage === 'choose' && (
        <>
          <div>
            <p className="text-sm font-medium text-ink-800">Add a tip?</p>
            <div className="mt-2 flex flex-wrap gap-2">
              {TIP_PERCENTS.map((pct) => (
                <button
                  key={pct}
                  onClick={() => setTipPercent(pct)}
                  className={`rounded-lg px-3 py-2 text-sm font-medium ring-1 transition-colors ${
                    tipPercent === pct
                      ? 'bg-ink-900 text-ink-50 ring-ink-900'
                      : 'bg-white text-ink-800 ring-ink-200 hover:bg-ink-100'
                  }`}
                >
                  {pct === 0 ? 'No tip' : `${pct}%`}
                </button>
              ))}
            </div>
          </div>

          <dl className="space-y-1 border-t border-ink-200 pt-3 text-sm">
            <div className="flex justify-between">
              <dt className="text-ink-600">Balance</dt>
              <dd className="text-ink-900">{money(amountCents)}</dd>
            </div>
            {tipCents > 0 && (
              <div className="flex justify-between">
                <dt className="text-ink-600">Tip</dt>
                <dd className="text-ink-900">{money(tipCents)}</dd>
              </div>
            )}
            <div className="flex justify-between font-medium">
              <dt className="text-ink-800">Total</dt>
              <dd className="text-ink-900">{money(chargeCents)}</dd>
            </div>
          </dl>

          <Button className="w-full" onClick={startPayment}>Pay {money(chargeCents)}</Button>
        </>
      )}

      {(stage === 'card' || stage === 'paying') && (
        <>
          <div id="payment-element" ref={mountRef} className="min-h-[220px]" />
          <Button className="w-full" onClick={submit} disabled={stage === 'paying'}>
            {stage === 'paying' ? 'Processing…' : `Pay ${money(chargeCents)}`}
          </Button>
          <p className="text-center text-xs text-ink-400">
            Card details go straight to Stripe. We never see them.
          </p>
        </>
      )}
    </div>
  )
}
