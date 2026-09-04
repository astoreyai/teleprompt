import { createHash } from 'node:crypto'
import { realpath } from 'node:fs/promises'
import { basename } from 'node:path'
import type { DocumentFormat } from '../../shared/contracts.js'
import { classifyDocumentPath } from '../files/file-policy.js'
import { readBoundedRegularFile } from '../files/safe-reader.js'

export type ImportedDocument = {
  name: string
  sourcePath: string
  format: DocumentFormat
  content: string
  sourceMtimeMs: number
  sourceHash: string
  dirty: false
}

export type DocumentParser = {
  parse(
    format: DocumentFormat,
    bytes: Uint8Array,
    maxOutputChars: number,
    signal?: AbortSignal,
  ): Promise<string>
}

export class DocumentImportService {
  private readonly maxInputBytes: number
  private readonly maxOutputChars: number
  private readonly semaphore: AsyncSemaphore
  private readonly activeImports = new Set<AbortController>()
  private disposed = false

  constructor(
    private readonly parser: DocumentParser,
    options: { maxInputBytes?: number; maxOutputChars?: number; maxConcurrent?: number; maxPending?: number } = {},
  ) {
    this.maxInputBytes = options.maxInputBytes ?? 10 * 1024 * 1024
    this.maxOutputChars = options.maxOutputChars ?? 10 * 1024 * 1024
    this.semaphore = new AsyncSemaphore(options.maxConcurrent ?? 2, options.maxPending ?? 16)
  }

  async loadPath(path: string, signal?: AbortSignal): Promise<ImportedDocument> {
    if (this.disposed) throw new Error('document import service closed')
    const format = classifyDocumentPath(path)
    if (!format) throw new Error('unsupported document format')
    const ownerSignal = signal
    const controller = new AbortController()
    const onAbort = () => controller.abort()
    if (signal?.aborted) controller.abort()
    else signal?.addEventListener('abort', onAbort, { once: true })
    this.activeImports.add(controller)
    let release: (() => void) | undefined
    try {
      signal = controller.signal
      release = await this.semaphore.acquire(signal)
      if (signal?.aborted) throw new Error('document import cancelled')
      const source = await readBoundedRegularFile(path, this.maxInputBytes)
      if (signal.aborted) throw new Error('document import cancelled')
      const canonicalPath = await realpath(path)
      const content = await this.parser.parse(
        format,
        source.bytes,
        this.maxOutputChars,
        signal,
      )
      if (signal.aborted) throw new Error('document import cancelled')
      return {
        name: basename(canonicalPath).slice(0, 200),
        sourcePath: canonicalPath,
        format,
        content,
        sourceMtimeMs: source.mtimeMs,
        sourceHash: createHash('sha256').update(source.bytes).digest('hex'),
        dirty: false,
      }
    } finally {
      release?.()
      ownerSignal?.removeEventListener('abort', onAbort)
      this.activeImports.delete(controller)
    }
  }

  dispose(): void {
    this.disposed = true
    this.cancelPending()
  }

  cancelPending(): void {
    for (const controller of this.activeImports) controller.abort()
  }
}

class AsyncSemaphore {
  private active = 0
  private readonly waiters: Array<{
    resolve: (release: () => void) => void
    reject: (error: Error) => void
    signal?: AbortSignal
    onAbort?: () => void
  }> = []

  constructor(private readonly capacity: number, private readonly maxPending: number) {
    if (!Number.isSafeInteger(capacity) || capacity < 1) throw new Error('invalid import concurrency')
    if (!Number.isSafeInteger(maxPending) || maxPending < 0) throw new Error('invalid import queue limit')
  }

  acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) return Promise.reject(new Error('document import cancelled'))
    if (this.active < this.capacity) {
      this.active += 1
      return Promise.resolve(this.releaseOnce())
    }
    if (this.waiters.length >= this.maxPending) return Promise.reject(new Error('document import queue is full'))
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject, signal } as (typeof this.waiters)[number]
      if (signal) {
        waiter.onAbort = () => {
          const index = this.waiters.indexOf(waiter)
          if (index >= 0) this.waiters.splice(index, 1)
          reject(new Error('document import cancelled'))
        }
        signal.addEventListener('abort', waiter.onAbort, { once: true })
      }
      this.waiters.push(waiter)
    })
  }

  private releaseOnce(): () => void {
    let released = false
    return () => {
      if (released) return
      released = true
      const next = this.waiters.shift()
      if (next) {
        if (next.signal && next.onAbort) next.signal.removeEventListener('abort', next.onAbort)
        next.resolve(this.releaseOnce())
      } else {
        this.active -= 1
      }
    }
  }
}
