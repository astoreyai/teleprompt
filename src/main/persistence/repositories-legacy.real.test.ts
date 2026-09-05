import { copyFile, mkdir, mkdtemp, readFile, rm, stat, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { AppStore } from '../application/app-store.js'
import { DocumentImportService } from '../documents/import-service.js'
import { parseDocumentBytes } from '../parser/parser-core.js'
import { DraftRepository, MetadataRepository } from './repositories.js'
import { parsePersistedState } from './schema.js'

// Captured pre-removal application output, never authored legacy JSON/draft data.
// The bundled capture contains only temporary public-document paths. An explicit
// operator override may point to a private profile without publishing its bytes.
async function legacyProfile() {
  const source = process.env.TELEPROMPT_REAL_LEGACY_PROFILE ?? resolve('test/fixtures/public/legacy-1.0.3')
  const metadata = await readFile(join(source, 'teleprompt-state.v2.json'))
  const parsed = parsePersistedState(JSON.parse(metadata.toString('utf8')))
  if (parsed.quarantined) throw new Error('Captured legacy profile was rejected')
  const reference = parsed.value.documentRefs.find(document => document.dirty)
  if (!reference) throw new Error('Captured legacy profile contains no recovery draft')
  const draft = join(source, 'drafts', `${reference.id}.txt`)
  const content = await readFile(draft, 'utf8')
  return { source, metadata, reference, draft, content }
}

describe('read-only compatibility with authentic pre-removal drafts', () => {
  it('reads a captured legacy draft without modifying its bytes or permissions', async () => {
    const { source, reference, draft, content } = await legacyProfile()
    const before = await stat(draft)
    const repository = new DraftRepository(join(source, 'drafts'), Buffer.byteLength(content))
    expect(await repository.read(reference.id)).toBe(content)
    expect((await stat(draft)).mtimeMs).toBe(before.mtimeMs)
    expect((await stat(draft)).mode).toBe(before.mode)
  })

  it('rejects traversal, over-budget captured content, and an actual symbolic link', async () => {
    const { reference, draft, content } = await legacyProfile()
    const directory = await mkdtemp(join(tmpdir(), 'teleprompt-legacy-reader-'))
    try {
      const repository = new DraftRepository(directory, Buffer.byteLength(content) - 1)
      await expect(repository.read(`../${reference.id}`)).rejects.toThrow('invalid document id')
      await copyFile(draft, join(directory, `${reference.id}.txt`))
      await expect(repository.read(reference.id)).rejects.toThrow('too large')
      await rm(join(directory, `${reference.id}.txt`))
      await symlink(resolve(draft), join(directory, `${reference.id}.txt`))
      await expect(repository.read(reference.id)).rejects.toThrow('symbolic link')
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('recovers the captured draft for reading and retains it after document removal', async () => {
    const { source, reference, content } = await legacyProfile()
    const directory = await mkdtemp(join(tmpdir(), 'teleprompt-legacy-workspace-'))
    try {
      const state = parsePersistedState(JSON.parse(await readFile(join(source, 'teleprompt-state.v2.json'), 'utf8')))
      await copyFile(join(source, 'teleprompt-state.v2.json'), join(directory, 'teleprompt-state.v2.json'))
      await mkdir(join(directory, 'drafts'))
      for (const document of state.value.documentRefs.filter(document => document.dirty)) {
        await copyFile(join(source, 'drafts', `${document.id}.txt`), join(directory, 'drafts', `${document.id}.txt`))
      }
      const drafts = new DraftRepository(join(directory, 'drafts'))
      const store = new AppStore({ metadata: new MetadataRepository({ directory }), drafts })
      const importer = new DocumentImportService({
        parse: (format, bytes, maxOutputChars) => parseDocumentBytes(format, bytes, { maxOutputChars }),
      })
      await store.initialize(importer)
      expect(store.getDocument(reference.id)?.content).toBe(content)
      expect(await store.removeDocument(reference.id)).toEqual({ ok: true })
      expect(await drafts.read(reference.id)).toBe(content)
      await store.flush()
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
