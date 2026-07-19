import { useEffect, useId, useState } from 'react'

export function Panel({
  title,
  children,
  defaultCollapsed = false,
}: {
  title: string
  children: React.ReactNode
  defaultCollapsed?: boolean
}) {
  const bodyId = useId()
  const storageKey = `panel-collapsed:${title}`
  const [collapsed, setCollapsed] = useState(() => {
    try {
      const saved = localStorage.getItem(storageKey)
      if (saved === '1') return true
      if (saved === '0') return false
    } catch {
      // Local UI affordance only; persistence failure is harmless.
    }
    return defaultCollapsed
  })
  const toggle = () => {
    setCollapsed((current) => {
      const next = !current
      try {
        localStorage.setItem(storageKey, next ? '1' : '0')
      } catch {
        // Local UI affordance only; persistence failure is harmless.
      }
      return next
    })
  }
  return (
    <section className={`panel ${collapsed ? 'panel--collapsed' : ''}`}>
      <h2 className="panel__title">
        <button type="button" onClick={toggle} aria-expanded={!collapsed} aria-controls={bodyId}>
          <span className="panel__chevron" aria-hidden="true">{collapsed ? '▸' : '▾'}</span>
          {title}
        </button>
      </h2>
      {!collapsed && <div id={bodyId} className="panel__body">{children}</div>}
    </section>
  )
}

export function Range({
  label,
  value,
  min,
  max,
  step,
  format,
  onChange,
  disabled = false,
}: {
  label: string
  value: number
  min: number
  max: number
  step: number
  format?: (value: number) => string
  onChange: (value: number) => void
  disabled?: boolean
}) {
  const id = useId()
  return (
    <div className="row">
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(Number(event.target.value))}
      />
      <output htmlFor={id} className="row__value">{format ? format(value) : value}</output>
    </div>
  )
}

export function Toggle({
  label,
  checked,
  onChange,
  hint,
  disabled = false,
}: {
  label: string
  checked: boolean
  onChange: (value: boolean) => void | Promise<void>
  hint?: string
  disabled?: boolean
}) {
  return (
    <div className="row toggle-row" aria-disabled={disabled}>
      <label className="toggle">
        <input
          type="checkbox"
          checked={checked}
          disabled={disabled}
          onChange={(event) => void onChange(event.target.checked)}
        />
        <span>
          {label}
          {hint && <span className="toggle__hint">{hint}</span>}
        </span>
      </label>
    </div>
  )
}

export type ConfirmRequest = {
  title: string
  body: string
  confirmLabel?: string
  cancelLabel?: string
  danger?: boolean
  resolve: (value: boolean) => void
}

export function ConfirmDialog({
  request,
  onResolve,
}: {
  request: ConfirmRequest
  onResolve: (value: boolean) => void
}) {
  const titleId = useId()
  const bodyId = useId()
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onResolve(false)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onResolve])
  return (
    <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onResolve(false)}>
      <div
        className="modal"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={bodyId}
      >
        <h2 id={titleId} className="modal__title">{request.title}</h2>
        <p id={bodyId} className="modal__body">{request.body}</p>
        <div className="modal__actions">
          <button type="button" className="btn" onClick={() => onResolve(false)}>
            {request.cancelLabel ?? 'Cancel'}
          </button>
          <button
            type="button"
            className={request.danger ? 'btn btn--danger' : 'btn btn--primary'}
            onClick={() => onResolve(true)}
            autoFocus
          >
            {request.confirmLabel ?? 'Continue'}
          </button>
        </div>
      </div>
    </div>
  )
}
