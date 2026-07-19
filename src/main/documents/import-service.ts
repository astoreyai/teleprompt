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

  constructor(
    private readonly parser: DocumentParser,
    options: { maxInputBytes?: number; maxOutputChars?: number; maxConcurrent?: number } = {},
  ) {
    this.maxInputBytes = options.maxInputBytes ?? 10 * 1024 * 1024
    this.maxOutputChars = options.maxOutputChars ?? 10 * 1024 * 1024
    this.semaphore = new AsyncSemaphore(options.maxConcurrent ?? 2)
  }

  async loadPath(path: string, signal?: AbortSignal): Promise<ImportedDocument> {
    const format = classifyDocumentPath(path)
    if (!format) throw new Error('unsupported document format')
    const release = await this.semaphore.acquire(signal)
    try {
      if (signal?.aborted) throw new Error('document import cancelled')
      const source = await readBoundedRegularFile(path, this.maxInputBytes)
      const canonicalPath = await realpath(path)
      const content = await this.parser.parse(
        format,
        source.bytes,
        this.maxOutputChars,
        signal,
      )
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
      release()
    }
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

  constructor(private readonly capacity: number) {
    if (!Number.isSafeInteger(capacity) || capacity < 1) throw new Error('invalid import concurrency')
  }

  acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) return Promise.reject(new Error('document import cancelled'))
    if (this.active < this.capacity) {
      this.active += 1
      return Promise.resolve(this.releaseOnce())
    }
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
