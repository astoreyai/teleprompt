import { describe, expect, it, vi } from 'vitest'
import { ParserSupervisor, type ParserWorkerHandle } from './supervisor.js'

class FakeWorker implements ParserWorkerHandle {
  killed = false
  throwOnKill = false
  sent: unknown[] = []
  private messageListeners = new Set<(message: unknown) => void>()
  private exitListeners = new Set<(code: number) => void>()

  postMessage(message: unknown): void {
    this.sent.push(message)
  }

  onMessage(listener: (message: unknown) => void): () => void {
    this.messageListeners.add(listener)
    return () => this.messageListeners.delete(listener)
  }

  onExit(listener: (code: number) => void): () => void {
    this.exitListeners.add(listener)
    return () => this.exitListeners.delete(listener)
  }

  kill(): void {
    this.killed = true
    if (this.throwOnKill) throw new Error('already gone')
  }

  respond(message: unknown): void {
    for (const listener of this.messageListeners) listener(message)
  }

  exit(code: number): void {
    for (const listener of this.exitListeners) listener(code)
  }
}

describe('parser supervisor', () => {
  it('returns validated parser output and terminates the one-shot worker', async () => {
    const worker = new FakeWorker()
    const supervisor = new ParserSupervisor(() => worker, { timeoutMs: 1000 })
    const pending = supervisor.parse('text', Buffer.from('input'), 100)
    worker.respond({ ok: true, content: 'output' })
    await expect(pending).resolves.toBe('output')
    expect(worker.killed).toBe(true)
  })

  it('kills timed-out workers', async () => {
    vi.useFakeTimers()
    const worker = new FakeWorker()
    const supervisor = new ParserSupervisor(() => worker, { timeoutMs: 100 })
    const pending = supervisor.parse('text', Buffer.from('input'), 100)
    const assertion = expect(pending).rejects.toThrow('parser timed out')
    await vi.advanceTimersByTimeAsync(101)
    await assertion
    expect(worker.killed).toBe(true)
    vi.useRealTimers()
  })

  it('rejects worker crashes and oversized or malformed responses', async () => {
    const crashed = new FakeWorker()
    const crashPending = new ParserSupervisor(() => crashed).parse('text', Buffer.from('x'), 10)
    crashed.exit(9)
    await expect(crashPending).rejects.toThrow('parser process exited with code 9')

    const oversized = new FakeWorker()
    const oversizedPending = new ParserSupervisor(() => oversized).parse(
      'text',
      Buffer.from('x'),
      3,
    )
    oversized.respond({ ok: true, content: '1234' })
    await expect(oversizedPending).rejects.toThrow('parser returned oversized output')

    const malformed = new FakeWorker()
    const malformedPending = new ParserSupervisor(() => malformed).parse(
      'text',
      Buffer.from('x'),
      10,
    )
    malformed.respond({ surprise: true })
    await expect(malformedPending).rejects.toThrow('invalid parser response')
  })

  it('settles the parse even when cleanup races an already-dead worker', async () => {
    const worker = new FakeWorker()
    worker.throwOnKill = true
    const pending = new ParserSupervisor(() => worker).parse('text', Buffer.from('x'), 10)

    expect(() => worker.respond({ ok: true, content: 'safe' })).not.toThrow()
    await expect(pending).resolves.toBe('safe')
  })
})
