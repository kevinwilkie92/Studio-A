import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, SelectHTMLAttributes, TextareaHTMLAttributes } from 'react'
import { Link } from 'react-router-dom'

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger'

const VARIANTS: Record<Variant, string> = {
  primary: 'bg-ink-900 text-ink-50 hover:bg-ink-800 disabled:bg-ink-400',
  secondary: 'bg-white text-ink-900 ring-1 ring-ink-200 hover:bg-ink-100 disabled:text-ink-400',
  ghost: 'text-ink-600 hover:bg-ink-100 hover:text-ink-900',
  danger: 'bg-white text-red-700 ring-1 ring-red-200 hover:bg-red-50',
}

const BASE =
  'inline-flex items-center justify-center gap-2 rounded-lg px-4 py-2.5 text-sm font-medium ' +
  'transition-colors disabled:cursor-not-allowed'

export function Button({
  variant = 'primary', className = '', children, ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant }) {
  return (
    <button className={`${BASE} ${VARIANTS[variant]} ${className}`} {...props}>
      {children}
    </button>
  )
}

export function LinkButton({
  to, variant = 'primary', className = '', children,
}: { to: string; variant?: Variant; className?: string; children: ReactNode }) {
  return (
    <Link to={to} className={`${BASE} ${VARIANTS[variant]} ${className}`}>
      {children}
    </Link>
  )
}

export function Card({ className = '', children }: { className?: string; children: ReactNode }) {
  return (
    <div className={`rounded-xl bg-white p-5 shadow-sm ring-1 ring-ink-200/70 ${className}`}>{children}</div>
  )
}

export function Field({
  label, hint, error, children, id,
}: { label: string; hint?: string; error?: string; children: ReactNode; id?: string }) {
  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="block text-sm font-medium text-ink-800">{label}</label>
      {children}
      {hint && !error && <p className="text-xs text-ink-600">{hint}</p>}
      {error && <p className="text-xs text-red-700">{error}</p>}
    </div>
  )
}

const CONTROL =
  'w-full rounded-lg border-0 bg-white px-3 py-2.5 text-sm text-ink-900 shadow-sm ' +
  'ring-1 ring-ink-200 placeholder:text-ink-400 focus:ring-2 focus:ring-accent-600'

export function Input({ className = '', ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={`${CONTROL} ${className}`} {...props} />
}

export function Textarea({ className = '', ...props }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={`${CONTROL} ${className}`} {...props} />
}

export function Select({ className = '', children, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select className={`${CONTROL} ${className}`} {...props}>{children}</select>
}

export function Alert({ kind = 'error', children }: { kind?: 'error' | 'success' | 'info'; children: ReactNode }) {
  const tone = {
    error: 'bg-red-50 text-red-800 ring-red-200',
    success: 'bg-emerald-50 text-emerald-800 ring-emerald-200',
    info: 'bg-accent-100 text-ink-800 ring-accent-400/40',
  }[kind]
  return <div role="alert" className={`rounded-lg px-4 py-3 text-sm ring-1 ${tone}`}>{children}</div>
}

const STATUS_TONE: Record<string, string> = {
  booked: 'bg-accent-100 text-ink-800',
  confirmed: 'bg-emerald-100 text-emerald-800',
  completed: 'bg-ink-100 text-ink-600',
  cancelled: 'bg-red-50 text-red-700',
  no_show: 'bg-red-100 text-red-800',
}

export function Badge({ children, tone }: { children: ReactNode; tone?: string }) {
  const cls = (tone && STATUS_TONE[tone]) ?? 'bg-ink-100 text-ink-600'
  return (
    <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium capitalize ${cls}`}>
      {children}
    </span>
  )
}

export function Spinner({ label = 'Loading' }: { label?: string }) {
  return (
    <div className="flex items-center justify-center gap-3 py-12 text-sm text-ink-600">
      <span
        aria-hidden
        className="h-4 w-4 animate-spin rounded-full border-2 border-ink-200 border-t-ink-900"
      />
      <span>{label}…</span>
    </div>
  )
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="rounded-xl border border-dashed border-ink-200 px-6 py-10 text-center">
      <p className="font-medium text-ink-800">{title}</p>
      {children && <div className="mt-2 text-sm text-ink-600">{children}</div>}
    </div>
  )
}

export function PageHeading({ title, subtitle, action }: { title: string; subtitle?: string; action?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div>
        <h1 className="font-display text-2xl text-ink-900 sm:text-3xl">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-ink-600">{subtitle}</p>}
      </div>
      {action}
    </div>
  )
}
