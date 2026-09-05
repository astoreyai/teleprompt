import type { DocumentFormat } from '../../shared/contracts.js'

export type ParserWorkerHandle = {
  postMessage(message: unknown): void
  onMessage(listener: (message: unknown) => void): () => void
  onExit(listener: (code: number) => void): () => void
  onError?(listener: (error: Error) => void): () => void
  kill(): void
}

export class ParserSupervisor {
  private readonly timeoutMs: number

  constructor(
    private readonly spawn: () => ParserWorkerHandle,
    options: { timeoutMs?: number } = {},
  ) {
    this.timeoutMs = Math.max(1, options.timeoutMs ?? 10_000)
  }

  parse(
    format: DocumentFormat,
    bytes: Uint8Array,
    maxOutputChars: number,
    signal?: AbortSignal,
  ): Promise<string> {
    if (signal?.aborted) return Promise.reject(new Error('parser cancelled'))
    const worker = this.spawn()
    return new Promise<string>((resolve, reject) => {
      let settled = false
      let outcome: { content: string } | { error: Error } | undefined
      let removeMessage: () => void = () => {}
      let removeExit: () => void = () => {}
      let removeError: () => void = () => {}

      const finish = (result: { content: string } | { error: Error }) => {
        if (settled || outcome) return
        outcome = result
        clearTimeout(timer)
        removeMessage()
        removeError()
        signal?.removeEventListener('abort', onAbort)
        try {
          worker.kill()
        } catch {
          // The utility process may have already exited between response and cleanup.
        }
        // Settlement releases the import semaphore. Wait for actual exit so a
        // timed-out or cancelled native parser still counts against capacity.
      }
      const onAbort = () => finish({ error: new Error('parser cancelled') })
      const timer = setTimeout(
        () => finish({ error: new Error(`parser timed out after ${this.timeoutMs}ms`) }),
        this.timeoutMs,
      )
      timer.unref?.()
      removeMessage = worker.onMessage((message) => {
        const response = asRecord(message)
        if (!response || typeof response.ok !== 'boolean') {
          finish({ error: new Error('invalid parser response') })
          return
        }
        if (response.ok) {
          if (typeof response.content !== 'string') {
            finish({ error: new Error('invalid parser response') })
          } else if (response.content.length > maxOutputChars) {
            finish({ error: new Error('parser returned oversized output') })
          } else {
            finish({ content: response.content })
          }
          return
        }
        const errorMessage =
          typeof response.error === 'string' && response.error.length > 0
            ? response.error.slice(0, 500)
            : 'document parsing failed'
        finish({ error: new Error(errorMessage) })
      })
      removeExit = worker.onExit((code) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        removeMessage()
        removeExit()
        removeError()
        signal?.removeEventListener('abort', onAbort)
        const result = outcome ?? { error: new Error(`parser process exited with code ${code}`) }
        if ('content' in result) resolve(result.content)
        else reject(result.error)
      })
      removeError = worker.onError?.(error => finish({ error })) ?? (() => {})
      signal?.addEventListener('abort', onAbort, { once: true })
      if (signal?.aborted) { onAbort(); return }
      try {
        worker.postMessage({ format, bytes: new Uint8Array(bytes), maxOutputChars })
      } catch (error) {
        finish({
          error: error instanceof Error ? error : new Error('unable to start parser process'),
        })
      }
    })
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}
