import { chmod, copyFile, mkdtemp, readFile, rename, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createWorkspace } from '../domain/workspace.js'
import { DocumentImportService } from '../documents/import-service.js'
import { parseDocumentBytes } from '../parser/parser-core.js'
import { DraftRepository, MetadataRepository } from '../persistence/repositories.js'
import { AppStore, type DocumentLoader } from './app-store.js'

// Provenance: actual repository README.md and SECURITY.md, unmodified except for
// actual filesystem permission and configured workspace-limit probes.
const readmePath = resolve('README.md')
const securityPath = resolve('SECURITY.md')
const importer = new DocumentImportService({
  parse: (format, bytes, maxOutputChars) => parseDocumentBytes(format, bytes, { maxOutputChars }),
})
async function harness() {
  const directory = await mkdtemp(join(tmpdir(), 'teleprompt-app-store-real-'))
  return {
    directory,
    metadata: new MetadataRepository({ directory, fileName: 'state.json' }),
    drafts: new DraftRepository(join(directory, 'drafts')),
  }
}

describe('application store', () => {
  it('makes every acknowledged import recoverable without a shutdown flush', async () => {
    const repositories = await harness()
    const first = new AppStore({ ...repositories, persistDelayMs: 60_000 })
    await first.initialize(importer)
    const document = await first.addImportedDocument(await importer.loadPath(readmePath))
    const afterCrash = new AppStore(repositories)
    await afterCrash.initialize(importer)
    expect(afterCrash.getActiveDocument()).toMatchObject({ id: document.id, revision: document.revision,
      content: await readFile(readmePath, 'utf8'), dirty: false })
  })

  it('recovers imported content and settings but always restarts paused', async () => {
    const repositories = await harness()
    const first = new AppStore(repositories)
    await first.initialize(importer)
    const document = await first.addImportedDocument(await importer.loadPath(securityPath))
    first.patchState({ playing: true, clickerMode: true, drivePresentation: true })
    await first.flush()
    const second = new AppStore(repositories)
    await second.initialize(importer)
    expect(second.getActiveDocument()).toMatchObject({ id: document.id, content: await readFile(securityPath, 'utf8') })
    expect(second.getSnapshot()).toMatchObject({ playing: false, clickerMode: false, drivePresentation: false })
  })

  it('rehydrates clean sources through the shared loader and does not transfer a missing checkpoint', async () => {
    const repositories = await harness()
    const availablePath = join(repositories.directory, basename(readmePath))
    const missingPath = join(repositories.directory, basename(securityPath))
    await copyFile(readmePath, availablePath)
    await copyFile(securityPath, missingPath)
    const first = new AppStore(repositories)
    await first.initialize(importer)
    const available = await first.addImportedDocument(await importer.loadPath(availablePath))
    await first.addImportedDocument(await importer.loadPath(missingPath))
    first.patchState({ scrollPosition: 0.75 })
    await first.flush()
    await rename(missingPath, `${missingPath}.unavailable`)
    const paths: string[] = []
    const loader: DocumentLoader = {
      async loadPath(path, signal) {
        paths.push(path)
        return importer.loadPath(path, signal)
      },
    }
    const store = new AppStore(repositories)
    const issues = await store.initialize(loader)
    expect(paths).toEqual([missingPath, availablePath])
    expect(store.getActiveDocument()).toMatchObject({ id: available.id, content: await readFile(readmePath, 'utf8') })
    expect(store.getSnapshot().scrollPosition).toBe(0)
    expect(issues.some((issue) => issue.includes(basename(missingPath)))).toBe(true)
  })

  it('removes imported documents by stable ID without changing the source file', async () => {
    const store = new AppStore(await harness())
    await store.initialize(importer)
    const imported = await importer.loadPath(readmePath)
    const document = await store.addImportedDocument(imported)
    expect(await store.removeDocument(document.id)).toEqual({ ok: true })
    expect(await store.removeDocument(document.id)).toEqual({ ok: false, reason: 'not-found' })
    expect(await readFile(readmePath, 'utf8')).toBe(imported.content)
  })

  it('preserves acknowledged workspace state when a real import exceeds its limit', async () => {
    const repositories = await harness()
    const firstImport = await importer.loadPath(readmePath)
    const secondImport = await importer.loadPath(securityPath)
    const limit = firstImport.content.length + secondImport.content.length - 1
    const store = new AppStore({ ...repositories,
      workspaceFactory: () => createWorkspace({ maxTotalChars: limit }) })
    await store.initialize(importer)
    const first = await store.addImportedDocument(firstImport)
    await expect(store.addImportedDocument(secondImport)).rejects.toThrow('workspace content limit')
    expect(store.getSnapshot().documents.map(document => document.id)).toEqual([first.id])
    const recovered = new AppStore(repositories)
    await recovered.initialize(importer)
    expect(recovered.getDocument(first.id)?.content).toBe(firstImport.content)
  })

  it('retries metadata persistence after a transient write failure', async () => {
    const repositories = await harness()
    const store = new AppStore(repositories)
    await store.initialize(importer)
    const mode = (await stat(repositories.directory)).mode & 0o777
    await chmod(repositories.directory, 0o500)
    try {
      store.patchState({ opacity: store.getSnapshot().opacity / 2 })
      await expect(store.flush()).rejects.toThrow()
    } finally {
      await chmod(repositories.directory, mode)
    }
    const opacity = store.getSnapshot().opacity / 2
    store.patchState({ opacity })
    await expect(store.flush()).resolves.toBeUndefined()
    expect(JSON.parse(await readFile(repositories.metadata.path, 'utf8')).state.opacity).toBe(opacity)
  })
})
