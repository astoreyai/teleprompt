import { createHash } from 'node:crypto'
import { readFile, realpath, stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DocumentImportService, type DocumentParser } from './import-service.js'
import { parseDocumentBytes } from '../parser/parser-core.js'

// Provenance: checked-in README.md and build/icon.png; original bytes, no transformations.
const sourcePath = resolve('README.md')
function observedParser(): { parser: DocumentParser; calls: () => number } {
  let calls = 0
  return {
    calls: () => calls,
    parser: {
      parse: async (format, bytes, maxOutputChars) => {
        calls += 1
        return parseDocumentBytes(format, bytes, { maxOutputChars })
      },
    },
  }
}

describe('unified document import service with real repository inputs', () => {
  it('classifies, bounds, fingerprints, and parses a source through one pipeline', async () => {
    const bytes = await readFile(sourcePath)
    const observed = observedParser()
    const service = new DocumentImportService(observed.parser)
    const loaded = await service.loadPath(sourcePath)
    expect(loaded).toEqual({
      name: 'README.md', sourcePath: await realpath(sourcePath), format: 'markdown',
      content: bytes.toString('utf8'), dirty: false,
      sourceMtimeMs: (await stat(sourcePath)).mtimeMs,
      sourceHash: createHash('sha256').update(bytes).digest('hex'),
    })
    expect(observed.calls()).toBe(1)
  })

  it('rejects unsupported and oversized inputs before parsing', async () => {
    const observed = observedParser()
    const service = new DocumentImportService(observed.parser, { maxInputBytes: (await stat(sourcePath)).size - 1 })
    await expect(service.loadPath(resolve('build/icon.png'))).rejects.toThrow('unsupported document format')
    await expect(service.loadPath(sourcePath)).rejects.toThrow('file too large')
    expect(observed.calls()).toBe(0)
  })

  it('bounds pending admission and cancels admitted imports on disposal', async () => {
    const observed = observedParser()
    const service = new DocumentImportService(observed.parser, { maxConcurrent: 1, maxPending: 1 })
    const first = service.loadPath(sourcePath)
    const second = service.loadPath(sourcePath)
    const excess = service.loadPath(sourcePath)
    const outcomes = Promise.allSettled([first, second, excess])
    service.dispose()
    expect(await outcomes).toEqual([
      expect.objectContaining({ status: 'rejected', reason: expect.objectContaining({ message: 'document import cancelled' }) }),
      expect.objectContaining({ status: 'rejected', reason: expect.objectContaining({ message: 'document import cancelled' }) }),
      expect.objectContaining({ status: 'rejected', reason: expect.objectContaining({ message: 'document import queue is full' }) }),
    ])
    await expect(service.loadPath(sourcePath)).rejects.toThrow('document import service closed')
    expect(observed.calls()).toBe(0)
  })

  it('cancels one owner without cancelling another admitted import', async () => {
    const observed = observedParser()
    const service = new DocumentImportService(observed.parser, { maxConcurrent: 1 })
    const controller = new AbortController()
    const first = service.loadPath(sourcePath)
    const second = service.loadPath(sourcePath, controller.signal)
    const outcomes = Promise.allSettled([first, second])
    controller.abort()
    expect(await outcomes).toEqual([
      expect.objectContaining({ status: 'fulfilled' }),
      expect.objectContaining({ status: 'rejected', reason: expect.objectContaining({ message: 'document import cancelled' }) }),
    ])
    expect(observed.calls()).toBe(1)
  })

  it('can resume after cancelling a shutdown attempt', async () => {
    const observed = observedParser()
    const service = new DocumentImportService(observed.parser)
    const pending = service.loadPath(sourcePath)
    const outcome = expect(pending).rejects.toThrow('document import cancelled')
    service.cancelPending()
    await outcome
    expect((await service.loadPath(sourcePath)).content).toBe(await readFile(sourcePath, 'utf8'))
  })

})
