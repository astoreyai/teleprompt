import { describe, expect, it } from 'vitest'
import { RendererRecoveryPolicy } from './recovery-policy.js'

describe('renderer recovery policy', () => {
  it('never recovers clean exits or any exit while the app is quitting', () => {
    const policy = new RendererRecoveryPolicy()
    expect(policy.decide({ reason: 'clean-exit', now: 1, appQuitting: false })).toEqual({ action: 'none' })
    expect(policy.decide({ reason: 'crashed', now: 2, appQuitting: true })).toEqual({ action: 'none' })
  })

  it('defers recovery and applies a bounded backoff before giving up', () => {
    const policy = new RendererRecoveryPolicy({ maxAttempts: 3, windowMs: 60_000, baseDelayMs: 100 })
    expect(policy.decide({ reason: 'crashed', now: 0, appQuitting: false })).toEqual({
      action: 'recreate',
      delayMs: 100,
    })
    expect(policy.decide({ reason: 'oom', now: 10, appQuitting: false })).toEqual({
      action: 'recreate',
      delayMs: 200,
    })
    expect(policy.decide({ reason: 'killed', now: 20, appQuitting: false })).toEqual({
      action: 'recreate',
      delayMs: 400,
    })
    expect(policy.decide({ reason: 'crashed', now: 30, appQuitting: false })).toEqual({
      action: 'give-up',
    })
  })

  it('uses an in-place reload only for recoverable abnormal exits', () => {
    const policy = new RendererRecoveryPolicy({ baseDelayMs: 10 })
    expect(policy.decide({ reason: 'abnormal-exit', now: 0, appQuitting: false })).toEqual({
      action: 'reload',
      delayMs: 10,
    })
  })

  it('budgets unresponsive recreation and permits deliberate reset', () => {
    const policy = new RendererRecoveryPolicy()
    const now = Date.now()
    for (let attempt = 0; attempt < 3; attempt += 1) {
      expect(policy.decide({ reason: 'unresponsive', now, appQuitting: false }).action).toBe('recreate')
    }
    expect(policy.decide({ reason: 'unresponsive', now, appQuitting: false }).action).toBe('give-up')
    policy.reset()
    expect(policy.decide({ reason: 'unresponsive', now, appQuitting: false }).action).toBe('recreate')
  })

  it('expires crash attempts after the documented healthy interval', () => {
    const policy = new RendererRecoveryPolicy()
    const now = Date.now()
    for (let attempt = 0; attempt < 4; attempt += 1) policy.decide({ reason: 'crashed', now, appQuitting: false })
    expect(policy.decide({ reason: 'crashed', now: now + 60_000, appQuitting: false })).toEqual({ action: 'recreate', delayMs: 250 })
  })

})
