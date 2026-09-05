import { watch } from 'node:fs'
import { chmod, copyFile, mkdtemp, readFile, rename, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createWorkspace } from '../domain/workspace.js'
import { DocumentImportService } from '../documents/import-service.js'
import { parseDocumentBytes } from '../parser/parser-core.js'
import { DraftRepository, MetadataRepository } from '../persistence/repositories.js'
import { AppStore } from './app-store.js'

// Provenance: unmodified repository README.md and SECURITY.md; only copied into disposable profiles.
const readmePath = resolve('README.md')
const securityPath = resolve('SECURITY.md')
const importer = new DocumentImportService({
  parse: (format, bytes, maxOutputChars) => parseDocumentBytes(format, bytes, { maxOutputChars }),
})

async function profile() {
  const directory = await mkdtemp(join(tmpdir(), 'teleprompt-storage-real-'))
  const source = join(directory, basename(readmePath))
  await copyFile(readmePath, source)
  const metadata = new MetadataRepository({ directory })
  const drafts = new DraftRepository(join(directory, 'drafts'))
  const store = new AppStore({ metadata, drafts })
  await store.initialize(importer)
  return { directory, source, metadata, drafts, store }
}

async function reopen(directory: string) {
  const store = new AppStore({
    metadata: new MetadataRepository({ directory }),
    drafts: new DraftRepository(join(directory, 'drafts')),
  })
  await store.initialize(importer)
  return store
}

describe('real filesystem storage durability', () => {
  it('recovers imported document references from the actual metadata backup', async () => {
    const { directory, source, store, metadata } = await profile()
    const document = await store.addImportedDocument(await importer.loadPath(source))
    store.patchState({ opacity: store.getSnapshot().opacity / 2 })
    await store.flush()
    await rename(metadata.path, `${metadata.path}.preserved`)
    const recovered = await reopen(directory)
    expect(recovered.getDocument(document.id)?.content).toBe(await readFile(readmePath, 'utf8'))
    expect(recovered.getIssues()).toContain('recovered state from backup')
  })

  it('retains unavailable source references through intervening settings saves', async () => {
    const { directory, source, store } = await profile()
    const document = await store.addImportedDocument(await importer.loadPath(source))
    await rename(source, `${source}.unavailable`)
    const unavailable = await reopen(directory)
    unavailable.resetPreferences()
    await unavailable.flush()
    await rename(`${source}.unavailable`, source)
    const recovered = await reopen(directory)
    expect(recovered.getDocument(document.id)?.content).toBe(await readFile(readmePath, 'utf8'))
  })

  it('drains an admitted import command before close-flush resolves', async () => {
    const { directory, source, store } = await profile()
    const imported = await importer.loadPath(source)
    const importing = store.addImportedDocument(imported)
    await store.flush()
    const document = await importing
    expect((await reopen(directory)).getDocument(document.id)?.content).toBe(imported.content)
  })

  it('rejects real Unicode input above the configured UTF8 byte limit without publishing it', async () => {
    const { metadata, drafts, source } = await profile()
    const imported = await importer.loadPath(source)
    expect(Buffer.byteLength(imported.content)).toBeGreaterThan(imported.content.length)
    const store = new AppStore({ metadata, drafts, workspaceFactory: () => createWorkspace({
      maxDocumentChars: imported.content.length, maxDocumentBytes: imported.content.length }) })
    await store.initialize(importer)
    await expect(store.addImportedDocument(imported)).rejects.toThrow('too large')
    expect(store.getSnapshot().documents).toHaveLength(0)
  })

  it('keeps import remove and reload failures on the published workspace after real EACCES', async () => {
    const { directory, source, store } = await profile()
    const document = await store.addImportedDocument(await importer.loadPath(source))
    const secondImport = await importer.loadPath(securityPath)
    const published = store.getDocument(document.id)
    const snapshot = store.getSnapshot()
    const mode = (await stat(directory)).mode & 0o777
    await chmod(directory, 0o500)
    try {
      await expect(store.addImportedDocument(secondImport)).rejects.toThrow()
      expect(store.getSnapshot()).toEqual(snapshot)
      await expect(store.removeDocument(document.id)).rejects.toThrow()
      expect(store.getSnapshot()).toEqual(snapshot)
      expect((await store.reloadDocument(document.id, importer)).ok).toBe(false)
      expect(store.getDocument(document.id)).toEqual(published)
    } finally {
      await chmod(directory, mode)
    }
    await store.flush()
  })

  it('retains settings and user selection applied while real metadata persistence is in flight', async () => {
    const { directory, source, store } = await profile()
    const existing = await store.addImportedDocument(await importer.loadPath(source))
    const imported = await importer.loadPath(securityPath)
    const opacity = store.getSnapshot().opacity / 2
    let observedDuringWrite = false
    let completed = false
    const watcher = watch(directory, (_event, filename) => {
      if (!filename?.endsWith('.tmp') || observedDuringWrite) return
      observedDuringWrite = !completed
      store.patchState({ opacity })
      store.selectDocument(existing.id)
    })
    try {
      await store.addImportedDocument(imported)
      completed = true
    } finally {
      watcher.close()
    }
    expect(observedDuringWrite).toBe(true)
    expect(store.getSnapshot()).toMatchObject({ opacity, activeDocumentId: existing.id })
    await store.flush()
    expect((await reopen(directory)).getSnapshot()).toMatchObject({ opacity, activeDocumentId: existing.id })
  })

  it('reloads changed source bytes under the existing ID and advances its revision', async () => {
    const { directory, source, store } = await profile()
    const document = await store.addImportedDocument(await importer.loadPath(source))
    await copyFile(securityPath, source)
    expect(await store.reloadDocument(document.id, importer)).toMatchObject({ ok: true,
      document: { id: document.id, revision: document.revision + 1 } })
    const content = await readFile(securityPath, 'utf8')
    expect(store.getDocument(document.id)?.content).toBe(content)
    expect((await reopen(directory)).getDocument(document.id)?.content).toBe(content)
  })

  it('retries unresolved references explicitly and durably removes unavailable documents', async () => {
    const { directory, source, store } = await profile()
    const document = await store.addImportedDocument(await importer.loadPath(source))
    await rename(source, `${source}.unavailable`)
    const unavailable = await reopen(directory)
    expect(unavailable.getUnresolvedDocuments().map(reference => reference.id)).toEqual([document.id])
    await rename(`${source}.unavailable`, source)
    expect((await unavailable.reloadDocument(document.id, importer)).ok).toBe(true)
    expect(unavailable.getUnresolvedDocuments()).toEqual([])
    expect(unavailable.getDocument(document.id)?.content).toBe(await readFile(readmePath, 'utf8'))
    await rename(source, `${source}.unavailable`)
    const missingAgain = await reopen(directory)
    expect(await missingAgain.removeDocument(document.id)).toEqual({ ok: true })
    await rename(`${source}.unavailable`, source)
    const afterRemove = await reopen(directory)
    expect(afterRemove.getSnapshot().documents).toEqual([])
    expect(afterRemove.getUnresolvedDocuments()).toEqual([])
  })
})
