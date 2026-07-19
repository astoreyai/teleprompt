import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createDefaultSnapshot } from '../../shared/defaults.js'
import { createWorkspace } from '../domain/workspace.js'
import { DraftRepository, MetadataRepository } from '../persistence/repositories.js'
import { persistedFromSnapshot } from '../persistence/schema.js'
import { AppStore, type DocumentLoader } from './app-store.js'

const created: string[] = []

afterEach(async () => {
  await Promise.all(created.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

async function harness() {
  const directory = await mkdtemp(join(tmpdir(), 'teleprompt-app-store-'))
  created.push(directory)
  return {
    metadata: new MetadataRepository({ directory, fileName: 'state.json' }),
    drafts: new DraftRepository(join(directory, 'drafts')),
  }
}

const unusedLoader: DocumentLoader = {
  loadPath: vi.fn(async () => {
    throw new Error('loader should not be called')
  }),
}

describe('application store', () => {
  it('makes every acknowledged draft revision recoverable without a shutdown flush', async () => {
    const repositories = await harness()
    const first = new AppStore({ ...repositories, persistDelayMs: 60_000 })
    await first.initialize(unusedLoader)
    const document = await first.createDocument('talk.md', '# Original', 'markdown')
    expect(
      await first.updateDocument({
        id: document.id,
        expectedRevision: document.revision,
        content: '# Acknowledged',
      }),
    ).toEqual({ ok: true, revision: 1 })

    const afterCrash = new AppStore({ ...repositories, persistDelayMs: 60_000 })
    await afterCrash.initialize(unusedLoader)
    expect(afterCrash.getActiveDocument()).toMatchObject({
      id: document.id,
      revision: 1,
      content: '# Acknowledged',
      dirty: true,
    })
  })

  it('durably recovers acknowledged memory-document edits but always restarts paused', async () => {
    const repositories = await harness()
    const first = new AppStore({ ...repositories, persistDelayMs: 1 })
    await first.initialize(unusedLoader)
    const document = await first.createDocument('talk.md', '# Original', 'markdown')
    expect(
      await first.updateDocument({
        id: document.id,
        expectedRevision: document.revision,
        content: '# Recovered',
      }),
    ).toEqual({ ok: true, revision: 1 })
    first.patchState({ playing: true, voicePacing: true, clickerMode: true, drivePresentation: true })
    await first.flush()

    const second = new AppStore({ ...repositories, persistDelayMs: 1 })
    await second.initialize(unusedLoader)
    expect(second.getActiveDocument()).toMatchObject({ content: '# Recovered', revision: 1 })
    expect(second.getSnapshot()).toMatchObject({
      playing: false,
      voicePacing: false,
      clickerMode: false,
      drivePresentation: false,
    })
  })

  it('rehydrates clean sources through the shared loader and does not transfer a missing checkpoint', async () => {
    const repositories = await harness()
    const snapshot = createDefaultSnapshot()
    snapshot.scrollPosition = 0.75
    snapshot.documents = [
      {
        id: 'available',
        name: 'available.txt',
        sourcePath: '/tmp/available.txt',
        format: 'text',
        saveMode: 'overwrite',
        revision: 0,
        dirty: false,
        sourceMtimeMs: 1,
        sourceHash: 'a'.repeat(64),
      },
      {
        id: 'missing',
        name: 'missing.txt',
        sourcePath: '/tmp/missing.txt',
        format: 'text',
        saveMode: 'overwrite',
        revision: 0,
        dirty: false,
        sourceMtimeMs: 1,
        sourceHash: 'b'.repeat(64),
      },
    ]
    snapshot.activeDocumentId = 'missing'
    await repositories.metadata.save(persistedFromSnapshot(snapshot))
    const loader: DocumentLoader = {
      loadPath: vi.fn(async (path) => {
        if (path.endsWith('missing.txt')) throw new Error('missing')
        return {
          name: 'available.txt',
          sourcePath: '/tmp/available.txt',
          format: 'text' as const,
          content: 'available',
          sourceMtimeMs: 2,
          sourceHash: 'c'.repeat(64),
          dirty: false as const,
        }
      }),
    }

    const store = new AppStore(repositories)
    const issues = await store.initialize(loader)

    expect(loader.loadPath).toHaveBeenCalledTimes(2)
    expect(store.getActiveDocument()).toMatchObject({ id: 'available', content: 'available' })
    expect(store.getSnapshot().scrollPosition).toBe(0)
    expect(issues.some((issue) => issue.includes('missing.txt'))).toBe(true)
  })

  it('requires explicit discard before removing a dirty document', async () => {
    const repositories = await harness()
    const store = new AppStore(repositories)
    await store.initialize(unusedLoader)
    const document = await store.createDocument('draft.md', 'draft', 'markdown')
    expect(await store.removeDocument(document.id, false)).toEqual({
      ok: false,
      reason: 'dirty',
    })
    expect(await store.removeDocument(document.id, true)).toEqual({ ok: true })
  })

  it('does not replace a valid recovery draft when a workspace-limit update is rejected', async () => {
    const repositories = await harness()
    const store = new AppStore({
      ...repositories,
      workspaceFactory: () => createWorkspace({ maxDocumentChars: 10, maxTotalChars: 10 }),
    })
    await store.initialize(unusedLoader)
    const first = await store.createDocument('first.md', '123456', 'markdown')
    await store.createDocument('second.md', '7890', 'markdown')

    expect(
      await store.updateDocument({
        id: first.id,
        expectedRevision: first.revision,
        content: '1234567',
      }),
    ).toEqual({ ok: false, reason: 'too-large' })
    expect(await repositories.drafts.read(first.id)).toBe('123456')
  })

  it('retries metadata persistence after a transient write failure', async () => {
    const repositories = await harness()
    const store = new AppStore(repositories)
    await store.initialize(unusedLoader)
    const realSave = repositories.metadata.save.bind(repositories.metadata)
    const save = vi.spyOn(repositories.metadata, 'save')
    save.mockRejectedValueOnce(new Error('temporary disk failure')).mockImplementation(realSave)

    store.patchState({ opacity: 0.7 })
    await expect(store.flush()).rejects.toThrow('temporary disk failure')
    store.patchState({ opacity: 0.8 })
    await expect(store.flush()).resolves.toBeUndefined()
    expect(save).toHaveBeenCalledTimes(2)
  })
})
