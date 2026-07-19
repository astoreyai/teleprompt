export type RendererExitReason =
  | 'clean-exit'
  | 'abnormal-exit'
  | 'killed'
  | 'crashed'
  | 'oom'
  | 'launch-failed'
  | 'integrity-failure'
  | string

export type RecoveryDecision =
  | { action: 'none' }
  | { action: 'reload'; delayMs: number }
  | { action: 'recreate'; delayMs: number }
  | { action: 'give-up' }

export class RendererRecoveryPolicy {
  private attempts: number[] = []
  private readonly maxAttempts: number
  private readonly windowMs: number
  private readonly baseDelayMs: number

  constructor(options: { maxAttempts?: number; windowMs?: number; baseDelayMs?: number } = {}) {
    this.maxAttempts = Math.max(1, Math.floor(options.maxAttempts ?? 3))
    this.windowMs = Math.max(1, Math.floor(options.windowMs ?? 60_000))
    this.baseDelayMs = Math.max(0, Math.floor(options.baseDelayMs ?? 250))
  }

  decide(input: {
    reason: RendererExitReason
    now: number
    appQuitting: boolean
  }): RecoveryDecision {
    if (input.appQuitting || input.reason === 'clean-exit') return { action: 'none' }

    this.attempts = this.attempts.filter((attempt) => input.now - attempt < this.windowMs)
    this.attempts.push(input.now)
    const count = this.attempts.length

    if (count > this.maxAttempts) return { action: 'give-up' }
    const delayMs = this.baseDelayMs * 2 ** (count - 1)
    if (HARD_FAILURES.has(input.reason)) return { action: 'recreate', delayMs }
    if (count === this.maxAttempts) return { action: 'recreate', delayMs }
    return { action: 'reload', delayMs }
  }

  reset(): void {
    this.attempts = []
  }
}

const HARD_FAILURES = new Set<RendererExitReason>([
  'crashed',
  'oom',
  'launch-failed',
  'integrity-failure',
])
