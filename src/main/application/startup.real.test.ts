import { chmod, copyFile, mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { AppStore } from './app-store.js'
import { DocumentImportService } from '../documents/import-service.js'
import { parseDocumentBytes } from '../parser/parser-core.js'
import { DraftRepository, MetadataRepository } from '../persistence/repositories.js'

it('restores the selected real file before earlier playlist entries', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'teleprompt-startup-real-'))
  const importer = new DocumentImportService({ parse: (format, bytes, maxOutputChars) => parseDocumentBytes(format, bytes, { maxOutputChars }) })
  const metadata = new MetadataRepository({ directory })
  const drafts = new DraftRepository(join(directory, 'drafts'))
  try {
    const first = join(directory, 'README.md')
    const active = join(directory, 'SECURITY.md')
    await copyFile('README.md', first)
    await copyFile('SECURITY.md', active)
    const original = new AppStore({ metadata, drafts })
    await original.initialize(importer)
    await original.addImportedDocument(await importer.loadPath(first))
    const selected = await original.addImportedDocument(await importer.loadPath(active))
    await original.flush()
    const reopened = new AppStore({ metadata, drafts })
    const loaded: string[] = []
    await reopened.initialize({ loadPath: async path => {
      loaded.push(path)
      return importer.loadPath(path)
    } })
    expect(loaded[0]).toBe(active)
    expect(reopened.getSnapshot().activeDocumentId).toBe(selected.id)
    expect(reopened.getSnapshot().documents.map(document => document.sourcePath)).toEqual([first, active])
  } finally {
    importer.dispose()
    await rm(directory, { recursive: true, force: true })
  }
})

it('does not resurrect a removed reference when its real background import finishes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'teleprompt-startup-remove-'))
  const importer = new DocumentImportService({ parse: (format, bytes, maxOutputChars) => parseDocumentBytes(format, bytes, { maxOutputChars }) })
  const metadata = new MetadataRepository({ directory })
  const drafts = new DraftRepository(join(directory, 'drafts'))
  try {
    const original = new AppStore({ metadata, drafts })
    await original.initialize(importer)
    const removed = await original.addImportedDocument(await importer.loadPath('README.md'))
    const active = await original.addImportedDocument(await importer.loadPath('SECURITY.md'))
    await original.flush()
    const reopened = new AppStore({ metadata, drafts, restoreInBackground: true })
    await reopened.initialize(importer)
    expect(reopened.getStorageStatus().restoring).toBe(true)
    expect(reopened.getUnresolvedDocuments().map(reference => reference.id)).toContain(removed.id)
    expect(await reopened.removeDocument(removed.id)).toEqual({ ok: true })
    await reopened.waitForRestoration()
    await reopened.flush()
    expect(reopened.getSnapshot().documents.map(document => document.id)).toEqual([active.id])
    expect(reopened.getUnresolvedDocuments()).toEqual([])
    const afterRestart = new AppStore({ metadata, drafts })
    await afterRestart.initialize(importer)
    expect(afterRestart.getSnapshot().documents.map(document => document.id)).toEqual([active.id])
  } finally {
    importer.dispose()
    await rm(directory, { recursive: true, force: true })
  }
})

it('preserves preferences and selection during real background restoration and reports the saved file time', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'teleprompt-startup-settings-'))
  const importer = new DocumentImportService({ parse: (format, bytes, maxOutputChars) => parseDocumentBytes(format, bytes, { maxOutputChars }) })
  const metadata = new MetadataRepository({ directory })
  const drafts = new DraftRepository(join(directory, 'drafts'))
  try {
    const original = new AppStore({ metadata, drafts })
    await original.initialize(importer)
    const first = await original.addImportedDocument(await importer.loadPath('README.md'))
    const active = await original.addImportedDocument(await importer.loadPath('SECURITY.md'))
    await original.flush()
    const reopened = new AppStore({ metadata, drafts, restoreInBackground: true })
    await reopened.initialize(importer)
    expect(reopened.getStorageStatus().restoring).toBe(true)
    const opacity = reopened.getSnapshot().opacity / 2
    reopened.patchState({ opacity })
    expect(reopened.selectDocument(active.id)).toBe(true)
    // flush must include background restoration and all previously admitted state.
    await reopened.flush()
    expect(reopened.getStorageStatus().restoring).toBe(false)
    expect(reopened.getStorageStatus().lastPersistedAt).toBe((await stat(metadata.path)).mtimeMs)
    expect(reopened.getSnapshot()).toMatchObject({ activeDocumentId: active.id, opacity })
    expect(reopened.getSnapshot().documents.map(document => document.id)).toEqual([first.id, active.id])
    const afterRestart = new AppStore({ metadata: new MetadataRepository({ directory }), drafts })
    await afterRestart.initialize(importer)
    expect(afterRestart.getSnapshot()).toMatchObject({ activeDocumentId: active.id, opacity })
  } finally {
    importer.dispose()
    await rm(directory, { recursive: true, force: true })
  }
})

it('retains a background reference after a real metadata permission failure and permits retry', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'teleprompt-startup-eacces-'))
  const importer = new DocumentImportService({ parse: (format, bytes, maxOutputChars) => parseDocumentBytes(format, bytes, { maxOutputChars }) })
  const metadata = new MetadataRepository({ directory })
  const drafts = new DraftRepository(join(directory, 'drafts'))
  const mode = (await stat(directory)).mode & 0o777
  try {
    const original = new AppStore({ metadata, drafts })
    await original.initialize(importer)
    const pending = await original.addImportedDocument(await importer.loadPath('README.md'))
    const active = await original.addImportedDocument(await importer.loadPath('SECURITY.md'))
    await original.flush()
    await chmod(directory, 0o500)
    const reopened = new AppStore({ metadata, drafts, restoreInBackground: true })
    await reopened.initialize(importer)
    await reopened.waitForRestoration()
    expect(reopened.getStorageStatus().restoring).toBe(false)
    expect(reopened.getSnapshot().documents.map(document => document.id)).toEqual([active.id])
    expect(reopened.getUnresolvedDocuments().map(reference => reference.id)).toEqual([pending.id])
    expect(reopened.getIssues().some(issue => issue.includes('EACCES'))).toBe(true)
    await chmod(directory, mode)
    expect((await reopened.reloadDocument(pending.id, importer)).ok).toBe(true)
    await reopened.flush()
    expect(reopened.getUnresolvedDocuments()).toEqual([])
    expect(reopened.getSnapshot().documents.map(document => document.id)).toEqual([pending.id, active.id])
  } finally {
    await chmod(directory, mode)
    importer.dispose()
    await rm(directory, { recursive: true, force: true })
  }
})

async function restorationProfile() {
  const directory = await mkdtemp(join(tmpdir(), 'teleprompt-startup-cancel-'))
  const importer = new DocumentImportService({ parse: (format, bytes, maxOutputChars) => parseDocumentBytes(format, bytes, { maxOutputChars }) })
  const metadata = new MetadataRepository({ directory })
  const drafts = new DraftRepository(join(directory, 'drafts'))
  const license = join(directory, 'LICENSE.txt')
  await copyFile('LICENSE', license)
  const original = new AppStore({ metadata, drafts })
  await original.initialize(importer)
  const documents = []
  for (const path of ['README.md', 'SECURITY.md', license]) {
    documents.push(await original.addImportedDocument(await importer.loadPath(path)))
  }
  original.selectDocument(documents[1].id)
  original.patchState({ scrollPosition: 0.5 })
  await original.flush()
  return { directory, importer, metadata, drafts, documents }
}

it('stops further restoration admissions after cancelling a real background import', async () => {
  const { directory, importer, metadata, drafts, documents } = await restorationProfile()
  try {
    const loaded: string[] = []
    const reopened = new AppStore({ metadata, drafts, restoreInBackground: true })
    await reopened.initialize({ loadPath: (path, signal) => {
      loaded.push(path)
      return importer.loadPath(path, signal)
    } })
    const admittedBeforeCancellation = loaded.length
    reopened.cancelRestoration()
    importer.cancelPending()
    await reopened.flush()
    expect(loaded).toHaveLength(admittedBeforeCancellation)
    expect(reopened.getSnapshot().documents.map(document => document.id)).toEqual([documents[1].id])
    expect(reopened.getUnresolvedDocuments().map(document => document.id)).toEqual([documents[0].id, documents[2].id])
    const afterRestart = new AppStore({ metadata, drafts })
    await afterRestart.initialize(importer)
    expect(afterRestart.getSnapshot().documents.map(document => document.id)).toEqual(documents.map(document => document.id))
  } finally {
    importer.dispose()
    await rm(directory, { recursive: true, force: true })
  }
})

it('preserves the original selection and references when closing before initial restoration starts', async () => {
  const { directory, importer, metadata, drafts, documents } = await restorationProfile()
  try {
    const loaded: string[] = []
    const reopened = new AppStore({ metadata, drafts, restoreInBackground: true })
    const initializing = reopened.initialize({ loadPath: (path, signal) => {
      loaded.push(path)
      return importer.loadPath(path, signal)
    } })
    reopened.cancelRestoration()
    importer.cancelPending()
    await initializing
    await reopened.flush()
    expect(loaded).toEqual([])
    const afterRestart = new AppStore({ metadata, drafts })
    await afterRestart.initialize(importer)
    expect(afterRestart.getSnapshot().activeDocumentId).toBe(documents[1].id)
    expect(afterRestart.getSnapshot().scrollPosition).toBe(0.5)
    expect(afterRestart.getSnapshot().documents.map(document => document.id)).toEqual(documents.map(document => document.id))
  } finally {
    importer.dispose()
    await rm(directory, { recursive: true, force: true })
  }
})

it('selects the next visible playlist entry after removing an actively restored document', async () => {
  const { directory, importer, metadata, drafts, documents } = await restorationProfile()
  try {
    const reopened = new AppStore({ metadata, drafts })
    await reopened.initialize(importer)
    expect(reopened.getSnapshot().documents.map(document => document.id)).toEqual(documents.map(document => document.id))
    expect(await reopened.removeDocument(documents[1].id)).toEqual({ ok: true })
    expect(reopened.getSnapshot().activeDocumentId).toBe(documents[2].id)
  } finally {
    importer.dispose()
    await rm(directory, { recursive: true, force: true })
  }
})

it('preserves pending references when closing during the first actual import', async () => {
  const { directory, importer, metadata, drafts, documents } = await restorationProfile()
  try {
    const loaded: string[] = []
    const reopened = new AppStore({ metadata, drafts, restoreInBackground: true })
    await reopened.initialize({ loadPath: (path, signal) => {
      loaded.push(path)
      const reading = importer.loadPath(path, signal)
      reopened.cancelRestoration()
      importer.cancelPending()
      return reading
    } })
    await reopened.flush()
    expect(loaded).toHaveLength(1)
    expect(reopened.getSnapshot().documents).toEqual([])
    expect(reopened.getUnresolvedDocuments().map(document => document.id)).toEqual(documents.map(document => document.id))
    const afterRestart = new AppStore({ metadata, drafts })
    await afterRestart.initialize(importer)
    expect(afterRestart.getSnapshot()).toMatchObject({ activeDocumentId: documents[1].id, scrollPosition: 0.5 })
  } finally {
    importer.dispose()
    await rm(directory, { recursive: true, force: true })
  }
})
