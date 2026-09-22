/**
 * Loads Stripe.js on demand.
 *
 * The script is only injected when someone actually opens a payment form, so
 * the booking flow does not pay for it. Card details are entered inside
 * Stripe's iframe and never reach this app or its Worker.
 */

// Stripe.js is loaded at runtime from a <script> tag, so there are no types
// for it here. The surface used is small and pinned by these interfaces.
export interface StripePaymentElement {
  mount(selector: string | HTMLElement): void
  unmount(): void
  destroy(): void
}

export interface StripeElements {
  create(type: 'payment', options?: Record<string, unknown>): StripePaymentElement
}

export interface StripeLike {
  elements(options: Record<string, unknown>): StripeElements
  confirmPayment(options: {
    elements: StripeElements
    redirect: 'if_required'
    confirmParams?: Record<string, unknown>
  }): Promise<{ error?: { message?: string }; paymentIntent?: { id: string; status: string } }>
}

declare global {
  interface Window {
    Stripe?: (key: string) => StripeLike
  }
}

const SRC = 'https://js.stripe.com/v3/'
let loader: Promise<void> | null = null

function loadScript(): Promise<void> {
  if (window.Stripe) return Promise.resolve()
  loader ??= new Promise<void>((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(`script[src="${SRC}"]`)
    if (existing) {
      existing.addEventListener('load', () => resolve())
      existing.addEventListener('error', () => reject(new Error('Could not load Stripe.')))
      return
    }
    const script = document.createElement('script')
    script.src = SRC
    script.async = true
    script.onload = () => resolve()
    script.onerror = () => {
      loader = null // let a later attempt retry
      reject(new Error('Could not load Stripe.'))
    }
    document.head.appendChild(script)
  })
  return loader
}

export async function getStripe(publishableKey: string): Promise<StripeLike> {
  await loadScript()
  if (!window.Stripe) throw new Error('Stripe failed to initialize.')
  return window.Stripe(publishableKey)
}
