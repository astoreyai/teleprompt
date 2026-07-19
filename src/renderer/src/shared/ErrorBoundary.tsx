import { Component, type ErrorInfo, type ReactNode } from 'react'

export class ErrorBoundary extends Component<
  { surface: 'controls' | 'overlay'; children: ReactNode },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null }

  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error(`[renderer:${this.props.surface}]`, error, info.componentStack)
  }

  render(): ReactNode {
    if (!this.state.error) return this.props.children
    return (
      <main className={`renderer-error renderer-error--${this.props.surface}`} role="alert">
        <h1>{this.props.surface === 'controls' ? 'Controls need to restart' : 'Overlay needs to restart'}</h1>
        <p>{this.state.error.message || 'An unexpected renderer error occurred.'}</p>
        <button type="button" onClick={() => window.location.reload()}>Restart this window</button>
      </main>
    )
  }
}
