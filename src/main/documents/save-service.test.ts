import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { DocumentRecord } from '../../shared/contracts.js'
import { DocumentSaveService } from './save-service.js'

const created: string[] = []

afterEach(async () => {
  await Promise.all(created.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

function sha(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

describe('document save service', () => {
  it.each([
    ['docx', 'docx'],
    ['pdf', 'pdf'],
    ['odt', 'odt'],
    ['rtf', 'rtf'],
    ['html', 'html'],
    ['srt', 'subtitle'],
    ['vtt', 'subtitle'],
  ] as const)('never overwrites an imported .%s source', async (extension, format) => {
    const directory = await mkdtemp(join(tmpdir(), 'teleprompt-save-'))
    created.push(directory)
    const sourcePath = join(directory, `source.${extension}`)
    const original = Buffer.from([0, 1, 2, 3, 4, 255])
    await writeFile(sourcePath, original)
    const info = await stat(sourcePath)
    const document: DocumentRecord = {
      id: `document-${extension}`,
      name: `source.${extension}`,
      sourcePath,
      format,
      saveMode: 'save-as',
      revision: 1,
      dirty: true,
      sourceMtimeMs: info.mtimeMs,
      sourceHash: sha(original),
      content: 'extracted plain text',
    }

    const result = await new DocumentSaveService().save(document)

    expect(result).toEqual({ ok: false, reason: 'save-as-required' })
    expect(sha(await readFile(sourcePath))).toBe(sha(original))
  })

  it('exports transformed content to a new lossless text path', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'teleprompt-save-'))
    created.push(directory)
    const targetPath = join(directory, 'export.md')
    const document: DocumentRecord = {
      id: 'document-pdf',
      name: 'source.pdf',
      sourcePath: join(directory, 'source.pdf'),
      format: 'pdf',
      saveMode: 'save-as',
      revision: 1,
      dirty: true,
      sourceMtimeMs: 1,
      sourceHash: 'a'.repeat(64),
      content: '# Extracted',
    }

    const result = await new DocumentSaveService().save(document, targetPath)

    expect(result).toMatchObject({ ok: true, targetPath, format: 'markdown' })
    expect(await readFile(targetPath, 'utf8')).toBe('# Extracted')
  })

  it('detects external source changes before in-place save', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'teleprompt-save-'))
    created.push(directory)
    const sourcePath = join(directory, 'talk.txt')
    await writeFile(sourcePath, 'external', 'utf8')
    const info = await stat(sourcePath)
    const document: DocumentRecord = {
      id: 'document-text',
      name: 'talk.txt',
      sourcePath,
      format: 'text',
      saveMode: 'overwrite',
      revision: 1,
      dirty: true,
      sourceMtimeMs: info.mtimeMs,
      sourceHash: sha(Buffer.from('original')),
      content: 'local',
    }

    const result = await new DocumentSaveService().save(document)

    expect(result).toMatchObject({ ok: false, reason: 'conflict' })
    expect(await readFile(sourcePath, 'utf8')).toBe('external')
  })
})
