import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DocumentImportService, type DocumentParser } from './import-service.js'

const created: string[] = []

afterEach(async () => {
  await Promise.all(created.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe('unified document import service', () => {
  it('classifies, bounds, fingerprints, and parses a source through one pipeline', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'teleprompt-import-'))
    created.push(directory)
    const path = join(directory, 'talk.md')
    await writeFile(path, '# Hello', 'utf8')
    const parser: DocumentParser = {
      parse: vi.fn(async (_format, bytes) => Buffer.from(bytes).toString('utf8')),
    }
    const service = new DocumentImportService(parser)

    const loaded = await service.loadPath(path)

    expect(loaded).toMatchObject({
      name: 'talk.md',
      sourcePath: path,
      format: 'markdown',
      content: '# Hello',
      dirty: false,
    })
    expect(loaded.sourceHash).toMatch(/^[0-9a-f]{64}$/)
    expect(parser.parse).toHaveBeenCalledOnce()
  })

  it('rejects unsupported and oversized inputs before parsing', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'teleprompt-import-'))
    created.push(directory)
    const unsupported = join(directory, 'payload.bin')
    const oversized = join(directory, 'large.txt')
    await writeFile(unsupported, 'x', 'utf8')
    await writeFile(oversized, '12345', 'utf8')
    const parser: DocumentParser = { parse: vi.fn(async () => '') }
    const service = new DocumentImportService(parser, { maxInputBytes: 4 })

    await expect(service.loadPath(unsupported)).rejects.toThrow('unsupported document format')
    await expect(service.loadPath(oversized)).rejects.toThrow('file too large')
    expect(parser.parse).not.toHaveBeenCalled()
  })
})
