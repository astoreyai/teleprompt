import { watch } from 'node:fs'
import { chmod, copyFile, mkdir, mkdtemp, readFile, readdir, rename, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createWorkspace } from '../domain/workspace.js'
import { DocumentImportService } from '../documents/import-service.js'
import { DocumentSaveService } from '../documents/save-service.js'
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
  it('recovers a backup that still requires the draft after source save', async () => {
    const { directory, source, store, metadata } = await profile()
    const document = await store.addImportedDocument(await importer.loadPath(source))
    const content = await readFile(securityPath, 'utf8')
    expect((await store.updateDocument({ id: document.id, expectedRevision: document.revision, content })).ok).toBe(true)
    expect((await store.saveDocument(document.id, new DocumentSaveService())).ok).toBe(true)
    await rename(metadata.path, `${metadata.path}.preserved`)
    const recovered = await reopen(directory)
    expect(recovered.getDocument(document.id)?.content).toBe(content)
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

  it('preserves published revision and previous draft after real metadata EACCES', async () => {
    const { directory, store, drafts } = await profile()
    const previous = await readFile(readmePath, 'utf8')
    const document = await store.createDocument(basename(readmePath), previous, 'markdown')
    const content = await readFile(securityPath, 'utf8')
    const mode = (await stat(directory)).mode & 0o777
    await chmod(directory, 0o500)
    let outcome: unknown
    try {
      outcome = await store.updateDocument({ id: document.id, expectedRevision: document.revision, content }).catch((error: unknown) => error)
    } finally {
      await chmod(directory, mode)
    }
    expect(outcome).not.toMatchObject({ ok: true })
    expect(store.getDocument(document.id)?.revision).toBe(document.revision)
    expect(await drafts.read(document.id)).toBe(previous)
    expect((await store.updateDocument({ id: document.id, expectedRevision: document.revision, content })).ok).toBe(true)
  })

  it('recovers an acknowledged edit without requiring a shutdown flush', async () => {
    const { directory, store } = await profile()
    const document = await store.createDocument(basename(readmePath), await readFile(readmePath, 'utf8'), 'markdown')
    const content = await readFile(securityPath, 'utf8')
    const result = await store.updateDocument({ id: document.id, expectedRevision: document.revision, content })
    expect(result.ok).toBe(true)
    expect((await reopen(directory)).getDocument(document.id)).toMatchObject({ content, revision: document.revision + 1 })
  })

  it('drains an admitted create command before flush resolves', async () => {
    const { directory, store } = await profile()
    const content = await readFile(readmePath, 'utf8')
    const creating = store.createDocument(basename(readmePath), content, 'markdown')
    await store.flush()
    const recovered = await reopen(directory)
    const document = await creating
    expect(recovered.getDocument(document.id)?.content).toBe(content)
  })

  it('rejects real Unicode content above a configured UTF8 byte limit before draft mutation', async () => {
    const { metadata, drafts } = await profile()
    const content = await readFile(readmePath, 'utf8')
    expect(Buffer.byteLength(content)).toBeGreaterThan(content.length)
    const store = new AppStore({ metadata, drafts, workspaceFactory: () => createWorkspace({ maxDocumentChars: content.length, maxDocumentBytes: content.length }) })
    await store.initialize(importer)
    await expect(store.createDocument(basename(readmePath), content, 'markdown')).rejects.toThrow('too large')
    expect(store.getSnapshot().documents).toHaveLength(0)
  })

  it('reports a completed source write with failed metadata and permits a checked retry', async () => {
    const { directory, store, drafts } = await profile()
    const content = await readFile(securityPath, 'utf8')
    const document = await store.createDocument(basename(securityPath), content, 'markdown')
    const exportDirectory = join(directory, 'exports')
    await mkdir(exportDirectory)
    const targetPath = join(exportDirectory, basename(securityPath))
    const mode = (await stat(directory)).mode & 0o777
    await chmod(directory, 0o500)
    try {
      const result = await store.saveDocument(document.id, new DocumentSaveService(), targetPath)
      expect(result).toMatchObject({ ok: false, reason: 'storage-failed', sourceSaved: true, currentRevision: document.revision, targetPath })
      expect(await readFile(targetPath, 'utf8')).toBe(content)
      expect(await drafts.read(document.id)).toBe(content)
      expect(store.getDocument(document.id)).toMatchObject({ revision: document.revision, sourcePath: targetPath, dirty: true })
    } finally {
      await chmod(directory, mode)
    }
    expect((await store.saveDocument(document.id, new DocumentSaveService())).ok).toBe(true)
    expect((await reopen(directory)).getDocument(document.id)?.content).toBe(content)
  })

  it('keeps create import remove and reload failures on the published workspace', async () => {
    const { directory, source, store } = await profile()
    const document = await store.addImportedDocument(await importer.loadPath(source))
    const secondImport = await importer.loadPath(securityPath)
    const published = store.getDocument(document.id)
    const snapshot = store.getSnapshot()
    const content = await readFile(securityPath, 'utf8')
    const mode = (await stat(directory)).mode & 0o777
    await chmod(directory, 0o500)
    try {
      await expect(store.createDocument(basename(securityPath), content, 'markdown')).rejects.toThrow()
      expect(store.getSnapshot()).toEqual(snapshot)
      expect((await readdir(join(directory, 'drafts'))).filter((name) => name.endsWith('.txt'))).toEqual([])
      await expect(store.addImportedDocument(secondImport)).rejects.toThrow()
      expect(store.getSnapshot()).toEqual(snapshot)
      await expect(store.removeDocument(document.id, true)).rejects.toThrow()
      expect(store.getSnapshot()).toEqual(snapshot)
      expect((await store.reloadDocument(document.id, true, importer)).ok).toBe(false)
      expect(store.getDocument(document.id)).toEqual(published)
    } finally {
      await chmod(directory, mode)
    }
    await store.flush()
  })

  it('retains settings and selection applied while a real draft write is in flight', async () => {
    const { directory, store } = await profile()
    const first = await store.createDocument(basename(readmePath), await readFile(readmePath, 'utf8'), 'markdown')
    const second = await store.createDocument(basename(securityPath), await readFile(securityPath, 'utf8'), 'markdown')
    store.selectDocument(first.id)
    const opacity = store.getSnapshot().opacity / 2
    let observedDuringWrite = false
    let completed = false
    const watcher = watch(join(directory, 'drafts'), (_event, filename) => {
      if (filename !== `${first.id}.txt` || observedDuringWrite) return
      observedDuringWrite = !completed
      store.patchState({ opacity })
      store.selectDocument(second.id)
    })
    try {
      expect((await store.updateDocument({ id: first.id, expectedRevision: first.revision, content: await readFile(securityPath, 'utf8') })).ok).toBe(true)
      completed = true
    } finally {
      watcher.close()
    }
    expect(observedDuringWrite).toBe(true)
    expect(store.getSnapshot()).toMatchObject({ opacity, activeDocumentId: second.id })
    await store.flush()
    expect((await reopen(directory)).getSnapshot()).toMatchObject({ opacity, activeDocumentId: second.id })
  })

  it('retries unresolved references explicitly and removes only after explicit discard', async () => {
    const { directory, source, store } = await profile()
    const document = await store.addImportedDocument(await importer.loadPath(source))
    await rename(source, `${source}.unavailable`)
    const unavailable = await reopen(directory)
    expect(unavailable.getUnresolvedDocuments().map((reference) => reference.id)).toEqual([document.id])
    await rename(`${source}.unavailable`, source)
    expect((await unavailable.reloadDocument(document.id, false, importer)).ok).toBe(true)
    expect(unavailable.getUnresolvedDocuments()).toEqual([])
    expect(unavailable.getDocument(document.id)?.content).toBe(await readFile(readmePath, 'utf8'))
    await rename(source, `${source}.unavailable`)
    const missingAgain = await reopen(directory)
    expect(await missingAgain.removeDocument(document.id, true)).toEqual({ ok: true })
    await rename(`${source}.unavailable`, source)
    const afterRemove = await reopen(directory)
    expect(afterRemove.getSnapshot().documents).toEqual([])
    expect(afterRemove.getUnresolvedDocuments()).toEqual([])
  })

  it('retains backup-required drafts then cleans them once both metadata copies release them', async () => {
    const { source, store, drafts } = await profile()
    const document = await store.addImportedDocument(await importer.loadPath(source))
    const content = await readFile(securityPath, 'utf8')
    expect((await store.updateDocument({ id: document.id, expectedRevision: document.revision, content })).ok).toBe(true)
    expect((await store.saveDocument(document.id, new DocumentSaveService())).ok).toBe(true)
    expect(await drafts.read(document.id)).toBe(content)
    await store.flush()
    expect(await drafts.read(document.id)).toBeNull()
  })


  it('preserves a later user selection during an admitted create draft write', async () => {
    const { directory, store } = await profile()
    const existing = await store.createDocument(basename(readmePath), await readFile(readmePath, 'utf8'), 'markdown')
    let selectedDuringWrite = false
    const watcher = watch(join(directory, 'drafts'), (_event, filename) => {
      if (!filename?.endsWith('.txt') || filename === `${existing.id}.txt` || selectedDuringWrite) return
      selectedDuringWrite = store.selectDocument(existing.id)
    })
    try {
      await store.createDocument(basename(securityPath), await readFile(securityPath, 'utf8'), 'markdown')
    } finally {
      watcher.close()
    }
    expect(selectedDuringWrite).toBe(true)
    expect(store.getSnapshot().activeDocumentId).toBe(existing.id)
    await store.flush()
  })

})
