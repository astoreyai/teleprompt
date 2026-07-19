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
import { persistedFromSnapshot } from '../persistence/schema.js'

export type DocumentLoader = {
  loadPath(path: string, signal?: AbortSignal): Promise<ImportedDocument>
}

export class AppStore {
  private workspace: DocumentWorkspace
  private persistTimer: ReturnType<typeof setTimeout> | null = null
  private persistQueue: Promise<void> = Promise.resolve()
  private commandQueue: Promise<unknown> = Promise.resolve()
  private readonly persistDelayMs: number
  private initialized = false
  private issues: string[] = []

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

  async addImportedDocument(document: ImportedDocument, select = true): Promise<DocumentMeta> {
    return this.enqueue(async () => {
      const meta = this.workspace.addDocument(document)
      if (select) this.workspace.selectDocument(meta.id)
      this.pushRecent(document.sourcePath)
      await this.persistCritical()
      return meta
    })
  }

  async createDocument(
    name: string,
    content: string,
    format: Extract<DocumentFormat, 'text' | 'markdown' | 'fountain'>,
  ): Promise<DocumentMeta> {
    return this.enqueue(async () => {
      const meta = this.workspace.addDocument({
        name,
        sourcePath: null,
        format,
        content,
        sourceMtimeMs: null,
        sourceHash: null,
        dirty: true,
      })
      try {
        await this.options.drafts.write(meta.id, content)
      } catch (error) {
        this.workspace.removeDocument(meta.id)
        throw error
      }
      this.workspace.selectDocument(meta.id)
      await this.persistCritical()
      return meta
    })
  }

  async updateDocument(input: {
    id: DocumentId
    expectedRevision: number
    content: string
  }): Promise<DocumentUpdateResult> {
    return this.enqueue(async () => {
      const current = this.workspace.getDocument(input.id)
      if (!current) return { ok: false, reason: 'not-found' } as const
      if (current.revision !== input.expectedRevision) {
        return {
          ok: false,
          reason: 'conflict',
          currentRevision: current.revision,
        } as const
      }
      const validation = this.workspace.validateDocumentUpdate(input)
      if (!validation.ok) return validation
      await this.options.drafts.write(input.id, input.content)
      const result = this.workspace.updateDocument(input)
      if (!result.ok) throw new Error('document update changed after validation')
      if (result.ok) await this.persistCritical()
      return result
    })
  }

  async removeDocument(
    id: DocumentId,
    discardDirty: boolean,
  ): Promise<{ ok: true } | { ok: false; reason: 'not-found' | 'dirty' }> {
    return this.enqueue(async () => {
      const document = this.workspace.getDocument(id)
      if (!document) return { ok: false, reason: 'not-found' } as const
      if (document.dirty && !discardDirty) return { ok: false, reason: 'dirty' } as const
      this.workspace.removeDocument(id)
      await this.persistCritical()
      await this.deleteDraftBestEffort(id)
      return { ok: true } as const
    })
  }

  selectDocument(id: DocumentId): boolean {
    const selected = this.workspace.selectDocument(id)
    if (selected) this.schedulePersist()
    return selected
  }

  patchState(
    patch: Partial<Omit<AppSnapshot, 'schemaVersion' | 'documents' | 'activeDocumentId'>>,
  ): AppSnapshot {
    const snapshot = this.workspace.patchState(patch)
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
      const saved = this.workspace.markSaved(input)
      if (!saved) return false
      this.pushRecent(input.sourcePath)
      await this.persistCritical()
      await this.deleteDraftBestEffort(input.id)
      return true
    })
  }

  async saveDocument(
    id: DocumentId,
    service: DocumentSaveService,
    requestedTargetPath?: string,
  ): Promise<SaveDocumentResult | { ok: false; reason: 'not-found' }> {
    return this.enqueue(async () => {
      const document = this.workspace.getDocument(id)
      if (!document) return { ok: false, reason: 'not-found' } as const
      const result = await service.save(document, requestedTargetPath)
      if (!result.ok) return result
      this.workspace.markSaved({
        id,
        sourcePath: result.targetPath,
        format: result.format,
        sourceMtimeMs: result.sourceMtimeMs,
        sourceHash: result.sourceHash,
      })
      this.pushRecent(result.targetPath)
      await this.persistCritical()
      await this.deleteDraftBestEffort(id)
      return result
    })
  }

  async reloadDocument(
    id: DocumentId,
    discardDirty: boolean,
    loader: DocumentLoader,
  ): Promise<{ ok: true; document: DocumentMeta } | { ok: false; reason: string }> {
    return this.enqueue(async () => {
      const document = this.workspace.getDocument(id)
      if (!document) return { ok: false, reason: 'not-found' } as const
      if (document.dirty && !discardDirty) return { ok: false, reason: 'dirty' } as const
      if (!document.sourcePath) return { ok: false, reason: 'no-source' } as const
      try {
        const imported = await loader.loadPath(document.sourcePath)
        const meta = this.workspace.replaceDocument(id, imported)
        if (!meta) return { ok: false, reason: 'not-found' } as const
        await this.persistCritical()
        await this.deleteDraftBestEffort(id)
        return { ok: true, document: meta } as const
      } catch (error) {
        return {
          ok: false,
          reason: error instanceof Error ? error.message : 'reload-failed',
        } as const
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
    this.schedulePersist()
    return snapshot
  }

  async flush(): Promise<void> {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer)
      this.persistTimer = null
    }
    if (!this.initialized) return
    await this.persistNow()
  }

  private pushRecent(path: string): void {
    const snapshot = this.workspace.getSnapshot()
    const recentFiles = [path, ...snapshot.recentFiles.filter((item) => item !== path)].slice(0, 10)
    this.workspace.patchState({ recentFiles })
  }

  private createWorkspace(): DocumentWorkspace {
    return this.options.workspaceFactory?.() ?? createWorkspace()
  }

  private schedulePersist(): void {
    if (!this.initialized || this.persistTimer) return
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null
      void this.persistNow().catch((error) => {
        this.issues.push(
          `state persistence failed: ${error instanceof Error ? error.message : 'unknown error'}`,
        )
      })
    }, this.persistDelayMs)
    this.persistTimer.unref?.()
  }

  private async persistNow(): Promise<void> {
    const value = persistedFromSnapshot(this.workspace.getSnapshot())
    this.persistQueue = this.persistQueue
      .catch(() => undefined)
      .then(() => this.options.metadata.save(value))
    await this.persistQueue
  }

  private async persistCritical(): Promise<void> {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer)
      this.persistTimer = null
    }
    await this.persistNow()
  }

  private async deleteDraftBestEffort(id: DocumentId): Promise<void> {
    try {
      await this.options.drafts.delete(id)
    } catch (error) {
      this.issues.push(
        `draft cleanup failed: ${error instanceof Error ? error.message : 'unknown error'}`,
      )
    }
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
