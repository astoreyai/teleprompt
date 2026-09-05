import type {
  AppSnapshot,
  DocumentFormat,
  DocumentId,
  DocumentMeta,
  DocumentRecord,
} from '../../shared/contracts.js'
import { createDefaultSnapshot } from '../../shared/defaults.js'
import { createWorkspace, type DocumentWorkspace } from '../domain/workspace.js'
import type { ImportedDocument } from '../documents/import-service.js'
import { DraftRepository, MetadataRepository } from '../persistence/repositories.js'
import { persistedFromSnapshot, type PersistedDocumentRef } from '../persistence/schema.js'

export type DocumentLoader = {
  loadPath(path: string, signal?: AbortSignal): Promise<ImportedDocument>
}

export class AppStore {
  private workspace: DocumentWorkspace
  private candidate: DocumentWorkspace | null = null
  private readonly unresolved = new Map<DocumentId, PersistedDocumentRef>()
  private persistTimer: ReturnType<typeof setTimeout> | null = null
  private persistQueue: Promise<void> = Promise.resolve()
  private commandQueue: Promise<unknown> = Promise.resolve()
  private readonly persistDelayMs: number
  private initialized = false
  private restoring = false
  private restoration: Promise<void> = Promise.resolve()
  private restorationCancelled = false
  private restoredSelection: { id: DocumentId; scrollPosition: number } | null = null
  private readonly restoredOrder = new Map<string, number>()
  private issues: string[] = []
  private readonly issueListeners = new Set<() => void>()

  constructor(
    private readonly options: {
      metadata: MetadataRepository
      drafts: DraftRepository
      restoreInBackground?: boolean
      persistDelayMs?: number
      workspaceFactory?: () => DocumentWorkspace
    },
  ) {
    this.persistDelayMs = Math.max(0, options.persistDelayMs ?? 1000)
    this.workspace = this.createWorkspace()
  }

  async initialize(loader: DocumentLoader): Promise<string[]> {
    if (this.initialized) return [...this.issues]
    const loaded = await this.options.metadata.load()
    this.issues = [...loaded.parsed.issues]
    this.workspace = this.createWorkspace()
    this.workspace.restoreSettings(loaded.parsed.value.state)

    const references = loaded.parsed.value.documentRefs
    for (const [index, reference] of references.entries()) {
      this.unresolved.set(reference.id, reference)
      this.restoredOrder.set(reference.id, index)
    }
    const requestedActive = loaded.parsed.value.activeDocumentId
    this.restoredSelection = requestedActive
      ? { id: requestedActive, scrollPosition: loaded.parsed.value.state.scrollPosition }
      : null
    const first = references.find(reference => reference.id === requestedActive) ?? references[0]
    const restore = async (reference: PersistedDocumentRef, background: boolean) => {
      if (this.restorationCancelled) return
      try {
        const content = reference.dirty
          ? await this.options.drafts.read(reference.id)
          : reference.sourcePath ? (await loader.loadPath(reference.sourcePath)) : null
        if (content === null) throw new Error(reference.dirty ? 'recovery draft is missing' : 'source path is missing')
        if (this.restorationCancelled) return
        const input = typeof content === 'string' ? { ...reference, content } : { ...content, id: reference.id, revision: reference.revision }
        if (background) {
          await this.enqueue(async () => {
            if (this.restorationCancelled || this.unresolved.get(reference.id) !== reference) return
            await this.transact(candidate => candidate.addDocument(input), reference.id)
          })
        } else {
          this.workspace.addDocument(input)
          this.unresolved.delete(reference.id)
        }
      } catch (error) {
        if (!this.restorationCancelled) {
          this.issues = [...this.issues, `${reference.name}: ${this.errorMessage(error)}`].slice(-50)
        }
      }
      if (background) this.notifyStorageStatus()
    }
    if (first) await restore(first, false)
    if (!requestedActive || !this.workspace.restoreActiveDocument(requestedActive, loaded.parsed.value.state.scrollPosition)) {
      this.workspace.patchState({ scrollPosition: 0, playing: false })
    }
    this.initialized = true
    const remaining = references.filter(reference => reference !== first)
    this.restoring = remaining.length > 0
    this.restoration = (async () => {
      for (const reference of remaining) {
        if (this.restorationCancelled) break
        await restore(reference, !!this.options.restoreInBackground)
      }
      this.restoring = false
      if (loaded.parsed.migrated || loaded.parsed.quarantined || this.issues.length > 0) await this.persistCritical()
      this.notifyStorageStatus()
    })().catch(error => {
      this.restoring = false
      this.recordStorageFailure(error)
    })
    if (!this.options.restoreInBackground) await this.restoration
    return [...this.issues]
  }

  getSnapshot(): AppSnapshot {
    const snapshot = this.workspace.getSnapshot()
    snapshot.documents.sort((a, b) => (this.restoredOrder.get(a.id) ?? Infinity) - (this.restoredOrder.get(b.id) ?? Infinity))
    return snapshot
  }

  getDocument(id: DocumentId): DocumentRecord | null {
    return this.workspace.getDocument(id)
  }

  getActiveDocument(): DocumentRecord | null {
    return this.workspace.getActiveDocument()
  }

  getStorageStatus(): { lastPersistedAt: number | null; restoring: boolean } {
    return { lastPersistedAt: this.options.metadata.lastPersistedAt, restoring: this.restoring }
  }

  async waitForRestoration(): Promise<void> { await this.restoration }

  cancelRestoration(): void { this.restorationCancelled = true }

  private notifyStorageStatus(): void {
    for (const listener of this.issueListeners) {
      try { listener() } catch { /* Notifications do not change persistence outcomes. */ }
    }
  }

  getStorePath(): string {
    return this.options.metadata.path
  }

  getIssues(): string[] {
    return [...this.issues]
  }

  subscribeIssues(listener: () => void): () => void {
    this.issueListeners.add(listener)
    return () => { this.issueListeners.delete(listener) }
  }

  getUnresolvedDocuments(): PersistedDocumentRef[] {
    return [...this.unresolved.values()].map((reference) => ({ ...reference }))
  }

  async addImportedDocument(document: ImportedDocument, select = true): Promise<DocumentMeta> {
    return this.enqueue(() => this.transact((candidate) => {
      const meta = candidate.addDocument(document)
      if (select) candidate.selectDocument(meta.id)
      this.pushRecent(document.sourcePath, candidate)
      return meta
    }))
  }

  async removeDocument(
    id: DocumentId,
  ): Promise<{ ok: true } | { ok: false; reason: 'not-found' | 'dirty' }> {
    return this.enqueue(async () => {
      const document = this.workspace.getDocument(id) ?? this.unresolved.get(id)
      if (!document) return { ok: false, reason: 'not-found' } as const
      const snapshot = this.getSnapshot()
      const visibleIndex = snapshot.documents.findIndex(document => document.id === id)
      const remaining = snapshot.documents.filter(document => document.id !== id)
      const successor = snapshot.activeDocumentId === id
        ? remaining[Math.min(visibleIndex, remaining.length - 1)]?.id
        : undefined
      return this.transact((candidate) => {
        candidate.removeDocument(id)
        if (successor) candidate.selectDocument(successor)
        return { ok: true } as const
      }, id)
    })
  }

  selectDocument(id: DocumentId): boolean {
    const selected = this.workspace.selectDocument(id)
    if (selected) {
      this.candidate?.selectDocument(id)
      this.schedulePersist()
    }
    return selected
  }

  patchState(
    patch: Partial<Omit<AppSnapshot, 'schemaVersion' | 'documents' | 'activeDocumentId'>>,
  ): AppSnapshot {
    const snapshot = this.workspace.patchState(patch)
    this.candidate?.patchState(patch)
    this.schedulePersist()
    return snapshot
  }

  async reloadDocument(
    id: DocumentId,
    loader: DocumentLoader,
  ): Promise<{ ok: true; document: DocumentMeta } | { ok: false; reason: string }> {
    return this.enqueue(async () => {
      const document = this.workspace.getDocument(id)
      const unresolved = this.unresolved.get(id)
      if (!document && !unresolved) return { ok: false, reason: 'not-found' } as const
      try {
        return await this.transact(async (candidate) => {
          if (unresolved) {
            const recovered = unresolved.dirty
              ? { ...unresolved, content: await this.options.drafts.read(id) }
              : unresolved.sourcePath ? await loader.loadPath(unresolved.sourcePath) : null
            if (!recovered || recovered.content === null) throw new Error('recovery content is unavailable')
            const meta = candidate.addDocument({ ...recovered, content: recovered.content, id, revision: unresolved.revision })
            return { ok: true, document: meta } as const
          }
          if (!document?.sourcePath) throw new Error('no-source')
          const imported = await loader.loadPath(document.sourcePath)
          const meta = candidate.replaceDocument(id, imported)
          if (!meta) throw new Error('not-found')
          return { ok: true, document: meta } as const
        }, unresolved ? id : undefined)
      } catch (error) {
        return { ok: false, reason: this.errorMessage(error) } as const
      }
    })
  }

  resetPreferences(): AppSnapshot {
    const defaults = createDefaultSnapshot()
    const {
      schemaVersion: _schema,
      documents: _documents,
      activeDocumentId: _active,
      playing: _playing,
      playbackSessionId: _session,
      overlayVisible: _overlayVisible,
      ...settings
    } = defaults
    const snapshot = this.workspace.restoreSettings(settings)
    this.candidate?.restoreSettings(settings)
    this.schedulePersist()
    return snapshot
  }

  async flush(): Promise<void> {
    await this.restoration
    if (this.persistTimer) {
      clearTimeout(this.persistTimer)
      this.persistTimer = null
    }
    if (!this.initialized) return
    await this.enqueue(async () => {
      this.clearPersistTimer()
      await this.persistNow()
    })
  }

  private pushRecent(path: string, workspace = this.workspace): void {
    const snapshot = workspace.getSnapshot()
    const recentFiles = [path, ...snapshot.recentFiles.filter((item) => item !== path)].slice(0, 10)
    workspace.patchState({ recentFiles })
  }

  private createWorkspace(): DocumentWorkspace {
    return this.options.workspaceFactory?.() ?? createWorkspace()
  }

  private schedulePersist(): void {
    if (!this.initialized || this.persistTimer) return
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null
      void this.enqueue(() => this.persistNow()).catch((error) => {
        this.recordStorageFailure(error)
      })
    }, this.persistDelayMs)
    this.persistTimer.unref?.()
  }

  private async persistNow(workspace = this.workspace, resolvedId?: DocumentId): Promise<void> {
    const value = persistedFromSnapshot(workspace.getSnapshot())
    // Closing before the first read finishes must not erase the user's saved
    // selection/checkpoint while all its document references remain unresolved.
    if (this.restorationCancelled && !value.activeDocumentId && this.restoredSelection &&
      this.unresolved.has(this.restoredSelection.id) && resolvedId !== this.restoredSelection.id) {
      value.activeDocumentId = this.restoredSelection.id
      value.state.scrollPosition = this.restoredSelection.scrollPosition
    }
    value.documentRefs.push(...[...this.unresolved.values()].filter((reference) => reference.id !== resolvedId))
    value.documentRefs.sort((a, b) => (this.restoredOrder.get(a.id) ?? Infinity) - (this.restoredOrder.get(b.id) ?? Infinity))
    if (value.documentRefs.length > 100) throw new Error('document limit reached')
    this.persistQueue = this.persistQueue
      .catch(() => undefined)
      .then(() => this.options.metadata.save(value))
    await this.persistQueue
    this.notifyStorageStatus()
  }

  private clearPersistTimer(): void {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer)
      this.persistTimer = null
    }
  }

  private async persistCritical(workspace = this.workspace, resolvedId?: DocumentId): Promise<void> {
    this.clearPersistTimer()
    await this.persistNow(workspace, resolvedId)
  }

  private async transact<T>(operation: (candidate: DocumentWorkspace) => T | Promise<T>, resolvedId?: DocumentId): Promise<T> {
    const candidate = this.workspace.fork()
    this.candidate = candidate
    try {
      const result = await operation(candidate)
      await this.persistCritical(candidate, resolvedId)
      this.workspace = candidate
      if (resolvedId) this.unresolved.delete(resolvedId)
      return result
    } catch (error) {
      this.recordStorageFailure(error)
      throw error
    } finally {
      this.candidate = null
    }
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : 'storage operation failed'
  }

  private recordStorageFailure(error: unknown): string {
    const message = this.errorMessage(error)
    const issue = `state persistence failed: ${message}`
    this.issues = [...this.issues.filter((existing) => existing !== issue), issue].slice(-50)
    for (const listener of this.issueListeners) {
      try { listener() } catch { /* Diagnostic delivery cannot change storage outcomes. */ }
    }
    return message
  }

  private enqueue<T>(command: () => Promise<T>): Promise<T> {
    const next = this.commandQueue.then(command, command)
    this.commandQueue = next.then(
      () => undefined,
      () => undefined,
    )
    return next
  }
}
