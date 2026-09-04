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
// explicit code-point subsampling in the small workspace-limit test.
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
  it('makes every acknowledged draft revision recoverable without a shutdown flush', async () => {
    const repositories = await harness()
    const first = new AppStore({ ...repositories, persistDelayMs: 60_000 })
    await first.initialize(importer)
    const document = await first.createDocument(basename(readmePath), await readFile(readmePath, 'utf8'), 'markdown')
    const content = await readFile(securityPath, 'utf8')
    expect(await first.updateDocument({ id: document.id, expectedRevision: document.revision, content }))
      .toEqual({ ok: true, revision: document.revision + 1 })
    const afterCrash = new AppStore({ ...repositories, persistDelayMs: 60_000 })
    await afterCrash.initialize(importer)
    expect(afterCrash.getActiveDocument()).toMatchObject({ id: document.id, revision: document.revision + 1, content, dirty: true })
  })

  it('durably recovers acknowledged memory-document edits but always restarts paused', async () => {
    const repositories = await harness()
    const first = new AppStore({ ...repositories, persistDelayMs: 1 })
    await first.initialize(importer)
    const document = await first.createDocument(basename(readmePath), await readFile(readmePath, 'utf8'), 'markdown')
    const content = await readFile(securityPath, 'utf8')
    expect(await first.updateDocument({ id: document.id, expectedRevision: document.revision, content }))
      .toEqual({ ok: true, revision: document.revision + 1 })
    first.patchState({ playing: true, voicePacing: true, clickerMode: true, drivePresentation: true })
    await first.flush()
    const second = new AppStore({ ...repositories, persistDelayMs: 1 })
    await second.initialize(importer)
    expect(second.getActiveDocument()).toMatchObject({ content, revision: document.revision + 1 })
    expect(second.getSnapshot()).toMatchObject({ playing: false, voicePacing: false, clickerMode: false, drivePresentation: false })
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
    expect(paths).toEqual([availablePath, missingPath])
    expect(store.getActiveDocument()).toMatchObject({ id: available.id, content: await readFile(readmePath, 'utf8') })
    expect(store.getSnapshot().scrollPosition).toBe(0)
    expect(issues.some((issue) => issue.includes(basename(missingPath)))).toBe(true)
  })

  it('requires explicit discard before removing a dirty document', async () => {
    const store = new AppStore(await harness())
    await store.initialize(importer)
    const document = await store.createDocument(basename(readmePath), await readFile(readmePath, 'utf8'), 'markdown')
    expect(await store.removeDocument(document.id, false)).toEqual({ ok: false, reason: 'dirty' })
    expect(await store.removeDocument(document.id, true)).toEqual({ ok: true })
  })

  it('does not replace a valid recovery draft when a workspace-limit update is rejected', async () => {
    const repositories = await harness()
    const firstContent = (await readFile(readmePath, 'utf8')).slice(0, 6)
    const secondContent = (await readFile(securityPath, 'utf8')).slice(0, 4)
    const oversized = (await readFile(readmePath, 'utf8')).slice(0, firstContent.length + 1)
    const limit = firstContent.length + secondContent.length
    const store = new AppStore({ ...repositories, workspaceFactory: () => createWorkspace({ maxDocumentChars: limit, maxTotalChars: limit }) })
    await store.initialize(importer)
    const first = await store.createDocument(basename(readmePath), firstContent, 'markdown')
    await store.createDocument(basename(securityPath), secondContent, 'markdown')
    expect(await store.updateDocument({ id: first.id, expectedRevision: first.revision, content: oversized }))
      .toEqual({ ok: false, reason: 'too-large' })
    expect(await repositories.drafts.read(first.id)).toBe(firstContent)
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
