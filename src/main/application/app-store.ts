import type {
  AppSnapshot,
  DocumentFormat,
  DocumentId,
  DocumentMeta,
  DocumentRecord,
  DocumentUpdateResult,
} from '../../shared/contracts.js'
import { createDefaultSnapshot } from '../../shared/defaults.js'
import { createWorkspace, type DocumentWorkspace } from '../domain/workspace.js'
import type { ImportedDocument } from '../documents/import-service.js'
import type { DocumentSaveService, SaveDocumentResult } from '../documents/save-service.js'
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
  private issues: string[] = []
  private readonly issueListeners = new Set<() => void>()

  constructor(
    private readonly options: {
      metadata: MetadataRepository
      drafts: DraftRepository
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

    for (const reference of loaded.parsed.value.documentRefs) {
      try {
        if (reference.dirty) {
          const content = await this.options.drafts.read(reference.id)
          if (content === null) throw new Error('recovery draft is missing')
          this.workspace.addDocument({
            ...reference,
            content,
            dirty: true,
          })
        } else {
          if (!reference.sourcePath) throw new Error('source path is missing')
          const imported = await loader.loadPath(reference.sourcePath)
          this.workspace.addDocument({
            ...imported,
            id: reference.id,
            revision: reference.revision,
            dirty: false,
          })
        }
      } catch (error) {
        this.unresolved.set(reference.id, reference)
        this.issues.push(
          `${reference.name}: ${error instanceof Error ? error.message : 'unable to restore document'}`,
        )
      }
    }

    const requestedActive = loaded.parsed.value.activeDocumentId
    if (
      !requestedActive ||
      !this.workspace.restoreActiveDocument(
        requestedActive,
        loaded.parsed.value.state.scrollPosition,
      )
    ) {
      this.workspace.patchState({ scrollPosition: 0, playing: false })
    }
    this.initialized = true
    if (loaded.parsed.migrated || loaded.parsed.quarantined || this.issues.length > 0) {
      await this.persistCritical()
    }
    return [...this.issues]
  }

  getSnapshot(): AppSnapshot {
    return this.workspace.getSnapshot()
  }

  getDocument(id: DocumentId): DocumentRecord | null {
    return this.workspace.getDocument(id)
  }

  getActiveDocument(): DocumentRecord | null {
    return this.workspace.getActiveDocument()
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

  async createDocument(
    name: string,
    content: string,
    format: Extract<DocumentFormat, 'text' | 'markdown' | 'fountain'>,
  ): Promise<DocumentMeta> {
    return this.enqueue(async () => {
      try {
        return await this.transact(async (candidate) => {
          const meta = candidate.addDocument({
            name, sourcePath: null, format, content,
            sourceMtimeMs: null, sourceHash: null, dirty: true,
          })
          candidate.selectDocument(meta.id)
          await this.options.drafts.write(meta.id, content)
          return meta
        })
      } catch (error) {
        // A rejected create never publishes an ID, so reclaim its orphan only
        // after validating that neither metadata copy references it.
        await this.cleanupDrafts()
        throw error
      }
    })
  }

  async updateDocument(input: {
    id: DocumentId
    expectedRevision: number
    content: string
  }): Promise<DocumentUpdateResult> {
    return this.enqueue(async () => {
      const validation = this.workspace.validateDocumentUpdate(input)
      if (!validation.ok) return validation
      let previousDraft: string | null
      try {
        previousDraft = await this.options.drafts.read(input.id)
      } catch (error) {
        return { ok: false, reason: 'storage-failed', error: this.recordStorageFailure(error) } as const
      }
      let draftWritten = false
      try {
        return await this.transact(async (candidate) => {
          const result = candidate.updateDocument(input)
          if (!result.ok) throw new Error('document update changed after validation')
          await this.options.drafts.write(input.id, input.content)
          draftWritten = true
          return result
        })
      } catch (error) {
        if (draftWritten) {
          try {
            if (previousDraft === null) await this.options.drafts.delete(input.id)
            else await this.options.drafts.write(input.id, previousDraft)
          } catch (rollbackError) {
            this.recordStorageFailure(rollbackError)
            return { ok: false, reason: 'storage-failed', error: `${this.errorMessage(error)}; recovery draft rollback failed: ${this.errorMessage(rollbackError)}` } as const
          }
        }
        return { ok: false, reason: 'storage-failed', error: this.errorMessage(error) } as const
      }
    })
  }

  async removeDocument(
    id: DocumentId,
    discardDirty: boolean,
  ): Promise<{ ok: true } | { ok: false; reason: 'not-found' | 'dirty' }> {
    return this.enqueue(async () => {
      const document = this.workspace.getDocument(id) ?? this.unresolved.get(id)
      if (!document) return { ok: false, reason: 'not-found' } as const
      if (document.dirty && !discardDirty) return { ok: false, reason: 'dirty' } as const
      return this.transact((candidate) => {
        candidate.removeDocument(id)
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

  async markSaved(input: {
    id: DocumentId
    sourcePath: string
    format: DocumentFormat
    sourceMtimeMs: number
    sourceHash: string
  }): Promise<boolean> {
    return this.enqueue(async () => {
      if (!this.workspace.getDocument(input.id)) return false
      return this.transact((candidate) => {
        candidate.markSaved(input)
        this.pushRecent(input.sourcePath, candidate)
        return true
      })
    })
  }

  async saveDocument(
    id: DocumentId,
    service: DocumentSaveService,
    requestedTargetPath?: string,
  ): Promise<SaveDocumentResult | { ok: false; reason: 'not-found' } | {
    ok: false; reason: 'storage-failed'; sourceSaved: true; currentRevision: number; error: string; targetPath: string
  }> {
    return this.enqueue(async () => {
      const document = this.workspace.getDocument(id)
      if (!document) return { ok: false, reason: 'not-found' } as const
      // Retain recovery bytes before the irreversible source write starts.
      try {
        await this.options.drafts.write(id, document.content)
      } catch (error) {
        this.recordStorageFailure(error)
        return { ok: false, reason: 'write-failed', error: this.errorMessage(error) } as const
      }
      const result = await service.save(document, requestedTargetPath)
      if (!result.ok) return result
      try {
        await this.transact((candidate) => {
          candidate.markSaved({
            id, sourcePath: result.targetPath, format: result.format,
            sourceMtimeMs: result.sourceMtimeMs, sourceHash: result.sourceHash,
          })
          this.pushRecent(result.targetPath, candidate)
        })
        return result
      } catch (error) {
        // The source already changed. Publish its current identity so retry can
        // verify it, while keeping the document dirty and its recovery draft.
        this.workspace.markSaved({
          id, sourcePath: result.targetPath, format: result.format,
          sourceMtimeMs: result.sourceMtimeMs, sourceHash: result.sourceHash,
        })
        this.workspace.retainDraft(id)
        this.pushRecent(result.targetPath)
        this.schedulePersist()
        return {
          ok: false, reason: 'storage-failed', sourceSaved: true,
          currentRevision: document.revision, targetPath: result.targetPath,
          error: this.errorMessage(error),
        } as const
      }
    })
  }

  async reloadDocument(
    id: DocumentId,
    discardDirty: boolean,
    loader: DocumentLoader,
  ): Promise<{ ok: true; document: DocumentMeta } | { ok: false; reason: string }> {
    return this.enqueue(async () => {
      const document = this.workspace.getDocument(id)
      const unresolved = this.unresolved.get(id)
      if (!document && !unresolved) return { ok: false, reason: 'not-found' } as const
      if (document?.dirty && !discardDirty) return { ok: false, reason: 'dirty' } as const
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
      editMode: _edit,
      voicePacing: _voice,
      playbackSessionId: _session,
      overlayVisible: _overlayVisible,
      voiceStatus: _voiceStatus,
      voiceError: _voiceError,
      ...settings
    } = defaults
    const snapshot = this.workspace.restoreSettings(settings)
    this.candidate?.restoreSettings(settings)
    this.schedulePersist()
    return snapshot
  }

  async flush(): Promise<void> {
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
    value.documentRefs.push(...[...this.unresolved.values()].filter((reference) => reference.id !== resolvedId))
    if (value.documentRefs.length > 100) throw new Error('document limit reached')
    this.persistQueue = this.persistQueue
      .catch(() => undefined)
      .then(() => this.options.metadata.save(value))
    await this.persistQueue
    await this.cleanupDrafts()
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

  private async cleanupDrafts(): Promise<void> {
    try {
      const referenced = await this.options.metadata.referencedDraftIds()
      // An unresolved draft is retained even if metadata currently cannot name it.
      for (const reference of this.unresolved.values()) if (reference.dirty) referenced.add(reference.id)
      await this.options.drafts.cleanup(referenced)
    } catch (error) {
      this.recordStorageFailure(error)
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
